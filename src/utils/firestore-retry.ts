import { log } from '../lib/log.js';
/**
 * Retry wrapper for idempotent Firestore REST calls (ledger F85/F86: a burst of
 * native+web builds landed on one stage project within ~30 min and Firestore
 * answered with sustained 429s; the presign route 500'd for 7+ minutes
 * straight because `ApiKeyServiceWorker.queryDocuments()`'s key-validation
 * query had no resilience — nothing in this service retried a transient
 * Firestore error).
 *
 * In scope: GET a document, `runQuery`, and a PATCH that only sets fields to
 * fixed values the caller already computed — this client never sends a
 * Firestore field-transform (no `increment`; the build/upload counters are
 * read-then-written as an absolute value), so every `setDocument`/
 * `patchDocument` call here is safe to resend verbatim. Retries 429, 503 and
 * 500, and a thrown network error (no response at all); never retries
 * 400/401/403/404/409, or any other status — those are not transient, and
 * retrying them only spends the Workers CPU/wall budget for no chance of a
 * different answer. Honours `Retry-After` when the response carries one.
 *
 * Deliberately NOT used for: `trackEvent`'s POST (creates a new `events`
 * document with a server-assigned id — retrying it after a lost response
 * would create a duplicate event, not resend the same write), DELETE calls, or
 * the OAuth2 token exchange (not a Firestore REST call; ledger F85 is scoped
 * to Firestore). All are separate, ledgered deferrals.
 *
 * Tuned short on purpose (4 attempts, 250 ms base, 4 s cap, full jitter):
 * these calls run inline on the upload/API-key-validation request path, so
 * added latency has to stay well inside a Worker's wall-clock budget even
 * under sustained throttling.
 *
 * Used by both this service's Firestore REST clients:
 * `src/services/firestore/firestore.worker.ts` and
 * `src/services/apikey/apikey.worker.ts`.
 */

export type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export const DEFAULT_ATTEMPTS = 4;
export const DEFAULT_BASE_MS = 250;
export const DEFAULT_CAP_MS = 4_000;

/** Firestore statuses this helper retries. Deliberately narrow: only what F85/F86 saw as transient. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 503]);

/**
 * `status` is `null` only for a thrown/network failure (no response was ever
 * received) — that is always retried. A response that came back with some
 * other status (including one Firestore rarely sends, or a malformed one) is
 * retried only when it is exactly 429, 500 or 503. 400/401/403/404/409 are
 * never in `RETRYABLE_STATUSES`, so they fall through to `false` too.
 */
export function isRetryableFirestoreError(status: number | null): boolean {
  if (status === null) return true;
  return RETRYABLE_STATUSES.has(status);
}

/**
 * `Retry-After` (delta-seconds or an HTTP-date) as milliseconds. Capped at
 * `capMs` so a large or hostile value cannot itself exceed the retry budget.
 * `null` when absent or unparseable.
 */
export function parseRetryAfterMs(value: string | null | undefined, capMs: number, nowMs: number = Date.now()): number | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw) return null;
  let ms: number | null = null;
  if (/^\d+(\.\d+)?$/.test(raw)) {
    ms = Math.round(parseFloat(raw) * 1000);
  } else {
    const at = Date.parse(raw);
    if (Number.isFinite(at)) ms = Math.max(0, at - nowMs);
  }
  if (ms === null || !Number.isFinite(ms)) return null;
  return Math.min(ms, capMs);
}

/** Exponential backoff with full jitter: uniform in [0, min(cap, base·2^attempt)]. */
export function backoffMs(attempt: number, baseMs: number, capMs: number, random: () => number = Math.random): number {
  const ceiling = Math.min(capMs, baseMs * Math.pow(2, Math.max(0, attempt)));
  return Math.round(random() * ceiling);
}

export interface RetryFetchOptions {
  /** Total tries including the first. Default 4 (1 try + up to 3 retries). */
  attempts?: number;
  baseMs?: number;
  capMs?: number;
  random?: () => number;
  sleep?: Sleep;
  /** Short tag for the retry log line (e.g. "getDocument", "runQuery"). */
  op?: string;
}

function safeHeader(response: Response, name: string): string | null {
  try {
    return response.headers?.get?.(name) ?? null;
  } catch {
    return null;
  }
}

/**
 * Call `doFetch()` and retry the same request on a transient failure. Returns
 * the last `Response` unchanged on a non-retryable status or once attempts are
 * exhausted, so the caller's own `if (!response.ok) throw ...` still fires
 * with the real status/statusText — this wraps only the fetch, never the
 * caller's error handling. Re-throws the last error when every attempt threw
 * (no `Response` was ever received). Never logs the request (the bearer token
 * lives in a header this never reads or prints).
 */
export async function retryFetch(doFetch: () => Promise<Response>, opts: RetryFetchOptions = {}): Promise<Response> {
  const attempts = Math.max(1, opts.attempts ?? DEFAULT_ATTEMPTS);
  const baseMs = opts.baseMs ?? DEFAULT_BASE_MS;
  const capMs = opts.capMs ?? DEFAULT_CAP_MS;
  const random = opts.random ?? Math.random;
  const sleep = opts.sleep ?? realSleep;

  for (let attempt = 0; ; attempt++) {
    let response: Response | undefined;
    let error: unknown;
    try {
      response = await doFetch();
    } catch (e) {
      error = e;
    }

    if (response?.ok) return response;

    const status: number | null = response ? (response.status ?? NaN) : null;
    const retryable = isRetryableFirestoreError(status);
    const isLastAttempt = attempt >= attempts - 1;
    if (!retryable || isLastAttempt) {
      if (response) return response;
      throw error;
    }

    const retryAfterMs = response ? parseRetryAfterMs(safeHeader(response, 'retry-after'), capMs) : null;
    const delayMs = retryAfterMs ?? backoffMs(attempt, baseMs, capMs, random);
    // Status-bearing (log-standardization M2): 429 vs 503 vs a network throw is the whole diagnosis.
    log.warn('firestore retrying after transient error', {
      err_code: status === null ? 'firestore_transient_network' : 'firestore_transient',
      ...(status !== null && Number.isFinite(status) ? { status } : {}),
    });
    // F11: drain/cancel the body of the response we're about to discard and retry. An unread body
    // left dangling on Cloudflare Workers can count toward the runtime's 6-simultaneous-connection
    // limit and get the whole response cancelled mid-retry -- undermining the retry during exactly
    // the throttling burst it exists to survive. Never throws: a body that is already used/locked or
    // has no `cancel` (e.g. a test double) is fine to ignore.
    if (response) {
      await response.body?.cancel().catch(() => {});
    }
    await sleep(delayMs);
  }
}
