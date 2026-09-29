import { retryFetch, type RetryFetchOptions } from './firestore-retry.js';

/**
 * OAuth2 service-account token exchange shared by both Firestore REST clients (ledger F145).
 *
 * On stage, four consecutive presigns 500'd after ~20 s each with no retry line and no auth line in
 * the Worker logs: the only call on that path that had neither a retry nor a timeout was this
 * exchange (F85 scoped retries to the Firestore REST calls and left the token exchange out). It now
 * has a per-attempt timeout and the same transient-error retry (429/500/503/network/timeout), and
 * concurrent callers on one isolate share one in-flight exchange instead of each posting a JWT.
 */

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const TOKEN_ATTEMPT_TIMEOUT_MS = 4_000;
export const TOKEN_ATTEMPTS = 3;

export interface AccessToken {
  accessToken: string;
  /** Epoch ms after which the token must be refreshed (already 60 s early). */
  expiresAtMs: number;
}

export async function exchangeJwtForAccessToken(
  jwt: string,
  opts: RetryFetchOptions & { timeoutMs?: number } = {}
): Promise<AccessToken> {
  const { timeoutMs = TOKEN_ATTEMPT_TIMEOUT_MS, ...retryOpts } = opts;
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  }).toString();

  const response = await retryFetch(
    () =>
      fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      }),
    { attempts: TOKEN_ATTEMPTS, op: 'tokenExchange', ...retryOpts }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to get access token: ${response.status} ${response.statusText} ${errorText}`);
  }

  const data = (await response.json()) as { access_token: string; expires_in: number };
  return { accessToken: data.access_token, expiresAtMs: Date.now() + (data.expires_in - 60) * 1000 };
}
