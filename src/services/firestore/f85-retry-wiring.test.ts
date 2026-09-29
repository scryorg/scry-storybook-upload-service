import { describe, it, expect, vi, afterEach } from 'vitest';
import { FirestoreServiceWorker } from './firestore.worker.js';

/**
 * Ledger F85/F86: on stage, a burst of native+web builds triggered sustained
 * Firestore 429s and this service's REST client had no resilience anywhere —
 * every getDocument/runQuery/PATCH threw on the first non-2xx response. These
 * tests exercise the real service methods (not just the retry helper in
 * isolation) to prove the wiring: a transient 429/503/500 is retried and
 * recovered, a client error is not, and the one non-idempotent write in this
 * file (`trackEvent`'s POST, which creates a new `events` document) is never
 * retried.
 */

function noHeaders() {
  return { get: () => null };
}

function service() {
  const svc = new FirestoreServiceWorker({ projectId: 'proj', clientEmail: 'sa@example.test', privateKey: 'k', serviceAccountId: 'sa' });
  (svc as unknown as { getAccessToken: () => Promise<string> }).getAccessToken = async () => 'test-token';
  return svc;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('F85: Firestore retry wiring on the real service methods', () => {
  it('getBuild (getDocument) retries a 429 then succeeds', async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 429, statusText: 'Too Many Requests', headers: noHeaders() };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          fields: {
            projectId: { stringValue: 'proj' },
            versionId: { stringValue: 'v1' },
            buildNumber: { integerValue: '3' },
            zipUrl: { stringValue: 'https://example.test/b.zip' },
            status: { stringValue: 'active' },
            createdAt: { timestampValue: '2026-09-28T00:00:00.000Z' },
            createdBy: { stringValue: 'sa' },
          },
        }),
      };
    }));

    const promise = service().getBuild('proj', 'build-1');
    await vi.runAllTimersAsync();
    const build = await promise;
    expect(build?.buildNumber).toBe(3);
    expect(calls).toBe(2);
  });

  it('updateBuild (patchDocument) does not retry a 400', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      return { ok: false, status: 400, statusText: 'Bad Request', text: async () => '{}' };
    }));

    await expect(
      service().updateBuild('proj', 'build-1', { processingStatus: 'completed' }),
    ).rejects.toThrow('Failed to patch document: 400 Bad Request');
    expect(calls).toBe(1);
  });

  it('trackEvent (POST, creates a new doc) is never retried — a retry would create a duplicate event', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      return { ok: false, status: 429, statusText: 'Too Many Requests', headers: noHeaders() };
    }));

    await expect(service().trackEvent('build_processed', { status: 'completed' })).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });

  it('getProjectBuilds (runQuery) retries a 503 then succeeds', async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 503, statusText: 'Service Unavailable', headers: noHeaders() };
      return { ok: true, status: 200, json: async () => [] };
    }));

    const promise = service().getProjectBuilds('proj');
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual([]);
    expect(calls).toBe(2);
  });
});
