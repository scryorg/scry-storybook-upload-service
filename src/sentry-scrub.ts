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
