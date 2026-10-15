/**
 * Optional `animation` on POST /captures/:project/presign and the clip checks in /complete
 * (feature animated-snips, upload PR 1). Cases are driven from the shared contract
 * (test/fixtures/animated-snips-contract.json); clips are the real fixtures in test/fixtures/animated-snips/.
 *
 * guarantee-2: a still capture is byte-for-byte what it was, with the switch on, off or unset; an `animation`
 *              sent with the switch off is dropped unread.
 * guarantee-4: a clip that is not exactly what the contract allows is refused with the contract's code, and all
 *              four objects are deleted; the two valid clips pass.
 *
 * Set SCRY_RECORD_FIXTURES=1 to rewrite test/fixtures/presign-with-animation.json (Sync and the UAT seed read it).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/cloudflare', () => ({
  captureException: () => undefined,
  getCurrentScope: () => ({ setTag: () => undefined }),
  getTraceData: () => ({}),
}));

import { CAPTURE_ID, DEVICE_KEY, PROJECT, fakeJpeg, fakePng, fakeWebp, post, presignBody, setup, sha256 } from './captures.test-support.js';

type Decl = { bytes: number; sha256: string; durationMs: number; width: number; height: number; fps: number };
type ErrorCase = { case: string; status: number; body: { error: string; message: string; fields?: string[] }; deletes?: boolean; patch?: Record<string, unknown> };
type Contract = {
  limits: { maxBytes: number };
  presign: {
    still_switch_any: { request: Record<string, unknown>; response: { status: number; body: Record<string, unknown> } };
    with_animation_switch_on: { request: Record<string, unknown> & { animation: Decl }; response: { status: number; body: Record<string, unknown> } };
    with_animation_switch_off: { request: Record<string, unknown>; response: { status: number; body: Record<string, unknown> } };
    retry_different_animation: { change: Record<string, unknown>; response: { status: number; body: { error: string } } };
    errors: ErrorCase[];
  };
  complete: { ok_with_animation: { response: { status: number; body: { capture: Record<string, unknown> } } }; errors: ErrorCase[] };
};
type PresignJson = {
  capture: Record<string, unknown>;
  created: boolean;
  uploads: Record<string, { url: string; key: string; contentType: string }> | null;
};

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '../../test/fixtures');
const contract = JSON.parse(readFileSync(join(FIXTURES, 'animated-snips-contract.json'), 'utf8')) as Contract;
const RECORD = process.env.SCRY_RECORD_FIXTURES === '1';
const clip = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, 'animated-snips', name)));

const NOW = new Date('2026-10-15T10:00:00.000Z');
const W = 1280;
const H = 800;
const PNG = fakePng(W, H, 600);
const JPEG = fakeJpeg();
const WEBP = fakeWebp();
const presignPath = `/captures/${PROJECT}/presign`;
const completePath = `/captures/${PROJECT}/complete`;
const CONTRACT_ID = contract.presign.with_animation_switch_on.request.captureId as string;
const TOO_LARGE_AT_PRESIGN = 'An image is larger than its limit (original 20 MB, preview 2 MB, agent 512 KB)';
const TOO_LARGE_AT_COMPLETE = 'An uploaded image is larger than its limit';
const SIZE_MISMATCH = 'An uploaded image does not match its declared size';
const ID_CONFLICT = 'This captureId is already in use';

let lines: string[];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  vi.restoreAllMocks();
  lines = [];
  const grab = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  for (const m of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, m).mockImplementation(grab);
});
afterEach(() => vi.useRealTimers());
const jsonLines = () => lines.flatMap((l) => { try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; } });

type Env = ReturnType<typeof setup>;
type Opts = NonNullable<Parameters<typeof setup>[0]>;

// ---- request helpers -----------------------------------------------------------------------------

/** Apply `{ "animation.fps": 13 }`-style patches to a deep copy of a request. */
function patched(request: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(request) as Record<string, unknown>;
  for (const [path, value] of Object.entries(patch)) {
    const parts = path.split('.');
    let at = copy;
    for (const part of parts.slice(0, -1)) at = at[part] as Record<string, unknown>;
    at[parts[parts.length - 1]] = value;
  }
  return copy;
}
const declare = (bytes: Uint8Array, over: Partial<Decl> = {}): Decl => ({ bytes: bytes.byteLength, sha256: sha256(bytes), durationMs: 3000, width: W, height: H, fps: 12, ...over });
const stillBody = (overrides: Record<string, unknown> = {}) => presignBody(PNG, overrides, W, H);
const sendBody = async (env: Env, body: unknown) => {
  const res = await post(env.server, presignPath, DEVICE_KEY, body);
  return { res, json: (await res.clone().json()) as PresignJson & { error?: string; message?: string; fields?: string[] } };
};
const doc = (env: Env, id = CAPTURE_ID) => env.firestore.captures.get(`${PROJECT}/${id}`);
const keyFor = (name: string, id = CAPTURE_ID) => `${PROJECT}/captures/${id}/${name}`;
const FILES = ['original.png', 'preview.jpg', 'agent.webp', 'animation.mp4'] as const;
const present = (env: Env, id = CAPTURE_ID) => FILES.filter((f) => env.bucket.objects.has(keyFor(f, id)));
async function putStills(env: Env, id = CAPTURE_ID) {
  await env.bucket.put(keyFor('original.png', id), PNG, 'image/png');
  await env.bucket.put(keyFor('preview.jpg', id), JPEG, 'image/jpeg');
  await env.bucket.put(keyFor('agent.webp', id), WEBP, 'image/webp');
}
const complete = (env: Env, id = CAPTURE_ID) => post(env.server, completePath, DEVICE_KEY, { captureId: id });

/** Replace the volatile parts of a response with the contract's placeholders so the shapes can be compared. */
function normalised(json: PresignJson): unknown {
  const text = JSON.stringify(json)
    .replaceAll(PROJECT, 'uat-project')
    .replaceAll(CAPTURE_ID, CONTRACT_ID)
    .replace(/"expiresAt":"[^"]+"/, '"expiresAt":"<ISO, +30 d>"')
    .replace(/"url":"[^"]+"/g, '"url":"<presigned R2 PUT, 900 s, signs Content-Type + Content-Length>"');
  return JSON.parse(text);
}

// ---- guarantee-2 ---------------------------------------------------------------------------------

describe('guarantee-2 a still capture is unchanged by the animated-snips switch', () => {
  const STILL_CAPTURE_KEYS = ['captureId', 'status', 'width', 'height', 'bytes', 'sha256', 'expiresAt'];
  const STILL_DOC_KEYS = ['agentBytes', 'bytes', 'captureId', 'capturedByUid', 'createdAt', 'deviceId', 'expiresAt', 'height', 'mode', 'os', 'previewBytes', 'scale', 'sendMode', 'sha256', 'sharedWith', 'sharedWithOrgIds', 'sharedWithProject', 'status', 'width'];
  const switches: Array<[string, Opts]> = [['on', { animatedSnips: true }], ['off', { animatedSnips: false }], ['unset', {}]];

  it('presign: the same still request gets the same status, body and stored fields with the switch on, off and unset', async () => {
    const seen: Array<{ status: number; json: PresignJson; stored: unknown; signed: number }> = [];
    for (const [, opts] of switches) {
      const env = setup({ ...opts });
      const sign = vi.spyOn(env.storage, 'getPresignedCaptureUploadUrl');
      const { res, json } = await sendBody(env, stillBody({ note: 'spacing' }));
      seen.push({ status: res.status, json, stored: doc(env), signed: sign.mock.calls.length });
    }
    expect(seen[0].status).toBe(200);
    for (const other of seen.slice(1)) expect(other).toEqual(seen[0]);
    // what origin/stage answers: three uploads, six-plus-one summary keys, no clip anywhere
    expect(Object.keys(seen[0].json.capture)).toEqual(STILL_CAPTURE_KEYS);
    expect(Object.keys(seen[0].json.uploads ?? {})).toEqual(['original', 'preview', 'agent']);
    expect(seen[0].signed).toBe(3);
    expect(Object.keys(seen[0].stored as object).sort()).toEqual([...STILL_DOC_KEYS, 'note'].sort());
    expect(Object.keys(seen[0].json).sort()).toEqual(['capture', 'created', 'uploads']);
  });

  it('presign: a still response has the contract still_switch_any shape', async () => {
    const env = setup({ animatedSnips: true });
    const { json } = await sendBody(env, stillBody({ captureId: CONTRACT_ID }));
    const expected = structuredClone(contract.presign.still_switch_any.response.body) as { capture: Record<string, unknown> };
    // the contract picture is the real keyframe; only the numbers of the tiny test image differ
    for (const k of ['bytes', 'sha256']) expected.capture[k] = json.capture[k];
    const got = normalised(json) as { capture: Record<string, unknown> };
    expect(got).toEqual(expected);
  });

  it('complete: a still capture completes to the same response, stored fields and objects with the switch on, off and unset', async () => {
    const seen: Array<{ status: number; body: unknown; stored: unknown; objects: string[]; queued: number }> = [];
    for (const [, opts] of switches) {
      const env = setup({ ...opts });
      await sendBody(env, stillBody());
      await putStills(env);
      const res = await complete(env);
      seen.push({ status: res.status, body: await res.json(), stored: doc(env), objects: [...env.bucket.objects.keys()].sort(), queued: env.queue.send.mock.calls.length });
    }
    expect(seen[0].status).toBe(200);
    for (const other of seen.slice(1)) expect(other).toEqual(seen[0]);
    const body = seen[0].body as { capture: Record<string, unknown> };
    expect(Object.keys(body.capture)).toEqual([...STILL_CAPTURE_KEYS, 'receivedAt']);
    expect(body.capture.status).toBe('ready');
    expect(Object.keys(seen[0].stored as object).sort()).toEqual([...STILL_DOC_KEYS, 'receivedAt'].sort());
    expect(seen[0].objects).toEqual(['original.png', 'preview.jpg', 'agent.webp'].map((f) => keyFor(f)).sort());
  });

  it('complete: a still capture that misses a file still answers the three-file message, and deletes nothing', async () => {
    const env = setup({ animatedSnips: true });
    await sendBody(env, stillBody());
    await env.bucket.put(keyFor('original.png'), PNG, 'image/png');
    const res = await complete(env);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'objects_missing', message: 'Upload all three images, then call complete again' });
    expect(present(env)).toEqual(['original.png']);
  });

  it('switch off: animation sent with the switch off or unset is dropped unread: 200, three uploads, no animated, nothing stored', async () => {
    const bodies: Array<[string, Record<string, unknown>]> = [
      ['valid animation', contract.presign.with_animation_switch_off.request],
      ...contract.presign.errors.map((e): [string, Record<string, unknown>] => [e.case, patched(contract.presign.with_animation_switch_on.request, e.patch ?? {})]),
      ['animation is a string', { ...contract.presign.still_switch_any.request, animation: 'fast' }],
      ['animation is null', { ...contract.presign.still_switch_any.request, animation: null }],
      ['animation is a list', { ...contract.presign.still_switch_any.request, animation: [1, 2] }],
    ];
    expect(bodies.length).toBeGreaterThan(8);
    const reference = await sendBody(setup({ animatedSnips: false }), contract.presign.still_switch_any.request);
    for (const [, opts] of [['off', { animatedSnips: false }], ['unset', {}]] as Array<[string, Opts]>) {
      for (const [name, body] of bodies) {
        const env = setup({ ...opts });
        const sign = vi.spyOn(env.storage, 'getPresignedCaptureUploadUrl');
        const { res, json } = await sendBody(env, body);
        expect(res.status, name).toBe(200);
        expect(json, name).toEqual(reference.json);
        expect(Object.keys(json.uploads ?? {}), name).toEqual(['original', 'preview', 'agent']);
        expect(json.capture, name).not.toHaveProperty('animated');
        expect(sign.mock.calls.length, name).toBe(3);
        const stored = doc(env, CONTRACT_ID);
        expect(stored, name).toBeDefined();
        expect(stored, name).not.toHaveProperty('animated');
        expect(stored, name).not.toHaveProperty('animation');
        expect(lines.join('\n'), name).not.toContain(String(contract.presign.with_animation_switch_on.request.animation.sha256));
      }
    }
  });

  it('switch off: the contract says what the response is, and it is the still response', () => {
    const off = contract.presign.with_animation_switch_off.response.body;
    expect(off).toEqual(contract.presign.still_switch_any.response.body);
  });
});

// ---- guarantee-4: presign ------------------------------------------------------------------------

describe('guarantee-4 presign accepts and refuses an animation as the contract says (switch on)', () => {
  const request = contract.presign.with_animation_switch_on.request;

  it('a valid animation: 200, four signed PUT URLs, animated:true, and the contract response shape', async () => {
    const env = setup({ animatedSnips: true });
    const sign = vi.spyOn(env.storage, 'getPresignedCaptureUploadUrl');
    const { res, json } = await sendBody(env, patched(request, { captureId: CAPTURE_ID }));
    expect(res.status).toBe(200);
    expect(normalised(json)).toEqual(contract.presign.with_animation_switch_on.response.body);
    expect(Object.keys(json.capture)).toEqual(['captureId', 'status', 'width', 'height', 'bytes', 'sha256', 'expiresAt', 'animated']);
    expect(Object.keys(json.uploads ?? {})).toEqual(['original', 'preview', 'agent', 'animation']);
    const clipUpload = json.uploads!.animation;
    expect(clipUpload).toMatchObject({ key: keyFor('animation.mp4'), contentType: 'video/mp4' });
    const url = new URL(clipUpload.url);
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.hostname).toMatch(/\.r2\.cloudflarestorage\.com$/);
    expect(sign.mock.calls).toHaveLength(4);
    expect(sign.mock.calls[3]).toEqual([keyFor('animation.mp4'), { contentType: 'video/mp4', contentLength: request.animation.bytes, expiresIn: 900 }]);
    // the three stills are signed exactly as before
    for (const [i, [name, type, len]] of [['original.png', 'image/png', request.bytes], ['preview.jpg', 'image/jpeg', request.previewBytes], ['agent.webp', 'image/webp', request.agentBytes]].entries()) {
      expect(sign.mock.calls[i]).toEqual([keyFor(name as string), { contentType: type, contentLength: len, expiresIn: 900 }]);
    }
  });

  it('stores animated and animation on the capture document, exactly as declared', async () => {
    const env = setup({ animatedSnips: true });
    await sendBody(env, patched(request, { captureId: CAPTURE_ID }));
    expect(doc(env)).toMatchObject({ status: 'pending', animated: true, animation: request.animation });
    expect(Object.keys(doc(env)!.animation as object).sort()).toEqual(['bytes', 'durationMs', 'fps', 'height', 'sha256', 'width']);
  });

  it.each(contract.presign.errors)('refusal from the contract: $case', async (e) => {
    const env = setup({ animatedSnips: true });
    const { res, json } = await sendBody(env, patched(request, { ...(e.patch ?? {}), captureId: CAPTURE_ID }));
    expect(res.status).toBe(e.status);
    expect(json.error).toBe(e.body.error);
    if (e.status === 400) expect(json).toMatchObject(e.body);
    if (e.status === 413) expect(json.message).toBe(TOO_LARGE_AT_PRESIGN);
    expect(doc(env)).toBeUndefined();
    expect(env.firestore.captures.size).toBe(0);
    expect(lines.join('\n')).not.toContain('"animation"');
    // names only, never the values the client sent
    expect(JSON.stringify(json)).not.toMatch(/10001|15728641|xyz/);
  });

  it('the boundaries: 500 ms, 10 s, fps 1 and 12 (and in between), 2 px and 1280 px, aspect inside 2 % are all fine', async () => {
    const ok: Array<Record<string, unknown>> = [
      { 'animation.durationMs': 500 },
      { 'animation.durationMs': 10000 },
      { 'animation.fps': 1 },
      { 'animation.fps': 7.5 },
      { 'animation.fps': 12 },
      { 'animation.bytes': 15728640 },
      { 'animation.width': 1278, 'animation.height': 800 },
      { 'animation.width': 1280, 'animation.height': 786 },
    ];
    for (const patch of ok) {
      const env = setup({ animatedSnips: true });
      const { res } = await sendBody(env, patched(request, { ...patch, captureId: CAPTURE_ID }));
      expect(res.status, JSON.stringify(patch)).toBe(200);
    }
    const tiny = setup({ animatedSnips: true });
    const body = { ...stillBody({ width: 4, height: 2, bytes: PNG.byteLength }), animation: declare(clip('clip-valid.mp4'), { width: 4, height: 2 }) };
    expect((await sendBody(tiny, body)).res.status).toBe(200);
  });

  it('what else is refused with a 400 that names animation only: wrong types, odd or tiny sizes, a clip the wrong shape for the picture', async () => {
    const bad: Array<Record<string, unknown>> = [
      { 'animation.fps': 0.5 },
      { 'animation.fps': 0 },
      { 'animation.fps': 'fast' },
      { 'animation.durationMs': 1000.5 },
      { 'animation.durationMs': '3000' },
      { 'animation.bytes': 0 },
      { 'animation.bytes': 1.5 },
      { 'animation.width': 1 },
      { 'animation.height': 1 },
      { 'animation.height': 801 },
      { 'animation.width': 1280, 'animation.height': 1282 },
      { 'animation.width': 1280, 'animation.height': 780 },
      { 'animation.sha256': 'A'.repeat(64) },
      { 'animation.sha256': 'a'.repeat(63) },
    ];
    for (const patch of bad) {
      const env = setup({ animatedSnips: true });
      const { res, json } = await sendBody(env, patched(request, { ...patch, captureId: CAPTURE_ID }));
      expect(res.status, JSON.stringify(patch)).toBe(400);
      expect(json, JSON.stringify(patch)).toMatchObject({ error: 'invalid_request', message: 'The request body is not valid', fields: ['animation'] });
      expect(doc(env)).toBeUndefined();
    }
    for (const value of ['fast', null, 7, [], { bytes: 1 }]) {
      const env = setup({ animatedSnips: true });
      const { res, json } = await sendBody(env, { ...patched(request, { captureId: CAPTURE_ID }), animation: value });
      expect(res.status).toBe(400);
      expect(json.fields).toEqual(['animation']);
    }
  });

  it('a bad animation next to a bad still field names both fields and no values', async () => {
    const env = setup({ animatedSnips: true });
    const { res, json } = await sendBody(env, patched(request, { captureId: CAPTURE_ID, width: 0, 'animation.fps': 13 }));
    expect(res.status).toBe(400);
    expect([...(json.fields ?? [])].sort()).toEqual(['animation', 'width']);
  });

  it('a retry of the same presign gives 200 created:false with the same keys; a different animation under the same id is a 409', async () => {
    const env = setup({ animatedSnips: true });
    const body = patched(request, { captureId: CAPTURE_ID });
    const first = await sendBody(env, body);
    const again = await sendBody(env, body);
    expect(again.res.status).toBe(200);
    expect(again.json.created).toBe(false);
    expect(Object.fromEntries(Object.entries(again.json.uploads ?? {}).map(([k, v]) => [k, v.key]))).toEqual(Object.fromEntries(Object.entries(first.json.uploads ?? {}).map(([k, v]) => [k, v.key])));
    expect(again.json.capture).toMatchObject({ animated: true });

    const change = contract.presign.retry_different_animation;
    for (const patch of [change.change, { 'animation.bytes': 22839 }, { 'animation.durationMs': 3100 }, { 'animation.width': 1278 }, { 'animation.height': 798 }, { 'animation.fps': 11 }]) {
      const other = await sendBody(env, patched(body, patch));
      expect(other.res.status, JSON.stringify(patch)).toBe(change.response.status);
      expect(other.json).toMatchObject({ error: change.response.body.error, message: ID_CONFLICT });
    }
  });

  it('a still retry of a clip capture, and a clip retry of a still capture, are conflicts', async () => {
    const env = setup({ animatedSnips: true });
    await sendBody(env, patched(request, { captureId: CAPTURE_ID }));
    const still = patched(request, { captureId: CAPTURE_ID });
    delete still.animation;
    expect((await sendBody(env, still)).res.status).toBe(409);

    const env2 = setup({ animatedSnips: true });
    await sendBody(env2, still);
    expect((await sendBody(env2, patched(request, { captureId: CAPTURE_ID }))).res.status).toBe(409);
  });

  it('a retry of a clip capture whose animation the switch now drops is a conflict, not a silent still', async () => {
    const opts: Opts = { animatedSnips: true };
    const env = setup(opts);
    await sendBody(env, patched(request, { captureId: CAPTURE_ID }));
    opts.animatedSnips = false;
    const { res, json } = await sendBody(env, patched(request, { captureId: CAPTURE_ID }));
    expect(res.status).toBe(409);
    expect(json.error).toBe('id_conflict');
  });
});

// ---- guarantee-4: complete -----------------------------------------------------------------------

const errorFor = (fragment: string): ErrorCase => {
  const found = contract.complete.errors.find((e) => e.case.includes(fragment));
  if (!found) throw new Error(`no contract complete error for "${fragment}"`);
  return found;
};

/** Presign a clip capture with `declared`, PUT the stills and (unless null) the clip, call complete. */
async function runClip(opts: { bytes: Uint8Array | null; declared?: Partial<Decl> | Decl; declaredFrom?: Uint8Array; contentType?: string; env?: Env }) {
  lines.length = 0;
  const env = opts.env ?? setup({ animatedSnips: true });
  const basis = opts.declaredFrom ?? opts.bytes ?? clip('clip-valid.mp4');
  const decl = declare(basis, opts.declared);
  const presigned = await sendBody(env, stillBody({ animation: decl }));
  expect(presigned.res.status).toBe(200);
  await putStills(env);
  if (opts.bytes) await env.bucket.put(keyFor('animation.mp4'), opts.bytes, opts.contentType ?? 'video/mp4');
  const res = await complete(env);
  return { env, res, json: (await res.json()) as { error?: string; message?: string; capture?: Record<string, unknown> }, decl };
}

function expectRefused(r: Awaited<ReturnType<typeof runClip>>, e: ErrorCase) {
  expect(r.res.status).toBe(e.status);
  expect(r.json).toMatchObject({ error: e.body.error, message: e.body.message.startsWith('<') ? expect.any(String) : e.body.message });
  expect(r.env.bucket.objects.size).toBe(0);
  expect(present(r.env)).toEqual([]);
  expect(doc(r.env)).toMatchObject({ status: 'pending' });
  expect(r.env.queue.send).not.toHaveBeenCalled();
  const refusal = jsonLines().find((l) => l.msg === 'capture refused' || l.message === 'capture refused');
  expect(refusal?.err_code).toBe(`capture_${e.body.error}`);
  // no value the client sent reaches the log
  expect(lines.join('\n')).not.toContain(r.decl.sha256);
}

describe('guarantee-4 complete refuses a clip that is not what the contract allows, and deletes all four objects', () => {
  const FILE_CASES = ['clip-too-long', 'clip-too-fast', 'clip-too-wide', 'clip-with-audio', 'clip-wrong-magic', 'clip-png-named-mp4'].map((name) => ({ name, file: `${name}.mp4` }));

  it.each(FILE_CASES)('$file is refused with the contract code and status', async ({ file }) => {
    const e = errorFor(file);
    expect(e.deletes).toBe(true);
    expectRefused(await runClip({ bytes: clip(file) }), e);
  });

  it('a clip over 15 MB (HEAD says 15,728,641 bytes): 413 too_large, before anything is read, all four deleted', async () => {
    const e = errorFor('mock HEAD 15728641');
    const env = setup({ animatedSnips: true });
    const realHead = env.bucket.head.bind(env.bucket);
    vi.spyOn(env.bucket, 'head').mockImplementation(async (key: string) => (key === keyFor('animation.mp4') ? { size: contract.limits.maxBytes + 1, httpMetadata: { contentType: 'video/mp4' } } : realHead(key)));
    const read = vi.spyOn(env.bucket, 'get');
    const r = await runClip({ bytes: clip('clip-valid.mp4'), env });
    expect(r.res.status).toBe(413);
    expect(r.json.message).toBe(TOO_LARGE_AT_COMPLETE);
    expect(r.json.error).toBe(e.body.error);
    expect(read.mock.calls.filter(([key]) => key === keyFor('animation.mp4'))).toEqual([]);
    expect(present(env)).toEqual([]);
    expect(jsonLines().find((l) => l.err_code === 'capture_too_large')).toBeDefined();
  });

  it('exactly 15,728,640 bytes declared and stored is not too large (the next check decides)', async () => {
    const env = setup({ animatedSnips: true });
    const decl = declare(clip('clip-valid.mp4'), { bytes: contract.limits.maxBytes });
    expect((await sendBody(env, stillBody({ animation: decl }))).res.status).toBe(200);
    await putStills(env);
    await env.bucket.put(keyFor('animation.mp4'), clip('clip-valid.mp4'), 'video/mp4');
    vi.spyOn(env.bucket, 'head').mockImplementation(async (key: string) => (key === keyFor('animation.mp4') ? { size: contract.limits.maxBytes, httpMetadata: { contentType: 'video/mp4' } } : { size: env.bucket.objects.get(key)!.bytes.byteLength, httpMetadata: { contentType: env.bucket.objects.get(key)!.contentType } }));
    const r = await complete(env);
    expect(r.status).not.toBe(413);
  });

  it('the stored size is not the declared size: 422 size_mismatch', async () => {
    const e = errorFor('stored size != animation.bytes');
    const valid = clip('clip-valid.mp4');
    expectRefused(await runClip({ bytes: valid, declared: { bytes: valid.byteLength + 1 } }), e);
    expect((await runClip({ bytes: valid, declared: { bytes: valid.byteLength + 1 } })).json.message).toBe(SIZE_MISMATCH);
  });

  it('the sha256 of the clip is not the declared one: 422 hash_mismatch', async () => {
    const e = errorFor('sha256 of animation.mp4');
    expectRefused(await runClip({ bytes: clip('clip-valid.mp4'), declared: { sha256: '0'.repeat(64) } }), e);
  });

  it('the stored Content-Type is not video/mp4, or the object is empty: 415 not_a_video', async () => {
    const e = errorFor('stored type not video/mp4 or size 0');
    expectRefused(await runClip({ bytes: clip('clip-valid.mp4'), contentType: 'image/png' }), e);
    expectRefused(await runClip({ bytes: clip('clip-valid.mp4'), contentType: 'application/octet-stream' }), e);
    expectRefused(await runClip({ bytes: new Uint8Array(0), declaredFrom: clip('clip-valid.mp4'), declared: { bytes: 1 } }), e);
  });

  it('a video/mp4; codecs parameter is the same media type', async () => {
    const r = await runClip({ bytes: clip('clip-valid.mp4'), contentType: 'Video/MP4; codecs=avc1' });
    expect(r.res.status).toBe(200);
  });

  it('the duration, size or frame rate differ from what was declared: 422 animation_bad_shape', async () => {
    const e = errorFor('measured duration off declared');
    const valid = clip('clip-valid.mp4');
    for (const declared of [{ durationMs: 3200 }, { durationMs: 2800 }, { width: 1278 }, { height: 798 }, { fps: 10 }, { fps: 11.4 }]) {
      expectRefused(await runClip({ bytes: valid, declared }), e);
    }
    // inside the tolerances (100 ms, 0.5 fps) is fine
    for (const declared of [{ durationMs: 3100 }, { durationMs: 2900 }, { fps: 11.6 }]) {
      expect((await runClip({ bytes: valid, declared })).res.status, JSON.stringify(declared)).toBe(200);
    }
  });

  it('a file with no video track, a codec other than H.264, or a moov box over 2 MB: 415 not_a_video', async () => {
    const e = errorFor('moov box > 2 MB or no vide track');
    const valid = clip('clip-valid.mp4');
    // the same clip with the sample entry renamed from avc1 to hvc1 inside moov
    const hevc = valid.slice();
    const at = Buffer.from(hevc).indexOf('avc1', 40);
    expect(at).toBeGreaterThan(40);
    hevc.set(Buffer.from('hvc1'), at);
    expectRefused(await runClip({ bytes: hevc }), e);
    // ftyp, then a moov of 3 MB declared (the bytes after the header are zeros): refused without reading the box
    const head = valid.slice(0, 32);
    const huge = new Uint8Array(32 + 3 * 1024 * 1024);
    huge.set(head, 0);
    new DataView(huge.buffer).setUint32(32, 3 * 1024 * 1024);
    huge.set(Buffer.from('moov'), 36);
    expectRefused(await runClip({ bytes: huge }), e);
  });

  it('the three existing checks come first and keep their codes: a bad original refuses with hash_mismatch and deletes the clip too', async () => {
    const env = setup({ animatedSnips: true });
    const decl = declare(clip('clip-valid.mp4'));
    expect((await sendBody(env, stillBody({ animation: decl, sha256: '1'.repeat(64) }))).res.status).toBe(200);
    await putStills(env);
    await env.bucket.put(keyFor('animation.mp4'), clip('clip-valid.mp4'), 'video/mp4');
    const res = await complete(env);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'hash_mismatch', message: 'The uploaded original does not match the declared sha256' });
    expect(present(env)).toEqual([]);
  });

  it('the clip is not uploaded yet: 409 objects_missing with the four-file message, and nothing is deleted', async () => {
    const e = errorFor('animation.mp4 not uploaded');
    expect(e.deletes).toBe(false);
    const r = await runClip({ bytes: null, declaredFrom: clip('clip-valid.mp4') });
    expect(r.res.status).toBe(409);
    expect(r.json).toMatchObject(e.body);
    expect(present(r.env)).toEqual(['original.png', 'preview.jpg', 'agent.webp']);
    expect(doc(r.env)).toMatchObject({ status: 'pending' });
    // the client uploads it and calls complete again
    await r.env.bucket.put(keyFor('animation.mp4'), clip('clip-valid.mp4'), 'video/mp4');
    const again = await complete(r.env);
    expect(again.status).toBe(200);
  });

  it('a still is missing from a clip capture: the four-file message too', async () => {
    const env = setup({ animatedSnips: true });
    await sendBody(env, stillBody({ animation: declare(clip('clip-valid.mp4')) }));
    await env.bucket.put(keyFor('animation.mp4'), clip('clip-valid.mp4'), 'video/mp4');
    const res = await complete(env);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'objects_missing', message: 'Upload all four files, then call complete again' });
    expect(present(env)).toEqual(['animation.mp4']);
  });

  it('clip-valid passes: 200 ready, animated:true, the contract response shape, fields on the document, four objects kept', async () => {
    const r = await runClip({ bytes: clip('clip-valid.mp4') });
    expect(r.res.status).toBe(200);
    const expected = structuredClone(contract.complete.ok_with_animation.response.body.capture);
    const got = r.json.capture!;
    expect(Object.keys(got)).toEqual(Object.keys(expected));
    expect(got).toMatchObject({ status: 'ready', animated: true, width: W, height: H });
    expect(doc(r.env)).toMatchObject({ status: 'ready', animated: true, animation: r.decl });
    expect(present(r.env)).toEqual([...FILES]);
    expect(r.decl).toMatchObject({ bytes: 22838, sha256: 'b5e8d3064be8c9607e24fcc6f6ab4a3a997124ad42a50c9e1bc03c7e89563b46' });
    expect(lines.join('\n')).not.toContain('capture refused');
  });

  it('clip-moov-at-end passes with its own sha256, reading the media data only once (for the hash)', async () => {
    const bytes = clip('clip-moov-at-end.mp4');
    const env = setup({ animatedSnips: true });
    const r = await runClip({ bytes, env });
    expect(r.res.status).toBe(200);
    expect(r.decl.sha256).toBe('cd2ef665464fe66d6141b6b113d129a93233b11f80dafc013b1787ed10f34e33');
    expect(present(env)).toEqual([...FILES]);
  });

  it('complete is idempotent for a ready clip capture, and still verifies after the switch is turned off (the document decides, not the switch)', async () => {
    const opts: Opts = { animatedSnips: true };
    const env = setup(opts);
    await sendBody(env, stillBody({ animation: declare(clip('clip-too-long.mp4')) }));
    await putStills(env);
    await env.bucket.put(keyFor('animation.mp4'), clip('clip-too-long.mp4'), 'video/mp4');
    opts.animatedSnips = false;
    const res = await complete(env);
    expect(res.status).toBe(422);
    expect((await res.json() as { error: string }).error).toBe('animation_too_long');

    const ok = setup(opts);
    opts.animatedSnips = true;
    await sendBody(ok, stillBody({ animation: declare(clip('clip-valid.mp4')) }));
    await putStills(ok);
    await ok.bucket.put(keyFor('animation.mp4'), clip('clip-valid.mp4'), 'video/mp4');
    opts.animatedSnips = false;
    const first = await complete(ok);
    const second = await complete(ok);
    expect(first.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect(ok.queue.send).not.toHaveBeenCalled();
  });

  it('a failed delete of one object is reported, not thrown, and the refusal still goes out', async () => {
    const env = setup({ animatedSnips: true });
    const realDelete = env.bucket.delete.bind(env.bucket);
    vi.spyOn(env.bucket, 'delete').mockImplementation(async (key: string | string[]) => {
      if (key === keyFor('animation.mp4')) throw new Error('r2 down');
      return realDelete(key);
    });
    const r = await runClip({ bytes: clip('clip-with-audio.mp4'), env });
    expect(r.res.status).toBe(422);
    expect(r.json.error).toBe('animation_has_audio');
    expect(present(env)).toEqual(['animation.mp4']);
  });
});

// ---- the recorded fixture ------------------------------------------------------------------------

describe('recorded fixture for Sync and the UAT seed', () => {
  it('test/fixtures/presign-with-animation.json matches what the server answers (SCRY_RECORD_FIXTURES=1 rewrites it)', async () => {
    const env = setup({ animatedSnips: true });
    const request = contract.presign.with_animation_switch_on.request;
    const res = await post(env.server, presignPath, DEVICE_KEY, request);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PresignJson;
    for (const upload of Object.values(body.uploads!)) upload.url = '<presigned PUT url for the key; 15 minutes>';
    const recorded = { request: { method: 'POST', path: '/captures/{project}/presign', body: request }, response: { status: 200, body } };
    const file = join(FIXTURES, 'presign-with-animation.json');
    const text = JSON.stringify(recorded, null, 2) + '\n';
    if (RECORD) writeFileSync(file, text);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(text));
    expect(Object.keys(body.uploads!)).toEqual(['original', 'preview', 'agent', 'animation']);
  });
});
