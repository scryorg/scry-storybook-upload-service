import { describe, it, expect, vi } from 'vitest';
import {
  backoffMs,
  isRetryableFirestoreError,
  parseRetryAfterMs,
  retryFetch,
} from './firestore-retry.js';

/** A fake clock whose sleep just records the delay instead of actually waiting. */
function fakeSleep() {
  const slept: number[] = [];
  return { sleep: async (ms: number) => { slept.push(ms); }, slept };
}

function response(status: number, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status-${status}`,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null } as Headers,
  } as unknown as Response;
}

/** Same as `response()`, but with a body whose `cancel()` is a spy so a test can assert on it. */
function responseWithBody(status: number, headers: Record<string, string> = {}) {
  const cancel = vi.fn().mockResolvedValue(undefined);
  const res = {
    ...response(status, headers),
    body: { cancel },
  } as unknown as Response;
  return { res, cancel };
}

describe('isRetryableFirestoreError (ledger F85/F86)', () => {
  it('retries a thrown/network failure (no response at all)', () => {
    expect(isRetryableFirestoreError(null)).toBe(true);
  });

  it.each([429, 500, 503])('retries %d', (status) => {
    expect(isRetryableFirestoreError(status)).toBe(true);
  });

  it.each([400, 401, 403, 404, 409])('never retries %d', (status) => {
    expect(isRetryableFirestoreError(status)).toBe(false);
  });

  it('never retries a status outside the explicit list (e.g. a malformed/unknown one)', () => {
    expect(isRetryableFirestoreError(NaN)).toBe(false);
    expect(isRetryableFirestoreError(502)).toBe(false);
  });
});

describe('parseRetryAfterMs', () => {
  it('reads delta-seconds and fractional seconds', () => {
    expect(parseRetryAfterMs('2', 60_000)).toBe(2000);
    expect(parseRetryAfterMs('1.5', 60_000)).toBe(1500);
  });

  it('reads an HTTP-date relative to now', () => {
    const now = Date.parse('2026-09-28T20:00:00Z');
    expect(parseRetryAfterMs('Mon, 28 Sep 2026 20:00:30 GMT', 60_000, now)).toBe(30_000);
  });

  it('caps a value larger than capMs', () => {
    expect(parseRetryAfterMs('30', 4_000)).toBe(4_000);
  });

  it('is null for absent or unparseable values', () => {
    expect(parseRetryAfterMs(null, 4_000)).toBeNull();
    expect(parseRetryAfterMs(undefined, 4_000)).toBeNull();
    expect(parseRetryAfterMs('not-a-date', 4_000)).toBeNull();
  });

  it('F11: treats an HTTP-date already in the past as a 0ms delay, not null (still capped)', () => {
    const now = Date.parse('2026-09-28T20:00:00Z');
    // 30s before `now` -- an already-elapsed Retry-After.
    expect(parseRetryAfterMs('Mon, 28 Sep 2026 19:59:30 GMT', 60_000, now)).toBe(0);
    // Capped means 0 stays 0 even with a tiny cap.
    expect(parseRetryAfterMs('Mon, 28 Sep 2026 19:59:30 GMT', 0, now)).toBe(0);
  });
});

describe('backoffMs', () => {
  it('stays within [0, min(cap, base*2^attempt)] across many draws', () => {
    for (const attempt of [0, 1, 2, 3]) {
      const ceiling = Math.min(4_000, 250 * 2 ** attempt);
      for (let i = 0; i < 50; i++) {
        const ms = backoffMs(attempt, 250, 4_000, Math.random);
        expect(ms).toBeGreaterThanOrEqual(0);
        expect(ms).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it('is deterministic given a fixed random source', () => {
    expect(backoffMs(0, 250, 4_000, () => 0)).toBe(0);
    expect(backoffMs(0, 250, 4_000, () => 1)).toBe(250);
    expect(backoffMs(3, 250, 4_000, () => 1)).toBe(2_000); // 250*2^3 = 2000, under the 4000 cap
    expect(backoffMs(4, 250, 4_000, () => 1)).toBe(4_000); // 250*2^4 = 4000, exactly the cap
    expect(backoffMs(5, 250, 4_000, () => 1)).toBe(4_000); // 250*2^5 = 8000, clamped to the cap
  });
});

describe('retryFetch (ledger F85/F86: no Firestore call site retried a transient error)', () => {
  it('429 twice then 200 succeeds on the third attempt', async () => {
    const { sleep, slept } = fakeSleep();
    let call = 0;
    const doFetch = vi.fn(async () => {
      call++;
      return call <= 2 ? response(429) : response(200);
    });

    const res = await retryFetch(doFetch, { sleep, random: () => 0.5 });

    expect(res.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(3);
    expect(slept).toHaveLength(2);
  });

  it('400 is never retried', async () => {
    const { sleep, slept } = fakeSleep();
    const doFetch = vi.fn(async () => response(400));

    const res = await retryFetch(doFetch, { sleep });

    expect(res.status).toBe(400);
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(slept).toHaveLength(0);
  });

  it.each([401, 403, 404, 409])('%d is never retried', async (status) => {
    const { sleep } = fakeSleep();
    const doFetch = vi.fn(async () => response(status));

    const res = await retryFetch(doFetch, { sleep });

    expect(res.status).toBe(status);
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it('honours Retry-After over the exponential backoff', async () => {
    const { sleep, slept } = fakeSleep();
    const doFetch = vi.fn()
      .mockResolvedValueOnce(response(429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(response(200));

    const res = await retryFetch(doFetch, { sleep, random: () => 0.5 });

    expect(res.status).toBe(200);
    expect(slept).toEqual([2000]);
  });

  it('caps an oversized Retry-After at capMs', async () => {
    const { sleep, slept } = fakeSleep();
    const doFetch = vi.fn()
      .mockResolvedValueOnce(response(503, { 'retry-after': '30' }))
      .mockResolvedValueOnce(response(200));

    await retryFetch(doFetch, { sleep, capMs: 4_000 });

    expect(slept).toEqual([4_000]);
  });

  it('retries a thrown network error and then succeeds', async () => {
    const { sleep, slept } = fakeSleep();
    const doFetch = vi.fn()
      .mockRejectedValueOnce(new Error('network reset'))
      .mockResolvedValueOnce(response(200));

    const res = await retryFetch(doFetch, { sleep });

    expect(res.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(2);
    expect(slept).toHaveLength(1);
  });

  it('exhausts attempts and returns the last failing response (caller still sees the real status)', async () => {
    const { sleep } = fakeSleep();
    const doFetch = vi.fn(async () => response(503));

    const res = await retryFetch(doFetch, { sleep, attempts: 4 });

    expect(res.status).toBe(503);
    expect(doFetch).toHaveBeenCalledTimes(4);
  });

  it('re-throws the last error when every attempt threw', async () => {
    const { sleep } = fakeSleep();
    const doFetch = vi.fn().mockRejectedValue(new Error('always down'));

    await expect(retryFetch(doFetch, { sleep, attempts: 4 })).rejects.toThrow('always down');
    expect(doFetch).toHaveBeenCalledTimes(4);
  });

  it('F11: drains/cancels a retried response\'s body before sleeping', async () => {
    const { sleep } = fakeSleep();
    const { res: first, cancel } = responseWithBody(429);
    const doFetch = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(response(200));

    const res = await retryFetch(doFetch, { sleep });

    expect(res.status).toBe(200);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('F11: never drains a body on the response finally returned (last attempt / success)', async () => {
    const { sleep } = fakeSleep();
    const { res: last, cancel } = responseWithBody(503);
    const doFetch = vi.fn(async () => last);

    const res = await retryFetch(doFetch, { sleep, attempts: 1 });

    expect(res.status).toBe(503);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('F11: does not throw when a retried response has no body (test doubles, already-consumed bodies)', async () => {
    const { sleep } = fakeSleep();
    const doFetch = vi.fn()
      .mockResolvedValueOnce(response(429))
      .mockResolvedValueOnce(response(200));

    await expect(retryFetch(doFetch, { sleep })).resolves.toMatchObject({ status: 200 });
  });

  it('F11: an already-past Retry-After HTTP-date is honoured as a 0ms delay instead of falling back to backoff', async () => {
    const { sleep, slept } = fakeSleep();
    const pastDate = new Date(Date.now() - 60_000).toUTCString();
    const doFetch = vi.fn()
      .mockResolvedValueOnce(response(429, { 'retry-after': pastDate }))
      .mockResolvedValueOnce(response(200));

    const res = await retryFetch(doFetch, { sleep, random: () => 1 });

    expect(res.status).toBe(200);
    expect(slept).toEqual([0]);
  });

  it('logs each retry without ever including a token, bearer header or request body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { sleep } = fakeSleep();
    const doFetch = vi.fn()
      .mockResolvedValueOnce(response(429))
      .mockResolvedValueOnce(response(200));

    await retryFetch(doFetch, { sleep, op: 'getDocument' });

    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).not.toMatch(/bearer/i);
    expect(logged).not.toContain('Authorization');
    warn.mockRestore();
  });
});
