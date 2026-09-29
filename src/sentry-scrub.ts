/* eslint-disable @typescript-eslint/no-explicit-any -- the Sentry event shape shifts between SDK versions; loose on purpose, see scrubEvent */
/**
 * Redaction for anything sent to error reporting, transactions and spans.
 *
 * Callers can send customer credentials (an `X-API-Key` project key, bearer tokens, presigned
 * URLs) and upstream errors quote request text back verbatim, so nothing reaches Sentry unscrubbed.
 * The file is vendored, byte-identical, in the upload, build-processing and cdn services (there is
 * no shared package across these repos).
 *
 * Guarantees (log-standardization B2 / fail-closed):
 *  - every scrubbed string is capped at MAX_SCRUB_CHARS BEFORE any rule runs, and every rule is
 *    linear time, so a hostile 200k-char URL or header costs microseconds;
 *  - every hook is wrapped: if scrubbing throws, the hook returns a minimal safe result and never
 *    the unscrubbed input (the SDK reports a throwing hook's own exception WITHOUT running beforeSend).
 */

import { scrubString as sharedScrub } from "./lib/scry-log/index.js";

/** Header names whose values must never be sent, compared case-insensitively. */
const SENSITIVE_HEADERS = [
  "x-api-key",
  "authorization",
  "cookie",
  "x-cleanup-token",
  "cf-connecting-ip",
  "x-forwarded-for",
  "x-real-ip",
];

/** Hard cap applied to every string BEFORE scrubbing (bounds the work of every rule). */
export const MAX_SCRUB_CHARS = 4096;
/** Nested objects/arrays in breadcrumb data and `extra` are scrubbed down to this depth. */
const MAX_DEPTH = 5;
const MAX_KEYS = 100;
const MAX_KEY_CHARS = 256;

function cap(value: string): string {
  return value.length > MAX_SCRUB_CHARS
    ? value.slice(0, MAX_SCRUB_CHARS)
    : value;
}

/**
 * Presigned URLs. Keep the object path (it identifies the failing operation) and drop the query
 * string, which carries X-Amz-Signature: a time-limited write credential for the bucket.
 * Linear time: one pass per whitespace-delimited token, with monotone indexOf scans (the former
 * regex `(https?://[^\s?]+)\?[^\s]*` rescanned to the end from every `http://`, quadratic).
 */
function redactUrlQueries(value: string): string {
  return value.replace(/\S+/g, (token) => {
    let from = 0;
    for (;;) {
      const at = token.indexOf("http", from);
      if (at < 0) return token;
      const prefixLen = token.startsWith("https://", at)
        ? 8
        : token.startsWith("http://", at)
          ? 7
          : 0;
      if (prefixLen === 0) {
        from = at + 4;
        continue;
      }
      const q = token.indexOf("?", at + prefixLen);
      if (q < 0) return token;
      if (q > at + prefixLen) return `${token.slice(0, q)}?<redacted>`;
      from = q + 1; // `http://?`: no URL body, keep looking after this `?`
    }
  });
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/scry_proj_[A-Za-z0-9_-]+/g, "scry_proj_<redacted>"],
  [/(X-Amz-Signature=)[^&\s]+/gi, "$1<redacted>"],
  [/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1<redacted>"],
];

export function scrubString(value: string): string {
  // Local rules first (they keep the object path of a presigned URL), then the shared scry-log
  // scrubber (emails, JWT-like strings, provider keys, cookies, ?query=) so no Sentry event carries
  // what the log lines cannot (log-standardization guarantee-1).
  const capped = redactUrlQueries(cap(value));
  return sharedScrub(
    SECRET_PATTERNS.reduce(
      (acc, [pattern, replacement]) => acc.replace(pattern, replacement),
      capped,
    ),
  );
}

/** Normalise an attribute/key name: lowercase and drop `_ - .` so `accessToken`, `access_token`, `access.token` agree. */
function normalizeName(name: string): string {
  return name
    .slice(0, MAX_KEY_CHARS)
    .toLowerCase()
    .replace(/[_\-.]/g, "");
}

/** Substrings (of a normalised name) that mark a credential-bearing key. */
const SENSITIVE_NAME_PARTS = [
  "auth",
  "cookie",
  "apikey",
  "token",
  "secret",
  "password",
  "passwd",
  "pwd",
  "credential",
  "signature",
  "jwt",
  "bearer",
  "privatekey",
  "sessionid",
  "session",
  "csrf",
  "xsrf",
];

function isSensitiveName(name: string): boolean {
  const n = normalizeName(name);
  return SENSITIVE_NAME_PARTS.some((part) => n.includes(part));
}

/**
 * Recursively scrub a value (string, array, plain object) down to MAX_DEPTH. Returns a NEW value,
 * never the input, so a frozen or shared object is not mutated. Credential-named keys are dropped.
 */
function scrubDeep(value: unknown, depth: number): unknown {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value === "number" || typeof value === "boolean")
    return value;
  if (typeof value !== "object") return undefined;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value))
    return value.slice(0, MAX_KEYS).map((item) => scrubDeep(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as object).slice(0, MAX_KEYS)) {
    if (isSensitiveName(key)) continue;
    const scrubbed = scrubDeep(
      (value as Record<string, unknown>)[key],
      depth + 1,
    );
    if (scrubbed !== undefined)
      out[cap(key).slice(0, MAX_KEY_CHARS)] = scrubbed;
  }
  return out;
}

/** Scrub a bag of arbitrary data (breadcrumb data, `extra`) in place, recursing to MAX_DEPTH. */
function scrubDataBag(bag: unknown): void {
  if (!bag || typeof bag !== "object") return;
  const record = bag as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (isSensitiveName(key)) {
      delete record[key];
      continue;
    }
    const scrubbed = scrubDeep(record[key], 1);
    if (scrubbed === undefined) delete record[key];
    else record[key] = scrubbed;
  }
}

/**
 * Scrub every string in a breadcrumb (message and data, nested to depth 5) before it is recorded.
 * Fails closed: returns `null` (drop the breadcrumb) if scrubbing throws.
 */
export function scrubBreadcrumb<
  T extends { message?: string; data?: Record<string, unknown> },
>(crumb: T): T | null {
  try {
    if (typeof crumb.message === "string")
      crumb.message = scrubString(crumb.message);
    scrubDataBag(crumb.data);
    return crumb;
  } catch {
    return null;
  }
}

/** A `request_id` tag safe to keep on the minimal failure event (shape-checked, never free text). */
function safeRequestId(event: any): string | undefined {
  try {
    const id = event?.tags?.request_id;
    return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id)
      ? id
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Strip credentials from a Sentry event before it leaves the Worker.
 *
 * Takes `any` on purpose. The SDK's event shape shifts between versions, and a
 * scrubber that fails to compile after a routine upgrade is a scrubber someone
 * deletes under time pressure. Loose typing here buys durability where it
 * matters more than precision does.
 *
 * Fails closed: if scrubbing throws, the event is replaced by
 * `{message:'scrub_failed', level:'error', tags:{request_id}}`.
 */
export function scrubEvent(event: any): any {
  try {
    return scrubEventUnsafe(event);
  } catch {
    const requestId = safeRequestId(event);
    return {
      message: "scrub_failed",
      level: "error",
      tags: requestId ? { request_id: requestId } : {},
    };
  }
}

function scrubEventUnsafe(event: any): any {
  const request = event.request as
    | {
        headers?: Record<string, string>;
        query_string?: unknown;
        data?: unknown;
      }
    | undefined;

  if (request?.headers) {
    for (const name of Object.keys(request.headers)) {
      if (SENSITIVE_HEADERS.includes(name.toLowerCase()))
        request.headers[name] = "<redacted>";
    }
  }

  // Bodies and query strings are never needed to diagnose a failure here, and
  // both can carry keys.
  if (request) {
    delete request.data;
    delete request.query_string;
    // A URL can carry a query (a presigned signature, a token); keep the path, which names the route.
    const r = request as { url?: unknown; cookies?: unknown };
    if (typeof r.url === "string") r.url = stripQuery(r.url);
    delete r.cookies;
  }

  if (typeof event.message === "string")
    event.message = scrubString(event.message);

  for (const entry of event.exception?.values ?? []) {
    if (typeof entry.value === "string") entry.value = scrubString(entry.value);
  }

  scrubDataBag(event.extra);
  for (const crumb of event.breadcrumbs ?? []) scrubBreadcrumb(crumb);

  return event;
}

// ---------------------------------------------------------------------------------------------
// Transactions and spans (log-standardization B1). Sentry runs `beforeSend` on errors only;
// transaction events go through `beforeSendTransaction` and span JSON through `beforeSendSpan`.
// Both carry the request (Authorization, X-Api-Key, cookies, client IP) and URL attributes with the
// query string (`url.query`, `url.full`, a signed preview token), so they get the same treatment.
// ---------------------------------------------------------------------------------------------

/** Request headers that may stay on a transaction (never a credential or an address). */
const SAFE_HEADERS = new Set([
  "content-type",
  "content-length",
  "accept",
  "user-agent",
  "host",
]);

/** Span/trace attribute names (normalised) that hold a query string, a full URL, a cookie or a client address. */
const DROP_ATTRIBUTES = new Set(
  [
    "url.query",
    "url.fragment",
    "http.query",
    "http.fragment",
    "http.request.body",
    "client.address",
    "client.ip",
    "http.client_ip",
    "net.peer.ip",
    "net.sock.peer.addr",
    "network.peer.address",
    "user.ip_address",
    "cf-connecting-ip",
    "x-forwarded-for",
    "x-real-ip",
  ].map(normalizeName),
);

/** Attribute names holding a URL: keep the path, never the query or fragment. */
const URL_ATTRIBUTES = new Set([
  "url.full",
  "http.url",
  "url",
  "request.url",
  "http.target",
  "url.path",
]);

function stripQuery(value: string): string {
  return cap(value).split(/[?#]/)[0];
}

/** Scrub one attribute bag (span data, trace context data, tags) in place. */
function scrubAttributes(bag: unknown): void {
  if (!bag || typeof bag !== "object") return;
  const record = bag as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const lower = key.slice(0, MAX_KEY_CHARS).toLowerCase();
    // Names are normalised (lowercase, `_ - .` removed) so accessToken / xApiKey / api_key /
    // Authorization all hit the same rule.
    if (DROP_ATTRIBUTES.has(normalizeName(key)) || isSensitiveName(key)) {
      delete record[key];
      continue;
    }
    if (
      lower.startsWith("http.request.header.") ||
      lower.startsWith("http.response.header.")
    ) {
      const header = lower.slice(lower.lastIndexOf(".") + 1);
      if (!SAFE_HEADERS.has(header)) {
        delete record[key];
        continue;
      }
    }
    const value = record[key];
    if (typeof value === "string") {
      record[key] = scrubString(
        URL_ATTRIBUTES.has(lower) ? stripQuery(value) : value,
      );
    } else if (value && typeof value === "object") {
      const scrubbed = scrubDeep(value, 1);
      if (scrubbed === undefined) delete record[key];
      else record[key] = scrubbed;
    }
  }
}

/** Drop everything credential-shaped from a request block; keep method, path and safe headers. */
function scrubRequestBlock(request: unknown): void {
  if (!request || typeof request !== "object") return;
  const r = request as {
    headers?: Record<string, string>;
    url?: unknown;
    [k: string]: unknown;
  };
  if (r.headers && typeof r.headers === "object") {
    for (const name of Object.keys(r.headers)) {
      if (!SAFE_HEADERS.has(name.toLowerCase())) delete r.headers[name];
      else if (typeof r.headers[name] === "string")
        r.headers[name] = scrubString(r.headers[name]);
    }
  }
  delete r.data;
  delete r.query_string;
  delete r.cookies;
  if (typeof r.url === "string") r.url = scrubString(stripQuery(r.url));
}

/**
 * Strip credentials, query strings and client addresses from a Sentry transaction event before it
 * leaves the Worker. Takes `any` for the same reason as `scrubEvent`.
 * Fails closed: returns `null` (drop the transaction) if scrubbing throws.
 */
export function scrubTransaction(event: any): any {
  try {
    scrubRequestBlock(event.request);
    if (event.user && typeof event.user === "object") {
      delete event.user.ip_address;
      delete event.user.email;
      delete event.user.username;
    }
    if (typeof event.transaction === "string")
      event.transaction = scrubString(stripQuery(event.transaction));
    scrubAttributes(event.contexts?.trace?.data);
    for (const ctx of Object.values(event.contexts ?? {})) {
      if (ctx && typeof ctx === "object" && ctx !== event.contexts.trace)
        scrubAttributes(ctx);
    }
    scrubAttributes(event.tags);
    scrubDataBag(event.extra);
    if (Array.isArray(event.spans))
      event.spans = event.spans.map((span: unknown) =>
        scrubSpan(span as never),
      );
    if (Array.isArray(event.breadcrumbs)) {
      event.breadcrumbs = event.breadcrumbs
        .map((crumb: never) => scrubBreadcrumb(crumb))
        .filter(Boolean);
    }
    // Internal SDK bookkeeping (not serialised into the envelope) holds the raw request; drop it.
    if (
      event.sdkProcessingMetadata &&
      typeof event.sdkProcessingMetadata === "object"
    ) {
      delete event.sdkProcessingMetadata.normalizedRequest;
      delete event.sdkProcessingMetadata.request;
    }
    return event;
  } catch {
    return null;
  }
}

/**
 * `beforeSendSpan`: scrub one span's description and attributes. Returns the span.
 *
 * Fails closed. The SDK (10.x) treats a `null` from this hook as "not dropped" and sends the RAW
 * span, so a drop is expressed as a skeleton span that keeps only ids, timing and status and
 * carries no description or attributes.
 */
export function scrubSpan<T extends { description?: string; data?: any }>(
  span: T,
): T {
  try {
    if (typeof span.description === "string")
      span.description = scrubString(stripQuery(span.description));
    scrubAttributes(span.data);
    return span;
  } catch {
    return skeletonSpan(span);
  }
}

function skeletonSpan<T>(span: T): T {
  const out: Record<string, unknown> = {
    description: "scrub_failed",
    data: {},
  };
  for (const key of [
    "span_id",
    "trace_id",
    "parent_span_id",
    "start_timestamp",
    "timestamp",
    "status",
    "op",
  ]) {
    try {
      const v = (span as Record<string, unknown>)[key];
      if (
        typeof v === "number" ||
        (typeof v === "string" && v.length <= 64 && /^[A-Za-z0-9_.-]*$/.test(v))
      )
        out[key] = v;
    } catch {
      // a throwing getter: leave that field out
    }
  }
  return out as T;
}
