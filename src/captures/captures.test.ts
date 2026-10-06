/**
 * Scry Snip capture upload routes (feature snip-capture, PR 1).
 * The presign helper is the real R2S3StorageService (real S3 presigner over an in-memory R2 bucket).
 * Guarantee tests are named `guarantee-N-...` so the review can find them.
 * Set SCRY_RECORD_FIXTURES=1 to (re)write the wire-contract fixtures under features/snip-capture/fixtures/upload/.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentry: Array<{ err: unknown; opts?: unknown }> = [];
vi.mock('@sentry/cloudflare', () => ({
  captureException: (err: unknown, opts?: unknown) => {
    sentry.push({ err, opts });
  },
  getCurrentScope: () => ({ setTag: () => undefined }),
  getTraceData: () => ({}),
}));

import { ALLOWED_KEYS } from '../lib/scry-log/schema.js';
import { PRESIGNS_PER_DAY, PRESIGNS_PER_MINUTE } from './rate-limit.js';
import {
  CAPTURE_ID,
  CAPTURE_ID_2,
  CI_KEY,
  DEVICE_KEY,
  OTHER_PROJECT_KEY,
  PLAIN_KEY,
  PROJECT,
  REVOKED_KEY,
  SECOND_DEVICE_KEY,
  fakeJpeg,
  fakePng,
  fakeWebp,
  keyOfPresignedUrl,
  post,
  presignBody,
  setup,
} from './captures.test-support.js';

const NOW = new Date('2026-10-06T14:00:20.000Z');
const RECORD = process.env.SCRY_RECORD_FIXTURES === '1';
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../scry-management/features/snip-capture/fixtures/upload');
const fixtures = new Map<string, unknown>();

/** Save one request/response pair. Keys and signatures are placeholders; the shapes are the contract. */
async function record(name: string, path: string, requestBody: unknown, res: Response, extraResponseHeaders: string[] = []) {
  const body = (await res.clone().json()) as Record<string, unknown>;
  if (body.request_id) body.request_id = '<request id>';
  const headers: Record<string, string> = {};
  for (const h of ['x-scry-request-id', ...extraResponseHeaders]) {
    const v = res.headers.get(h);
    if (v) headers[h] = h === 'x-scry-request-id' ? '<request id>' : v;
  }
  fixtures.set(name, {
    name,
    request: {
      method: 'POST',
      path,
      headers: { 'Content-Type': 'application/json', 'X-API-Key': '<device key: scry_proj_{project}_{secret}>' },
      body: requestBody,
    },
    response: { status: res.status, headers, body: JSON.parse(JSON.stringify(body).replace(/https:\/\/[^"?]+\?[^"]+/g, (u) => redactUrl(u))) },
  });
}
function redactUrl(u: string): string {
  // Keep the host, path and every parameter name; replace the values that vary per request.
  const url = new URL(u);
  const placeholder: Record<string, string> = { 'X-Amz-Credential': '<credential>', 'X-Amz-Date': '<date>', 'X-Amz-Signature': '<signature>', 'x-amz-checksum-crc32': '<crc32>' };
  for (const [name, value] of Object.entries(placeholder)) url.searchParams.set(name, value);
  return url.toString();
}
afterAll(() => {
  if (!RECORD) return;
  mkdirSync(FIXTURE_DIR, { recursive: true });
  for (const [name, value] of fixtures) writeFileSync(join(FIXTURE_DIR, `${name}.json`), JSON.stringify(value, null, 2) + '\n');
});

let lines: string[];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  vi.restoreAllMocks();
  sentry.length = 0;
  lines = [];
  const grab = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  for (const m of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, m).mockImplementation(grab);
});
afterEach(() => vi.useRealTimers());

const jsonLines = () => lines.flatMap((l) => { try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; } });
const PNG = fakePng(1200, 800, 600);
const JPEG = fakeJpeg();
const WEBP = fakeWebp();
const presignPath = `/captures/${PROJECT}/presign`;
const completePath = `/captures/${PROJECT}/complete`;

type Env = ReturnType<typeof setup>;
async function presign(env: Env, overrides: Record<string, unknown> = {}, png = PNG, key = DEVICE_KEY) {
  const res = await post(env.server, presignPath, key, presignBody(png, overrides));
  return { res, json: (await res.clone().json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
/** What the client does with the presigned URLs: PUT each file to its key. */
async function putAll(env: Env, json: any, png: Uint8Array = PNG, jpeg: Uint8Array = JPEG, webp: Uint8Array = WEBP) { // eslint-disable-line @typescript-eslint/no-explicit-any
  await env.bucket.put(json.uploads.original.key, png, 'image/png');
  await env.bucket.put(json.uploads.preview.key, jpeg, 'image/jpeg');
  await env.bucket.put(json.uploads.agent.key, webp, 'image/webp');
}
const complete = (env: Env, key = DEVICE_KEY, captureId = CAPTURE_ID) => post(env.server, completePath, key, { captureId });

describe('presign', () => {
  it('registers a pending capture and returns three real presigned PUT URLs', async () => {
    const env = setup();
    const { res, json } = await presign(env, { note: 'the spacing is off' });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-scry-request-id')).toMatch(/\S/);
    expect(json.created).toBe(true);
    expect(json.capture).toMatchObject({ captureId: CAPTURE_ID, status: 'pending', width: 1200, height: 800, bytes: 600 });
    expect(json.capture.expiresAt).toBe(new Date(NOW.getTime() + 30 * 86_400_000).toISOString());
    for (const [field, name, type] of [['original', 'original.png', 'image/png'], ['preview', 'preview.jpg', 'image/jpeg'], ['agent', 'agent.webp', 'image/webp']] as const) {
      const u = json.uploads[field];
      expect(u.key).toBe(`${PROJECT}/captures/${CAPTURE_ID}/${name}`);
      expect(u.contentType).toBe(type);
      expect(keyOfPresignedUrl(u.url)).toBe(u.key);
      expect(new URL(u.url).searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
      expect(new URL(u.url).hostname).toMatch(/\.r2\.cloudflarestorage\.com$/);
    }
    const doc = await env.firestore.getCapture(PROJECT, CAPTURE_ID);
    expect(doc).toMatchObject({ status: 'pending', capturedByUid: 'uid-ada', deviceId: 'deviceKey1', sharedWith: [], sharedWithOrgIds: [], sharedWithProject: false, note: 'the spacing is off', os: 'mac', mode: 'region', sendMode: 'review', scale: 2 });
    await record('presign-200-created', presignPath, presignBody(PNG, { note: 'the spacing is off' }), res, ['retry-after']);
  });

  it('idempotency: the same captureId returns the same document with fresh URLs, never a second doc', async () => {
    const env = setup();
    const first = await presign(env);
    const second = await presign(env);
    expect(second.res.status).toBe(200);
    expect(second.json.created).toBe(false);
    expect(second.json.capture).toEqual(first.json.capture);
    expect(second.json.uploads.original.key).toBe(first.json.uploads.original.key);
    expect(env.firestore.captures.size).toBe(1);
    expect(env.firestore.writes.filter((w) => w.includes('/captures/') && !w.includes('captureLimits'))).toHaveLength(1);
    await record('presign-200-repeated', presignPath, presignBody(PNG), second.res);
  });

  it('a ready capture is final: presign again answers 200 with uploads null (no URL to overwrite it)', async () => {
    const env = setup();
    const { json } = await presign(env);
    await putAll(env, json);
    expect((await complete(env)).status).toBe(200);
    const again = await presign(env);
    expect(again.res.status).toBe(200);
    expect(again.json.capture.status).toBe('ready');
    expect(again.json.uploads).toBeNull();
    await record('presign-200-already-ready', presignPath, presignBody(PNG), again.res);
  });

  it('409 when the id is reused with other declared values or by another person', async () => {
    const env = setup();
    await presign(env);
    const other = await presign(env, { width: 999 });
    expect(other.res.status).toBe(409);
    expect(other.json.error).toBe('id_conflict');
    const stranger = await presign(env, {}, PNG, SECOND_DEVICE_KEY);
    expect(stranger.res.status).toBe(409);
    expect(JSON.stringify(stranger.json)).not.toContain('uid-ada');
    await record('presign-409-id-conflict', presignPath, presignBody(PNG, { width: 999 }), other.res);
  });

  it('413 when the original is larger than 20 MB, before anything is written', async () => {
    const env = setup();
    const { res, json } = await presign(env, { bytes: 20 * 1024 * 1024 + 1 });
    expect(res.status).toBe(413);
    expect(json.error).toBe('too_large');
    expect(env.firestore.captures.size).toBe(0);
    const ok = await presign(env, { bytes: 20 * 1024 * 1024 });
    expect(ok.res.status).toBe(200);
    await record('presign-413-too-large', presignPath, presignBody(PNG, { bytes: 20 * 1024 * 1024 + 1 }), res);
  });

  it('400 for malformed JSON and bad fields; the body names fields only, never values', async () => {
    const env = setup();
    const notJson = await post(env.server, presignPath, DEVICE_KEY, '{nope');
    expect(notJson.status).toBe(400);
    const bad = await post(env.server, presignPath, DEVICE_KEY, presignBody(PNG, { captureId: 'not-a-uuid-CANARYVALUE', os: 'linux', sha256: 'zz', note: 'x'.repeat(2001) }));
    expect(bad.status).toBe(400);
    const json = (await bad.clone().json()) as { error: string; fields: string[] };
    expect(json.error).toBe('invalid_request');
    expect(json.fields.sort()).toEqual(['captureId', 'note', 'os', 'sha256']);
    expect(JSON.stringify(json)).not.toContain('CANARYVALUE');
    for (const body of [presignBody(PNG, { captureId: '0192f3a4-7b5c-4d2e-8f10-3a4b5c6d7e8f' }), presignBody(PNG, { width: 0 }), presignBody(PNG, { width: 20000 }), presignBody(PNG, { mode: 'fullscreen' }), presignBody(PNG, { sendMode: 'now' })]) {
      expect((await post(env.server, presignPath, DEVICE_KEY, body)).status).toBe(400);
    }
    expect(env.firestore.captures.size).toBe(0);
    await record('presign-400-invalid-request', presignPath, presignBody(PNG, { captureId: 'not-a-uuid', os: 'linux' }), bad);
  });
});

describe('complete', () => {
  it('verifies the three objects and the sha256, then sets status ready with receivedAt', async () => {
    const env = setup();
    const { json } = await presign(env);
    await putAll(env, json);
    const res = await complete(env);
    expect(res.status).toBe(200);
    const body = (await res.clone().json()) as { capture: { status: string; receivedAt: string } };
    expect(body.capture.status).toBe('ready');
    expect(body.capture.receivedAt).toBe(NOW.toISOString());
    expect((await env.firestore.getCapture(PROJECT, CAPTURE_ID))?.status).toBe('ready');
    const again = await complete(env);
    expect(again.status).toBe(200);
    await record('complete-200-ready', completePath, { captureId: CAPTURE_ID }, res);
  });

  it('409 when an object has not been uploaded yet, and the capture stays pending', async () => {
    const env = setup();
    const { json } = await presign(env);
    await env.bucket.put(json.uploads.original.key, PNG, 'image/png');
    const res = await complete(env);
    expect(res.status).toBe(409);
    expect(((await res.clone().json()) as { error: string }).error).toBe('objects_missing');
    expect((await env.firestore.getCapture(PROJECT, CAPTURE_ID))?.status).toBe('pending');
    await record('complete-409-objects-missing', completePath, { captureId: CAPTURE_ID }, res);
  });

  it('413 when an uploaded object is over its limit; the objects are removed', async () => {
    const env = setup();
    const { json } = await presign(env);
    await putAll(env, json, PNG, fakeJpeg(2 * 1024 * 1024 + 1));
    const res = await complete(env);
    expect(res.status).toBe(413);
    expect(env.bucket.objects.size).toBe(0);
    expect((await env.firestore.getCapture(PROJECT, CAPTURE_ID))?.status).toBe('pending');
    await record('complete-413-too-large', completePath, { captureId: CAPTURE_ID }, res);
  });

  it('415 for bad magic bytes in any of the three objects (a JPEG sent as the PNG, text as the WebP)', async () => {
    for (const [png, jpeg, webp] of [
      [JPEG, JPEG, WEBP],
      [PNG, WEBP, WEBP],
      [PNG, JPEG, new TextEncoder().encode('<html>not an image at all, just text bytes</html>')],
      [PNG, JPEG, JPEG],
    ] as Uint8Array[][]) {
      const env = setup();
      const { json } = await presign(env);
      await putAll(env, json, png, jpeg, webp);
      const res = await complete(env);
      expect(res.status).toBe(415);
      expect(((await res.clone().json()) as { error: string }).error).toBe('not_an_image');
      expect(env.bucket.objects.size).toBe(0);
    }
    const env = setup();
    const { json } = await presign(env);
    await putAll(env, json, PNG, JPEG, new TextEncoder().encode('<html>not an image at all, just text bytes</html>'));
    await record('complete-415-not-an-image', completePath, { captureId: CAPTURE_ID }, await complete(env));
  });

  it('422 when the declared size, dimensions or sha256 do not match the upload', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['size_mismatch', { bytes: 601 }],
      ['dimensions_mismatch', { width: 1201 }],
      ['hash_mismatch', { sha256: 'a'.repeat(64) }],
    ];
    for (const [code, override] of cases) {
      const env = setup();
      const { json } = await presign(env, override);
      await putAll(env, json);
      const res = await complete(env);
      expect(res.status).toBe(422);
      const body = (await res.clone().json()) as { error: string };
      expect(body.error).toBe(code);
      expect(env.bucket.objects.size).toBe(0);
      if (code === 'hash_mismatch') await record('complete-422-hash-mismatch', completePath, { captureId: CAPTURE_ID }, res);
    }
    // same length, different bytes: only the hash can tell
    const env = setup();
    const swapped = fakePng(1200, 800, 600);
    swapped[100] ^= 0xff;
    const { json } = await presign(env);
    await putAll(env, json, swapped);
    expect((await complete(env)).status).toBe(422);
  });

  it('404 for an unknown capture and for another person\'s capture; 400 for a bad body', async () => {
    const env = setup();
    await presign(env);
    const unknown = await complete(env, DEVICE_KEY, CAPTURE_ID_2);
    expect(unknown.status).toBe(404);
    const theirs = await complete(env, SECOND_DEVICE_KEY);
    expect(theirs.status).toBe(404);
    const { request_id: _a, ...theirBody } = (await theirs.clone().json()) as Record<string, unknown>;
    const { request_id: _b, ...unknownBody } = (await unknown.clone().json()) as Record<string, unknown>;
    expect(theirBody).toEqual(unknownBody);
    const bad = await post(env.server, completePath, DEVICE_KEY, { captureId: 'nope' });
    expect(bad.status).toBe(400);
    await record('complete-404-not-found', completePath, { captureId: CAPTURE_ID_2 }, unknown);
  });
});

describe('rate limits', () => {
  const minute = Math.floor(NOW.getTime() / 60_000);

  it('30 presigns per minute per key: the 31st is 429 with Retry-After to the end of the minute', async () => {
    const env = setup();
    for (let i = 0; i < PRESIGNS_PER_MINUTE; i++) expect((await presign(env)).res.status).toBe(200);
    const { res, json } = await presign(env);
    expect(res.status).toBe(429);
    expect(json.error).toBe('rate_limited');
    expect(res.headers.get('retry-after')).toBe('40');
    // another key is not affected
    expect((await presign(env, {}, PNG, SECOND_DEVICE_KEY)).res.status).toBe(409); // reaches the handler (id taken), not 429
    await record('presign-429-rate-limited', presignPath, presignBody(PNG), res, ['retry-after']);
  });

  it('the minute window moves on', async () => {
    const env = setup();
    env.firestore.counters.set(`${PROJECT}/deviceKey1_m_${minute}`, PRESIGNS_PER_MINUTE);
    expect((await presign(env)).res.status).toBe(429);
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    expect((await presign(env)).res.status).toBe(200);
  });

  it('2,000 presigns per day per key: refused with Retry-After to the end of the UTC day', async () => {
    const env = setup();
    env.firestore.counters.set(`${PROJECT}/deviceKey1_d_${Math.floor(NOW.getTime() / 86_400_000)}`, PRESIGNS_PER_DAY);
    const { res } = await presign(env);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe(String(9 * 3600 + 59 * 60 + 40));
    // a refusal on the day limit leaves no capture behind
    expect(env.firestore.captures.size).toBe(0);
  });

  it('counter documents expire (TTL field) and a minute refusal does not spend the day budget', async () => {
    const env = setup();
    env.firestore.counters.set(`${PROJECT}/deviceKey1_m_${minute}`, PRESIGNS_PER_MINUTE);
    await presign(env);
    expect([...env.firestore.counters.keys()].some((k) => k.includes('_d_'))).toBe(false);
  });
});

describe('guarantee-4-capture-upload-keys', () => {
  it('a revoked key gets 401, an unknown or missing key 401', async () => {
    const env = setup();
    for (const path of [presignPath, completePath]) {
      const body = path === presignPath ? presignBody(PNG) : { captureId: CAPTURE_ID };
      const revoked = await post(env.server, path, REVOKED_KEY, body);
      expect(revoked.status).toBe(401);
      expect((await post(env.server, path, undefined, body)).status).toBe(401);
      expect((await post(env.server, path, 'garbage', body)).status).toBe(401);
      if (path === presignPath) await record('presign-401-revoked-key', path, body, revoked);
    }
    expect(env.firestore.captures.size).toBe(0);
  });

  it('another project\'s device key gets 403 and touches nothing', async () => {
    const env = setup();
    for (const path of [presignPath, completePath]) {
      const body = path === presignPath ? presignBody(PNG) : { captureId: CAPTURE_ID };
      const res = await post(env.server, path, OTHER_PROJECT_KEY, body);
      expect(res.status).toBe(403);
      if (path === presignPath) await record('presign-403-other-project', path, body, res);
    }
    expect(env.firestore.captures.size).toBe(0);
    expect(env.firestore.counters.size).toBe(0);
  });

  it('only a device key may use the capture routes: ordinary and CI keys get 403', async () => {
    const env = setup();
    for (const key of [PLAIN_KEY, CI_KEY]) {
      const res = await post(env.server, presignPath, key, presignBody(PNG));
      expect(res.status).toBe(403);
    }
    expect(env.firestore.captures.size).toBe(0);
  });

  it('a device key reaches only its own captures: another owner\'s capture answers 404', async () => {
    const env = setup();
    await presign(env);
    expect((await complete(env, SECOND_DEVICE_KEY)).status).toBe(404);
  });

  it('every non-capture route stays denied to a device key', async () => {
    const env = setup();
    const refused: Array<[string, string]> = [
      ['POST', `/presigned-url/${PROJECT}/v1/storybook.zip`],
      ['POST', `/presigned-url/${PROJECT}/v1/index.html`],
      ['POST', `/upload/${PROJECT}/v1/metadata`],
      ['POST', `/upload/${PROJECT}/v1/complete`],
      ['POST', `/upload-images/${PROJECT}/v1/shot.png`],
      ['GET', `/captures/${PROJECT}/presign`],
      ['POST', `/captures/${PROJECT}/other`],
      ['POST', `/captures/${PROJECT}/presign/extra`],
    ];
    for (const [method, path] of refused) {
      const res = await env.server.request(path, { method, headers: { 'X-API-Key': DEVICE_KEY, 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
      expect(res.status, `${method} ${path}`).not.toBe(200);
      expect([401, 403, 404, 405], `${method} ${path}`).toContain(res.status);
    }
    expect(env.firestore.captures.size).toBe(0);
    expect(env.bucket.objects.size).toBe(0);
  });

  it('the allow-list gained exactly the two capture paths', async () => {
    const { deviceKeyMayUse } = await import('../middleware/auth.js');
    expect(deviceKeyMayUse('POST', `/captures/${PROJECT}/presign`)).toBe(true);
    expect(deviceKeyMayUse('POST', `/captures/${PROJECT}/complete`)).toBe(true);
    for (const [m, p] of [['GET', `/captures/${PROJECT}/presign`], ['POST', `/captures/${PROJECT}/delete`], ['POST', `/captures/${PROJECT}/presign/x`], ['POST', '/captures//presign'], ['DELETE', `/captures/${PROJECT}/complete`]]) {
      expect(deviceKeyMayUse(m, p), `${m} ${p}`).toBe(false);
    }
  });
});

describe('guarantee-3-captures-are-not-builds', () => {
  it('a full presign + upload + complete writes no build, no upload row, no queue message, nothing outside captures', async () => {
    const env = setup();
    const { json } = await presign(env);
    await putAll(env, json);
    expect((await complete(env)).status).toBe(200);
    expect(env.firestore.createBuild).not.toHaveBeenCalled();
    expect(env.firestore.updateBuild).not.toHaveBeenCalled();
    expect(env.firestore.createUpload).not.toHaveBeenCalled();
    expect(env.queue.send).not.toHaveBeenCalled();
    expect(env.firestore.writes.length).toBeGreaterThan(0);
    for (const w of env.firestore.writes) expect(w).toMatch(new RegExp(`^projects/${PROJECT}/capture(s|Limits)/`));
    for (const k of env.bucket.objects.keys()) expect(k.startsWith(`${PROJECT}/captures/${CAPTURE_ID}/`)).toBe(true);
    expect(env.bucket.objects.size).toBe(3);
  });

  it('the route code imports no build, queue, Milvus or image-processing module, and calls no build write', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const imports = (file: string) => [...readFileSync(join(dir, file), 'utf8').matchAll(/^import[^;]*?from '([^']+)';/gms)].map((m) => m[1]);
    const allowed = new Set(['@hono/zod-openapi', 'hono', 'node:crypto', '../lib/log.js', '../middleware/auth.js', '../app.js', '../services/firestore/firestore.types.js', '../services/firestore/firestore.service.js', './image-check.js', './rate-limit.js']);
    for (const file of ['captures.ts', 'image-check.ts', 'rate-limit.ts']) {
      for (const spec of imports(file)) expect(allowed.has(spec), `${file} imports ${spec}`).toBe(true);
    }
    const src = readFileSync(join(dir, 'captures.ts'), 'utf8');
    for (const banned of ['createBuild', 'updateBuild', 'createUpload', 'processingQueue', '.send(']) expect(src.includes(banned), banned).toBe(false);
  });
});

describe('guarantee-6-no-sensitive-values-in-logs', () => {
  const CANARIES = ['CANARYNOTE', 'CANARYAPP', 'CANARYWINDOW', 'CANARYFILE', 'CANARYCLIENT', 'CANARYPROJ', 'CANARYBODYVALUE'];
  const hdrs = { host: 'canaryhost.example', 'x-scry-client': 'CANARYCLIENT/1.0', 'user-agent': 'CANARYCLIENT/1.0', 'x-scry-request-id': '01J9ZZZZZZZZZZZZZZZZZZZZZZ' };

  function expectClean() {
    const all = lines.join('\n') + JSON.stringify(sentry.map((s) => s.opts));
    for (const c of CANARIES) expect(all, c).not.toContain(c);
    expect(all.toLowerCase()).not.toContain('canaryhost');
    for (const l of jsonLines().filter((x) => x.v === 1)) {
      for (const k of Object.keys(l)) expect(ALLOWED_KEYS, `key ${k}`).toContain(k);
      expect(l.msg).not.toBe('[invalid]');
      expect(l.err_code).not.toBe('[invalid]');
    }
  }
  const send = (path: string, key: string | undefined, body: unknown, server: ReturnType<typeof setup>['server']) => post(server, path, key, body, hdrs);

  it('success path logs the capture id and the request id only', async () => {
    const env = setup();
    const body = presignBody(PNG, { note: 'CANARYNOTE app CANARYAPP window CANARYWINDOW file CANARYFILE.png' });
    const res = await send(presignPath, DEVICE_KEY, body, env.server);
    const json = (await res.clone().json()) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    await putAll(env, json);
    const completed = await send(completePath, DEVICE_KEY, { captureId: CAPTURE_ID }, env.server);
    const mine = jsonLines().filter((l) => String(l.msg).startsWith('capture'));
    expect(mine.map((l) => l.msg)).toEqual(['capture presigned', 'capture completed']);
    // the request id is minted by the service (a caller-supplied one is never adopted) and echoed in the header
    const ids = [res.headers.get('x-scry-request-id'), completed.headers.get('x-scry-request-id')];
    expect(ids[0]).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ids).not.toContain('01J9ZZZZZZZZZZZZZZZZZZZZZZ');
    mine.forEach((l, i) => {
      expect(l.run_id).toBe(CAPTURE_ID);
      expect(l.request_id).toBe(ids[i]);
      expect(l.project).toBe(PROJECT);
      expect(l.status).toBe(200);
    });
    expectClean();
    if (RECORD) fixtures.set('sample-log-line', mine[0]);
  });

  it('refusals (400, 401, 403, 409, 413, 415, 422, 429, 500) never log a client string', async () => {
    const env = setup();
    const evilProject = 'CANARYPROJ';
    // pre-auth: unknown key against a canary project path, then a revoked key
    await send(`/captures/${evilProject}/presign`, `scry_proj_${evilProject}_x`, presignBody(PNG, { note: 'CANARYNOTE' }), env.server);
    await send(presignPath, REVOKED_KEY, presignBody(PNG, { note: 'CANARYNOTE' }), env.server);
    await send(presignPath, OTHER_PROJECT_KEY, presignBody(PNG, { note: 'CANARYNOTE' }), env.server);
    await send(presignPath, PLAIN_KEY, presignBody(PNG, { note: 'CANARYNOTE' }), env.server);
    // post-auth: bad body with canary values, oversize, conflict, mismatches
    await send(presignPath, DEVICE_KEY, presignBody(PNG, { os: 'CANARYBODYVALUE', note: 'CANARYNOTE' }), env.server);
    await send(presignPath, DEVICE_KEY, presignBody(PNG, { bytes: 30_000_000, note: 'CANARYNOTE' }), env.server);
    const ok = await send(presignPath, DEVICE_KEY, presignBody(PNG, { note: 'CANARYNOTE' }), env.server);
    await send(presignPath, DEVICE_KEY, presignBody(PNG, { width: 5, note: 'CANARYNOTE' }), env.server);
    await send(completePath, DEVICE_KEY, { captureId: CAPTURE_ID }, env.server); // 409 missing
    await putAll(env, (await ok.json()) as any, JPEG); // eslint-disable-line @typescript-eslint/no-explicit-any
    await send(completePath, DEVICE_KEY, { captureId: CAPTURE_ID }, env.server); // 415
    env.firestore.counters.set(`${PROJECT}/deviceKey1_m_${Math.floor(NOW.getTime() / 60_000)}`, 99);
    await send(presignPath, DEVICE_KEY, presignBody(PNG, { note: 'CANARYNOTE' }), env.server); // 429
    const statuses = jsonLines().map((l) => l.status).filter(Boolean);
    expect(new Set(statuses)).toEqual(new Set([400, 401, 403, 409, 413, 415, 429, 200].filter((s) => statuses.includes(s))));
    expect(statuses).toEqual(expect.arrayContaining([400, 409, 413, 415, 429]));
    expectClean();
  });

  it('a failing store logs a fixed message and a code, not the error text or the note', async () => {
    const env = setup();
    env.firestore.createCaptureIfAbsent = async () => { throw new Error('store said CANARYNOTE CANARYAPP'); };
    const res = await send(presignPath, DEVICE_KEY, presignBody(PNG, { note: 'CANARYNOTE' }), env.server);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.clone().json())).not.toContain('CANARY');
    const errLine = jsonLines().find((l) => l.err_code === 'capture_presign_failed');
    expect(errLine).toBeDefined();
    expect(errLine!.run_id).toBeUndefined();
    expectClean();
  });

  it('the sample line is schema v1 with every key in the allow-list', async () => {
    const env = setup();
    await send(presignPath, DEVICE_KEY, presignBody(PNG), env.server);
    const line = jsonLines().find((l) => l.msg === 'capture presigned')!;
    expect(line).toMatchObject({ v: 1, level: 'info', service: 'upload', msg: 'capture presigned', run_id: CAPTURE_ID, project: PROJECT, status: 200 });
    expect(line.request_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
