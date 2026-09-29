import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { ApiKeyServiceWorker } from './services/apikey/apikey.worker.js';
import { FirestoreServiceWorker } from './services/firestore/firestore.worker.js';
import { exchangeJwtForAccessToken } from './utils/google-token.js';
import { apiKeyAuth } from './middleware/auth.js';
import { generateApiKey } from './services/apikey/apikey.utils.js';

/**
 * Ledger F145: four consecutive presigns on upload-stage 500'd after ~20 s each ("Internal server
 * error", no Firestore retry line, no auth line). The OAuth token exchange had no timeout and no
 * retry, and every concurrent request on a cold isolate posted its own. These tests reproduce a
 * burst of concurrent presign-auth calls against a flaky/hanging token endpoint.
 */

const KEY = generateApiKey('p');
const noHeaders = { get: () => null };

function apikeySvc() {
  const svc = new ApiKeyServiceWorker({ projectId: 'p', clientEmail: 'sa@x.test', privateKey: 'k' });
  (svc as unknown as { createJWT: () => Promise<string> }).createJWT = async () => 'jwt';
  return svc;
}

/** Stub fetch: token endpoint behaves per `tokenBehaviour(n)`; Firestore runQuery returns one active key. */
/** AbortSignal.timeout runs on a native timer that fake timers cannot advance; rebuild it on setTimeout. */
function fakeAbortTimeout() {
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(new DOMException('timed out', 'TimeoutError')), ms);
    return ctl.signal;
  });
}

function stubFetch(tokenBehaviour: (n: number) => 'hang' | 503 | 'ok') {
  const calls = { token: 0, query: 0 };
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const b = tokenBehaviour(++calls.token);
      if (b === 'hang') {
        return new Promise((_res, rej) => {
          init?.signal?.addEventListener('abort', () => rej(new DOMException('timed out', 'TimeoutError')));
        });
      }
      if (b === 503) return Promise.resolve({ ok: false, status: 503, statusText: 'Service Unavailable', headers: noHeaders, text: async () => '' });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 3600 }) });
    }
    calls.query++;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => [{ document: { name: 'projects/p/apiKeys/k1', fields: { name: { stringValue: 'ci' }, status: { stringValue: 'active' } } } }],
    });
  }));
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('F145: token exchange survives a flaky endpoint under a concurrent burst', () => {
  it('8 concurrent validateApiKey calls all succeed when the first token attempts hang / 503, with one shared exchange', async () => {
    vi.useFakeTimers();
    fakeAbortTimeout();
    // attempt 1 hangs (timeout), attempt 2 is a 503, attempt 3 succeeds.
    const script = ['hang', 503] as const;
    const calls = stubFetch((n) => script[n - 1] ?? 'ok');
    const svc = apikeySvc();

    const burst = Array.from({ length: 8 }, () => svc.validateApiKey('p', KEY));
    await vi.runAllTimersAsync();
    const results = await Promise.all(burst);

    expect(results.every((r) => r.valid)).toBe(true);
    // Shared in-flight exchange: 3 attempts total for the whole burst, not 3 x 8.
    expect(calls.token).toBe(3);
    expect(calls.query).toBe(8);
  });

  it('a hanging token endpoint fails fast (per-attempt timeout) instead of hanging ~20 s', async () => {
    vi.useFakeTimers();
    fakeAbortTimeout();
    stubFetch(() => 'hang');
    const p = exchangeJwtForAccessToken('jwt').then(() => 'ok', (e: Error) => e.name);
    const t0 = Date.now();
    await vi.runAllTimersAsync();
    expect(await p).toBe('TimeoutError');
    // 3 attempts x 4 s + backoff <= 4 s each: bounded, well under the 20 s the stage requests took.
    expect(Date.now() - t0).toBeLessThan(20_000);
  });

  it('FirestoreServiceWorker shares one exchange across concurrent callers too', async () => {
    const calls = stubFetch(() => 'ok');
    const svc = new FirestoreServiceWorker({ projectId: 'p', clientEmail: 'sa@x.test', privateKey: 'k', serviceAccountId: 'sa' });
    (svc as unknown as { createJWT: () => Promise<string> }).createJWT = async () => 'jwt';
    const get = (svc as unknown as { getAccessToken: () => Promise<string> }).getAccessToken.bind(svc);
    const tokens = await Promise.all(Array.from({ length: 8 }, () => get()));
    expect(new Set(tokens)).toEqual(new Set(['t']));
    expect(calls.token).toBe(1);
  });
});

describe('F145: auth backend failure is a 503 + Retry-After, never an unhandled 500', () => {
  it('validateApiKey throwing yields 503 with Retry-After', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('apiKeyService' as never, { validateApiKey: async () => { throw new Error('Failed to get access token: 503'); } } as never);
      await next();
    });
    app.use('/presigned-url/:project/*', apiKeyAuth());
    app.post('/presigned-url/:project/v/bundle.zip', (c) => c.json({ ok: true }));

    const res = await app.request('/presigned-url/proj/v/bundle.zip', { method: 'POST', headers: { 'X-API-Key': generateApiKey('proj') } });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('2');
  });
});
