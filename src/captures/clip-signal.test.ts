/**
 * sync-clipboard-push, upload side (contract section 5): a ready snip tells the signal Worker, after the answer,
 * and nothing about the signal can change the answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/cloudflare', () => ({
  captureException: () => undefined,
  getCurrentScope: () => ({ setTag: () => undefined }),
  getTraceData: () => ({}),
}));

import { CAPTURE_ID, CAPTURE_ID_2, DEVICE_KEY, PROJECT, SECOND_DEVICE_KEY, fakeJpeg, fakePng, fakeWebp, post, presignBody, setup } from './captures.test-support.js';
import { clipSignalConfig, sendClipSignal, type ClipSignalBinding } from './clip-signal.js';

const SECRET = 'fixture-send-secret-not-real';
const UID = 'uid-ada';
const PNG = fakePng(1200, 800);
const JPEG = fakeJpeg();
const WEBP = fakeWebp();
const FAST = { timeoutMs: 40, retryDelayMs: 5 };

type Call = { url: string; init: RequestInit };
const fetchOk = () => new Response('{"sent":1}', { status: 200 });

function binding(handler: (call: Call) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const b: ClipSignalBinding = {
    fetch: async (url, init) => {
      const call = { url, init: init ?? {} };
      calls.push(call);
      return handler(call);
    },
  };
  return { b, calls };
}

let lines: string[] = [];
beforeEach(() => {
  lines = [];
  const grab = (...args: unknown[]) => void lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  for (const m of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, m).mockImplementation(grab);
});
afterEach(() => vi.restoreAllMocks());

/** Runs a request the way the Worker does: with an execution context whose waitUntil promises we can await. */
async function run(env: ReturnType<typeof setup>, path: string, key: string, body: unknown) {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined };
  const res = await env.server.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': key }, body: JSON.stringify(body) }, {}, ctx as never);
  await Promise.all(pending);
  return { res, scheduled: pending.length };
}

async function readyToComplete(env: ReturnType<typeof setup>, key = DEVICE_KEY, captureId = CAPTURE_ID) {
  const res = await post(env.server, `/captures/${PROJECT}/presign`, key, presignBody(PNG, { captureId }));
  const json = (await res.json()) as { uploads: Record<'original' | 'preview' | 'agent', { key: string }> };
  await env.bucket.put(json.uploads.original.key, PNG, 'image/png');
  await env.bucket.put(json.uploads.preview.key, JPEG, 'image/jpeg');
  await env.bucket.put(json.uploads.agent.key, WEBP, 'image/webp');
}
const complete = (env: ReturnType<typeof setup>, key = DEVICE_KEY, captureId = CAPTURE_ID) => run(env, `/captures/${PROJECT}/complete`, key, { captureId });

describe('signal on completion', () => {
  it('sends one signal with the owner uid and the secret after a snip becomes ready', async () => {
    const { b, calls } = binding(fetchOk);
    const env = setup({ clipSignal: { binding: b, secret: SECRET } });
    await readyToComplete(env);
    const { res, scheduled } = await complete(env);
    expect(res.status).toBe(200);
    expect(scheduled).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://clip-signal/v1/signal');
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ u: UID });
  });

  it('signals the uid of the person who completed, not another person', async () => {
    const { b, calls } = binding(fetchOk);
    const env = setup({ clipSignal: { binding: b, secret: SECRET } });
    await readyToComplete(env, SECOND_DEVICE_KEY, CAPTURE_ID_2);
    await complete(env, SECOND_DEVICE_KEY, CAPTURE_ID_2);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ u: 'uid-bob' });
  });

  it('sends nothing when the ready capture has no capturedByUid', async () => {
    const { b, calls } = binding(fetchOk);
    const env = setup({ clipSignal: { binding: b, secret: SECRET } });
    await readyToComplete(env);
    const real = env.firestore.markCaptureReady.bind(env.firestore);
    env.firestore.markCaptureReady = async (p: string, id: string) => {
      const ready = await real(p, id);
      return ready && { ...ready, capturedByUid: undefined as never };
    };
    const { res, scheduled } = await complete(env);
    expect(res.status).toBe(200);
    expect(scheduled).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('sends nothing on a refused completion (missing objects, unknown capture, another person\'s capture)', async () => {
    const { b, calls } = binding(fetchOk);
    const env = setup({ clipSignal: { binding: b, secret: SECRET } });
    const presigned = await post(env.server, `/captures/${PROJECT}/presign`, DEVICE_KEY, presignBody(PNG));
    expect(presigned.status).toBe(200);
    expect((await complete(env)).res.status).toBe(409); // nothing PUT yet
    expect((await complete(env, DEVICE_KEY, CAPTURE_ID_2)).res.status).toBe(404);
    expect((await complete(env, SECOND_DEVICE_KEY)).res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('sends nothing when the capture vanished before it could be marked ready', async () => {
    const { b, calls } = binding(fetchOk);
    const env = setup({ clipSignal: { binding: b, secret: SECRET } });
    await readyToComplete(env);
    env.firestore.markCaptureReady = async () => null;
    expect((await complete(env)).res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('sends nothing on a repeated completion of an already ready capture', async () => {
    const { b, calls } = binding(fetchOk);
    const env = setup({ clipSignal: { binding: b, secret: SECRET } });
    await readyToComplete(env);
    expect((await complete(env)).res.status).toBe(200);
    expect((await complete(env)).res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('without the binding or the secret the completion works and nothing is sent or logged', async () => {
    const env = setup();
    await readyToComplete(env);
    const { res, scheduled } = await complete(env);
    expect(res.status).toBe(200);
    expect(scheduled).toBe(0);
    expect(lines.filter((l) => l.includes('clip_signal'))).toHaveLength(0);
    expect(clipSignalConfig(undefined, SECRET)).toBeUndefined();
    expect(clipSignalConfig(binding(fetchOk).b, undefined)).toBeUndefined();
    expect(clipSignalConfig(binding(fetchOk).b, '')).toBeUndefined();
    expect(clipSignalConfig(binding(fetchOk).b, SECRET)).toBeDefined();
  });
});

describe('a failed signal never changes the answer (A7)', () => {
  const answerWith = async (handler: (call: Call) => Promise<Response> | Response) => {
    const { b, calls } = binding(handler);
    const env = setup({ clipSignal: { binding: b, secret: SECRET } });
    await readyToComplete(env);
    const { res } = await complete(env);
    return { res, calls, body: (await res.json()) as { capture: { status: string } } };
  };

  it('a 500 from the signal Worker: still 200 ready, one retry, then send_failed', async () => {
    const { res, calls, body } = await answerWith(() => new Response('no', { status: 500 }));
    expect(res.status).toBe(200);
    expect(body.capture.status).toBe('ready');
    expect(calls).toHaveLength(2);
    expect(lines.filter((l) => l.includes('clip_signal.send_retried'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('clip_signal.send_failed'))).toHaveLength(1);
  });

  it('a throwing binding: still 200 ready', async () => {
    const { res, calls, body } = await answerWith(() => {
      throw new Error('binding exploded');
    });
    expect(res.status).toBe(200);
    expect(body.capture.status).toBe('ready');
    expect(calls).toHaveLength(2);
  });

  it('a signal that never answers does not delay the 200 and is cut off by the timeout', async () => {
    const { b, calls } = binding((call) => new Promise<Response>((_resolve, reject) => (call.init.signal as AbortSignal).addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')))));
    const env = setup({ clipSignal: { binding: b, secret: SECRET, timing: { timeoutMs: 300, retryDelayMs: 5 } } });
    await readyToComplete(env);
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined };
    const res = await env.server.request(`/captures/${PROJECT}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': DEVICE_KEY }, body: JSON.stringify({ captureId: CAPTURE_ID }) }, {}, ctx as never);
    expect(res.status).toBe(200); // answered while the signal is still in flight
    expect(calls).toHaveLength(1);
    expect(lines.filter((l) => l.includes('clip_signal.send_failed'))).toHaveLength(0);
    await Promise.all(pending);
    expect(calls).toHaveLength(2);
    expect(lines.filter((l) => l.includes('clip_signal.send_failed'))).toHaveLength(1);
    expect(lines.join('\n')).toContain('"outcome":"timeout"');
  });

  it('a request without an execution context still answers 200', async () => {
    const { b, calls } = binding(fetchOk);
    const env = setup({ clipSignal: { binding: b, secret: SECRET } });
    await readyToComplete(env);
    const res = await post(env.server, `/captures/${PROJECT}/complete`, DEVICE_KEY, { captureId: CAPTURE_ID });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
  });
});

describe('retry count', () => {
  it('success on the first attempt: one call, no retry line', async () => {
    const { b, calls } = binding(fetchOk);
    await sendClipSignal({ binding: b, secret: SECRET }, UID, {}, FAST);
    expect(calls).toHaveLength(1);
    expect(lines.filter((l) => l.includes('clip_signal'))).toHaveLength(0);
  });

  it('failure then success: two calls, one retry line, no failure line', async () => {
    let n = 0;
    const { b, calls } = binding(() => (++n === 1 ? new Response('x', { status: 503 }) : fetchOk()));
    await sendClipSignal({ binding: b, secret: SECRET }, UID, {}, FAST);
    expect(calls).toHaveLength(2);
    expect(lines.filter((l) => l.includes('clip_signal.send_retried'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('clip_signal.send_failed'))).toHaveLength(0);
  });

  it('two failures: exactly two calls (one retry, never more), one failure line', async () => {
    const { b, calls } = binding(() => new Response('x', { status: 401 }));
    await sendClipSignal({ binding: b, secret: SECRET }, UID, {}, FAST);
    expect(calls).toHaveLength(2);
    expect(lines.filter((l) => l.includes('clip_signal.send_failed'))).toHaveLength(1);
  });

  it('the retry waits at least the retry delay (generous floor)', async () => {
    const stamps: number[] = [];
    const { b } = binding(() => {
      stamps.push(Date.now());
      return new Response('x', { status: 500 });
    });
    await sendClipSignal({ binding: b, secret: SECRET }, UID, { timeoutMs: 40, retryDelayMs: 60 });
    expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(30);
  });

  it('a hanging call is aborted by its own timeout', async () => {
    const { b, calls } = binding((call) => new Promise<Response>((_r, reject) => (call.init.signal as AbortSignal).addEventListener('abort', () => reject(new DOMException('x', 'TimeoutError')))));
    await sendClipSignal({ binding: b, secret: SECRET }, UID, {}, FAST);
    expect(calls).toHaveLength(2);
    expect(lines.join('\n')).toContain('"outcome":"timeout"');
  });

  it('no config or no uid: a silent no-op', async () => {
    const { b, calls } = binding(fetchOk);
    await sendClipSignal(undefined, UID, {}, FAST);
    await sendClipSignal({ binding: b, secret: SECRET }, undefined, {}, FAST);
    expect(calls).toHaveLength(0);
    expect(lines).toHaveLength(0);
  });
});

describe('logs', () => {
  it('carry no uid, secret or url, even when the signal fails', async () => {
    const { b } = binding(() => {
      throw new Error(`boom ${UID} ${SECRET}`);
    });
    await sendClipSignal({ binding: b, secret: SECRET }, UID, { request_id: 'req-1' }, FAST);
    const text = lines.join('\n');
    expect(text).toContain('clip_signal.send_failed');
    expect(text).toContain('clip_signal.send_retried');
    expect(text).not.toContain(UID);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('boom');
    expect(text).not.toContain('https://clip-signal');
  });
});
