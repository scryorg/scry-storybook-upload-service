/**
 * Redaction for anything sent to error reporting.
 *
 * This service authenticates callers with an `X-API-Key` header carrying a
 * customer's project key, and Sentry attaches request context to events by
 * default. Without this, a customer credential reaches a third party every time
 * an authenticated request errors.
 *
 * The same class of leak was found in the CLI, where the whole parsed argv —
 * `--api-key` included — was attached to every failed deploy. Different route,
 * same outcome, so the fix is applied wherever error reporting is enabled.
 */

import { scrubString as sharedScrub } from './lib/scry-log/index.js';

/** Header names whose values must never be sent, compared case-insensitively. */
const SENSITIVE_HEADERS = ['x-api-key', 'authorization', 'cookie', 'x-cleanup-token'];

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Presigned URLs. Keep the object path — it identifies the failing operation —
  // and drop the query string, which carries X-Amz-Signature: a time-limited
  // write credential for the bucket.
  [/(https?:\/\/[^\s?]+)\?[^\s]*/g, '$1?<redacted>'],
  [/scry_proj_[A-Za-z0-9_\-]+/g, 'scry_proj_<redacted>'],
  [/(X-Amz-Signature=)[^&\s]+/gi, '$1<redacted>'],
  [/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1<redacted>'],
];

export function scrubString(value: string): string {
  // Local rules first (they keep the object path of a presigned URL), then the shared scry-log
  // scrubber (emails, JWT-like strings, provider keys, cookies, ?query=) so no Sentry event carries
  // what the log lines cannot (log-standardization guarantee-1).
  return sharedScrub(SECRET_PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), value));
}

/** Scrub every string in a breadcrumb (message and data) before it is recorded. */
export function scrubBreadcrumb<T extends { message?: string; data?: Record<string, unknown> }>(crumb: T): T {
  if (typeof crumb.message === 'string') crumb.message = scrubString(crumb.message);
  if (crumb.data) {
    for (const [key, value] of Object.entries(crumb.data)) {
      if (typeof value === 'string') crumb.data[key] = scrubString(value);
      else if (Array.isArray(value)) crumb.data[key] = value.map((v) => (typeof v === 'string' ? scrubString(v) : v));
    }
  }
  return crumb;
}

/**
 * Strip credentials from a Sentry event before it leaves the Worker.
 *
 * Takes `any` on purpose. The SDK's event shape shifts between versions, and a
 * scrubber that fails to compile after a routine upgrade is a scrubber someone
 * deletes under time pressure. Loose typing here buys durability where it
 * matters more than precision does.
 */
export function scrubEvent(event: any): any {
  const request = event.request as { headers?: Record<string, string>; query_string?: unknown; data?: unknown } | undefined;

  if (request?.headers) {
    for (const name of Object.keys(request.headers)) {
      if (SENSITIVE_HEADERS.includes(name.toLowerCase())) request.headers[name] = '<redacted>';
    }
  }

  // Bodies and query strings are never needed to diagnose a failure here, and
  // both can carry keys.
  if (request) {
    delete request.data;
    delete request.query_string;
    // A URL can carry a query (a presigned signature, a token); keep the path, which names the route.
    const r = request as { url?: unknown; cookies?: unknown };
    if (typeof r.url === 'string') r.url = r.url.split(/[?#]/)[0];
    delete r.cookies;
  }

  if (typeof event.message === 'string') event.message = scrubString(event.message);

  for (const entry of event.exception?.values ?? []) {
    if (typeof entry.value === 'string') entry.value = scrubString(entry.value);
  }

  if (event.extra) {
    for (const [key, value] of Object.entries(event.extra)) {
      if (typeof value === 'string') event.extra[key] = scrubString(value);
    }
  }

  return event;
}

// ---------------------------------------------------------------------------------------------
// Transactions and spans (log-standardization B1). Sentry runs `beforeSend` on errors only;
// transaction events go through `beforeSendTransaction` and span JSON through `beforeSendSpan`.
// Both carry the request (Authorization, X-Api-Key, cookies, client IP) and URL attributes with the
// query string (`url.query`, `url.full`, a signed preview token), so they get the same treatment.
// ---------------------------------------------------------------------------------------------

/** Request headers that may stay on a transaction (never a credential or an address). */
const SAFE_HEADERS = new Set(['content-type', 'content-length', 'accept', 'user-agent', 'host']);

/** Span/trace attribute names that hold a query string, a full URL, a cookie or a client address. */
const DROP_ATTRIBUTES = new Set([
  'url.query',
  'url.fragment',
  'http.query',
  'http.fragment',
  'http.request.body',
  'client.address',
  'client.ip',
  'http.client_ip',
  'net.peer.ip',
  'net.sock.peer.addr',
  'network.peer.address',
  'user.ip_address',
  'cf-connecting-ip',
  'x-forwarded-for',
  'x-real-ip',
]);

/** Attribute names holding a URL: keep the path, never the query or fragment. */
const URL_ATTRIBUTES = new Set(['url.full', 'http.url', 'url', 'request.url', 'http.target', 'url.path']);

function stripQuery(value: string): string {
  return value.split(/[?#]/)[0];
}

/** Scrub one attribute bag (span data, trace context data, tags, extra) in place. */
function scrubAttributes(bag: unknown): void {
  if (!bag || typeof bag !== 'object') return;
  const record = bag as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const lower = key.toLowerCase();
    if (DROP_ATTRIBUTES.has(lower)) {
      delete record[key];
      continue;
    }
    if (lower.startsWith('http.request.header.') || lower.startsWith('http.response.header.')) {
      const header = lower.slice(lower.lastIndexOf('.') + 1);
      if (!SAFE_HEADERS.has(header)) {
        delete record[key];
        continue;
      }
    }
    if (/(^|[._-])(authorization|cookie|api-key|apikey|token|secret|password)([._-]|$)/.test(lower)) {
      delete record[key];
      continue;
    }
    const value = record[key];
    if (typeof value === 'string') {
      record[key] = scrubString(URL_ATTRIBUTES.has(lower) ? stripQuery(value) : value);
    } else if (Array.isArray(value)) {
      record[key] = value.map((item) => (typeof item === 'string' ? scrubString(item) : item));
    }
  }
}

/** Drop everything credential-shaped from a request block; keep method, path and safe headers. */
function scrubRequestBlock(request: unknown): void {
  if (!request || typeof request !== 'object') return;
  const r = request as { headers?: Record<string, string>; url?: unknown; [k: string]: unknown };
  if (r.headers && typeof r.headers === 'object') {
    for (const name of Object.keys(r.headers)) {
      if (!SAFE_HEADERS.has(name.toLowerCase())) delete r.headers[name];
      else if (typeof r.headers[name] === 'string') r.headers[name] = scrubString(r.headers[name]);
    }
  }
  delete r.data;
  delete r.query_string;
  delete r.cookies;
  if (typeof r.url === 'string') r.url = scrubString(stripQuery(r.url));
}

/**
 * Strip credentials, query strings and client addresses from a Sentry transaction event before it
 * leaves the Worker. Takes `any` for the same reason as `scrubEvent`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose on purpose, see scrubEvent
export function scrubTransaction(event: any): any {
  scrubRequestBlock(event.request);
  if (event.user && typeof event.user === 'object') {
    delete event.user.ip_address;
    delete event.user.email;
    delete event.user.username;
  }
  if (typeof event.transaction === 'string') event.transaction = scrubString(stripQuery(event.transaction));
  scrubAttributes(event.contexts?.trace?.data);
  for (const ctx of Object.values(event.contexts ?? {})) {
    if (ctx && typeof ctx === 'object' && ctx !== event.contexts.trace) scrubAttributes(ctx);
  }
  scrubAttributes(event.tags);
  scrubAttributes(event.extra);
  for (const span of event.spans ?? []) scrubSpan(span);
  for (const crumb of event.breadcrumbs ?? []) scrubBreadcrumb(crumb);
  // Internal SDK bookkeeping (not serialised into the envelope) holds the raw request; drop it.
  if (event.sdkProcessingMetadata && typeof event.sdkProcessingMetadata === 'object') {
    delete event.sdkProcessingMetadata.normalizedRequest;
    delete event.sdkProcessingMetadata.request;
  }
  return event;
}

/** `beforeSendSpan`: scrub one span's description and attributes. Returns the span. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose on purpose, see scrubEvent
export function scrubSpan<T extends { description?: string; data?: any }>(span: T): T {
  if (typeof span.description === 'string') span.description = scrubString(stripQuery(span.description));
  scrubAttributes(span.data);
  return span;
}
