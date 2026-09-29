import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiKeyServiceWorker } from './apikey.worker.js';

/**
 * Ledger F85/F86: `ApiKeyServiceWorker.queryDocuments()` (validateApiKey's
 * Firestore query) 500'd the entire presign route for 7+ minutes straight on
 * stage — this is the exact call site named in the finding. These tests
 * exercise the real service methods to prove the wiring: a transient
 * 429/503/500 is retried and recovered, a client error is not.
 *
 * Real timers (not `vi.useFakeTimers()`): the crypto.subtle hashing on
 * `validateApiKey`'s path does not resolve reliably under fake timers in this
 * environment, and the default backoff for a single retry (<= 250ms for a
 * non-429 status, no Retry-After) is short enough to just let run for real.
 */

function noHeaders() {
  return { get: () => null };
}

function service() {
  const svc = new ApiKeyServiceWorker({ projectId: 'proj', clientEmail: 'sa@example.test', privateKey: 'k' });
  (svc as unknown as { accessToken: string; tokenExpiry: number }).accessToken = 'test-token';
  (svc as unknown as { accessToken: string; tokenExpiry: number }).tokenExpiry = Date.now() + 60_000;
  return svc;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('F85/F86: apikey.worker Firestore retry wiring', () => {
  it('validateApiKey (queryDocuments — the exact F85/F86 call site) retries a 500 then succeeds', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 500, statusText: 'Internal Server Error', headers: noHeaders() };
      return { ok: true, status: 200, json: async () => [] };
    }));

    const result = await service().validateApiKey('proj', 'scry_proj_proj_0123456789abcdef0123456789abcdef');
    expect(result.valid).toBe(false); // no matching key doc, but no throw — the transient 500 was recovered
    expect(calls).toBe(2);
  });

  it('createApiKey (setDocument) does not retry a 403', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      return { ok: false, status: 403, statusText: 'Forbidden', headers: noHeaders() };
    }));

    await expect(service().createApiKey('proj', { name: 'Test', createdBy: 'u1' })).rejects.toThrow('Failed to set document');
    expect(calls).toBe(1);
  });

  it('revokeApiKey (patchDocument) retries a 429 then succeeds', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 429, statusText: 'Too Many Requests', headers: noHeaders() };
      return { ok: true, status: 200, json: async () => ({}) };
    }));

    await expect(service().revokeApiKey('proj', 'key-1', 'admin')).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });
});
