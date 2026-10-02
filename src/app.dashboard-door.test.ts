/**
 * dashboard-import PR 1: the dashboard's signed second door on exactly two bundle routes.
 *
 * guarantee-4 (the CLI and every other upload behave exactly as before): the API-key path is
 * unchanged on the two routes, and `X-Scry-Caller` is ignored everywhere else and whenever the
 * secret is unset. guarantee-5 server half: a pending build never reports completed, and a rejected
 * complete through the new door deletes the object and marks the build failed. L5: no log line or
 * error body ever carries the token, the secret or the uid.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, sanitizeSkippedExtCounts, type AppEnv } from './app.js';
import { hashUid, verifyCallerAssertion } from './middleware/dashboard-door.js';
import type { ApiKeyService } from './services/apikey/apikey.service.js';
import type { CreateBuildData, Build } from './services/firestore/firestore.types.js';
import type { FirestoreService } from './services/firestore/firestore.service.js';
import { MockStorageService } from './services/storage/storage.mock.js';
import { zipDirectory, buildZip } from './bundle/__tests__/test-helpers.js';

const FIXTURES_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bundle/__fixtures__');

const SECRET = 'test-only-assertion-secret-0123456789abcdef';
const UID = 'fakeUid_Canary_8f3a91';
const PROJECT = 'acme';
const VERSION = 'import-20261002T101500Z';
const SRC = 'x-adobe-bridge:other';
const REQ_ID = '01J9ZZZZZZZZZZZZZZZZZZZZZZ'.replace(/Z/g, 'A');
const PRESIGN = `/presigned-url/${PROJECT}/${VERSION}/bundle.zip?source=${SRC}`;
const COMPLETE = `/upload/${PROJECT}/${VERSION}/bundle/complete`;

const enc = new TextEncoder();
const b64u = (b: Uint8Array | string) =>
  Buffer.from(typeof b === 'string' ? enc.encode(b) : b).toString('base64url');

interface SignOptions {
  secret?: string;
  alg?: 'HS256' | 'HS512' | 'none';
  claims?: Record<string, unknown>;
  omit?: string[];
}

function baseClaims(nowSec: number): Record<string, unknown> {
  return { sub: UID, aud: 'scry-upload', prj: PROJECT, ver: VERSION, src: SRC, iat: nowSec, exp: nowSec + 30, jti: 'jti-0123456789ab' };
}

async function sign(opts: SignOptions = {}, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const claims: Record<string, unknown> = { ...baseClaims(nowSec), ...(opts.claims ?? {}) };
  for (const k of opts.omit ?? []) delete claims[k];
  const alg = opts.alg ?? 'HS256';
  const head = b64u(JSON.stringify({ alg, typ: 'JWT' }));
  const body = b64u(JSON.stringify(claims));
  if (alg === 'none') return `${head}.${body}.`;
  const hash = alg === 'HS512' ? 'SHA-512' : 'SHA-256';
  const key = await crypto.subtle.importKey('raw', enc.encode(opts.secret ?? SECRET), { name: 'HMAC', hash }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64u(sig)}`;
}

/** In-memory Firestore: enough of the build lifecycle to prove pending vs completed. */
function memoryFirestore() {
  const builds = new Map<string, Build & { bundlePending?: boolean }>();
  const createBuild = vi.fn(async (project: string, data: CreateBuildData) => {
    const n = builds.size + 1;
    const b: Build & { bundlePending?: boolean } = {
      id: `build-${n}`,
      projectId: project,
      versionId: data.versionId,
      buildNumber: n,
      zipUrl: data.zipUrl,
      status: 'active',
      createdAt: new Date(0),
      createdBy: 'test',
      ...(data.source ? { source: data.source, bundlePending: true } : {}),
      ...(data.channel ? { channel: data.channel } : {}),
      ...(data.uploadedByUid ? { uploadedByUid: data.uploadedByUid } : {}),
      ...(data.uploadedByKeyId ? { uploadedByKeyId: data.uploadedByKeyId } : {}),
    };
    builds.set(b.id, b);
    return b;
  });
  const getBuild = vi.fn(async (_p: string, id: string) => builds.get(id) ?? null);
  const updateBuild = vi.fn(async (_p: string, id: string, patch: Partial<Build>) => {
    const b = builds.get(id);
    if (!b) return;
    Object.assign(b, patch);
    if (patch.processingStatus) delete b.bundlePending;
  });
  const updateProcessingStatus = vi.fn(async (_p: string, id: string, status: Build['processingStatus']) => {
    const b = builds.get(id);
    if (!b) return;
    b.processingStatus = status;
    delete b.bundlePending;
  });
  const firestore = { createBuild, getBuild, updateBuild, updateProcessingStatus, trackEvent: vi.fn(async () => undefined) } as unknown as FirestoreService;
  return { firestore, builds, createBuild, updateBuild };
}

interface Setup {
  secret?: string | null;
  validKey?: boolean;
}

function setup(opts: Setup = {}) {
  const storage = new MockStorageService({ baseUrl: 'https://storage.test' });
  const fs = memoryFirestore();
  const validateApiKey = vi.fn(async () =>
    opts.validKey === false
      ? { valid: false, error: 'bad key' }
      : { valid: true, apiKey: { id: 'k1', name: 'ci', prefix: 'scry_proj_' } }
  );
  const apiKeyService = {
    validateApiKey,
    updateLastUsed: vi.fn(async () => undefined),
  } as unknown as ApiKeyService;
  const send = vi.fn(async () => undefined);
  const server = new Hono<AppEnv>();
  server.use('*', async (c, next) => {
    c.set('storage', storage);
    c.set('firestore', fs.firestore);
    c.set('apiKeyService', apiKeyService);
    c.set('processingQueue', { send } as unknown as Queue);
    if (opts.secret !== null) c.set('assertionSecret', opts.secret ?? SECRET);
    await next();
  });
  server.route('/', app);
  return { server, storage, ...fs, validateApiKey, send };
}

const API_KEY = `scry_proj_${PROJECT}_abcdef0123456789`;
const JSON_HDR = { 'Content-Type': 'application/json' };

let logged: string[] = [];
beforeEach(() => {
  logged = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logged.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    });
  }
});
afterEach(() => vi.restoreAllMocks());

const presign = (s: ReturnType<typeof setup>, headers: Record<string, string>, url = PRESIGN) =>
  s.server.request(url, { method: 'POST', headers });

describe('dashboard door: assertion matrix on POST bundle.zip', () => {
  it('accepts a valid assertion: no API key needed, build created with channel + uid, request id adopted', async () => {
    const s = setup();
    const res = await presign(s, { 'X-Scry-Caller': await sign(), 'x-scry-request-id': REQ_ID });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-scry-request-id')).toBe(REQ_ID);
    const body = await res.json();
    expect(body).toMatchObject({ buildId: 'build-1', buildNumber: 1, fields: { key: `${PROJECT}/${VERSION}/builds/1/bundle.zip` } });
    expect(s.validateApiKey).not.toHaveBeenCalled();
    expect(s.createBuild).toHaveBeenCalledWith(
      PROJECT,
      expect.objectContaining({ versionId: VERSION, source: { kind: 'x-adobe-bridge', platform: 'other' }, channel: 'dashboard', uploadedByUid: UID })
    );
    // an API-key field must not be invented for the dashboard door
    expect(s.createBuild.mock.calls[0][1]).not.toHaveProperty('uploadedByKeyId');
  });

  type Case = [string, SignOptions];
  const bad: Case[] = [
    ['expired', { claims: { iat: Math.floor(Date.now() / 1000) - 200, exp: Math.floor(Date.now() / 1000) - 100 } }],
    ['exp more than 60 s after iat', { claims: { iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 90 } }],
    ['exp not after iat', { claims: { iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) - 1 } }],
    ['iat in the future', { claims: { iat: Math.floor(Date.now() / 1000) + 30, exp: Math.floor(Date.now() / 1000) + 60 } }],
    ['signed with another secret', { secret: 'a-different-secret' }],
    ['wrong aud', { claims: { aud: 'scry-search' } }],
    ['aud as an array', { claims: { aud: ['scry-upload'] } }],
    ['wrong prj', { claims: { prj: 'other-project' } }],
    ['wrong ver', { claims: { ver: 'import-other' } }],
    ['src not x-adobe-bridge', { claims: { src: 'storybook:web' } }],
    ['src differs from the request source', { claims: { src: 'x-adobe-bridge:ios' } }],
    ['alg none', { alg: 'none' }],
    ['HS512 with the right secret', { alg: 'HS512' }],
    ['missing jti', { omit: ['jti'] }],
    ['missing sub', { omit: ['sub'] }],
    ['non-integer exp', { claims: { exp: 'soon' } }],
  ];

  it.each(bad)('refuses %s with a single 401 and no build', async (_name, opts) => {
    const s = setup();
    const res = await presign(s, { 'X-Scry-Caller': await sign(opts), 'x-scry-request-id': REQ_ID });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized', request_id: res.headers.get('x-scry-request-id') });
    expect(res.headers.get('x-scry-request-id')).not.toBe(REQ_ID); // an unverified id is never adopted
    expect(s.createBuild).not.toHaveBeenCalled();
    expect(s.validateApiKey).not.toHaveBeenCalled();
  });

  it.each(['abc', 'a.b', 'a.b.c.d', '!!!.@@@.###', ''])('refuses the malformed token %j', async (token) => {
    const s = setup();
    const res = await presign(s, { 'X-Scry-Caller': token });
    expect(res.status).toBe(401);
    expect(s.createBuild).not.toHaveBeenCalled();
  });

  it('a replay inside the lifetime is allowed (documented: no jti store; the cap is the 60 s lifetime)', async () => {
    const s = setup();
    const token = await sign();
    expect((await presign(s, { 'X-Scry-Caller': token })).status).toBe(200);
    expect((await presign(s, { 'X-Scry-Caller': token })).status).toBe(200);
    expect(s.createBuild).toHaveBeenCalledTimes(2);
  });

  it('allows 5 s of clock skew either side and no more', async () => {
    const now = Math.floor(Date.now() / 1000);
    const within = await verifyCallerAssertion(await sign({ claims: { iat: now - 30, exp: now - 3 } }), SECRET, { project: PROJECT, version: VERSION, source: SRC }, now);
    expect(within.ok).toBe(true);
    const beyond = await verifyCallerAssertion(await sign({ claims: { iat: now - 30, exp: now - 6 } }), SECRET, { project: PROJECT, version: VERSION, source: SRC }, now);
    expect(beyond).toEqual({ ok: false, reason: 'expired' });
  });

  it('both headers: a valid assertion wins over a bad API key; a bad assertion never falls through to a good API key', async () => {
    const good = setup({ validKey: false });
    const ok = await presign(good, { 'X-Scry-Caller': await sign(), 'X-API-Key': API_KEY });
    expect(ok.status).toBe(200);
    expect(good.validateApiKey).not.toHaveBeenCalled();

    const s = setup({ validKey: true });
    const res = await presign(s, { 'X-Scry-Caller': await sign({ secret: 'wrong' }), 'X-API-Key': API_KEY });
    expect(res.status).toBe(401);
    expect(s.createBuild).not.toHaveBeenCalled();
    expect(s.validateApiKey).not.toHaveBeenCalled();
  });
});

describe('guarantee-4: the API-key path is unchanged and the header is ignored everywhere else', () => {
  it('an X-API-Key request on the two routes behaves as before (key validated, uploadedByKeyId set, no channel)', async () => {
    const s = setup();
    const res = await presign(s, { 'X-API-Key': API_KEY }, `/presigned-url/${PROJECT}/main/bundle.zip?source=storybook-rn:ios`);
    expect(res.status).toBe(200);
    expect(s.validateApiKey).toHaveBeenCalledTimes(1);
    const data = s.createBuild.mock.calls[0][1];
    expect(data).toMatchObject({ uploadedByKeyId: 'k1' });
    expect(data).not.toHaveProperty('channel');
    expect(data).not.toHaveProperty('uploadedByUid');
  });

  it('an X-API-Key request with no assertion works even when the secret is set', async () => {
    const s = setup();
    expect((await presign(s, { 'X-API-Key': API_KEY })).status).toBe(200);
    expect(s.validateApiKey).toHaveBeenCalledTimes(1);
  });

  it('no secret configured: the header is ignored and the request gets the API-key 401, byte for byte', async () => {
    const withHeader = setup({ secret: null });
    const without = setup({ secret: null });
    const a = await presign(withHeader, { 'X-Scry-Caller': await sign() });
    const b = await presign(without, {});
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    const strip = ({ request_id: _r, ...rest }: Record<string, unknown>) => rest;
    expect(strip(await a.json())).toEqual(strip(await b.json()));
    expect(withHeader.createBuild).not.toHaveBeenCalled();
  });

  it('no secret configured: a valid API key still wins (header ignored, not an error)', async () => {
    const s = setup({ secret: null });
    const res = await presign(s, { 'X-Scry-Caller': await sign(), 'X-API-Key': API_KEY });
    expect(res.status).toBe(200);
    expect(s.createBuild.mock.calls[0][1]).not.toHaveProperty('channel');
  });

  const others: Array<[string, string, string, BodyInit | undefined]> = [
    ['POST /upload/:project/:version', 'POST', `/upload/${PROJECT}/${VERSION}`, new Uint8Array([1, 2, 3])],
    ['POST /upload/:project/:version/coverage', 'POST', `/upload/${PROJECT}/${VERSION}/coverage`, '{}'],
    ['POST /upload/:project/:version/metadata', 'POST', `/upload/${PROJECT}/${VERSION}/metadata`, new Uint8Array([1])],
    ['POST /presigned-url/:project/:version/:filename', 'POST', `/presigned-url/${PROJECT}/${VERSION}/storybook.zip`, '{"contentType":"application/zip"}'],
    ['POST /upload-images/:project', 'POST', `/upload-images/${PROJECT}`, '{"imageCount":1}'],
    ['POST /upload-images/:project/complete', 'POST', `/upload-images/${PROJECT}/complete`, '{"uploadId":"u","zipKey":"k"}'],
    ['GET /upload/:project/:version', 'GET', `/upload/${PROJECT}/${VERSION}`, undefined],
    ['GET on the bundle presign path', 'GET', PRESIGN, undefined],
    ['POST on a sibling of bundle/complete', 'POST', `/upload/${PROJECT}/${VERSION}/bundle/complete/extra`, '{}'],
    ['POST on a sibling of bundle.zip', 'POST', `/presigned-url/${PROJECT}/${VERSION}/bundle.zip.bak?source=${SRC}`, undefined],
  ];

  it.each(others)('%s refuses X-Scry-Caller exactly as it refuses no credentials', async (_n, method, url, body) => {
    const s = setup();
    const token = await sign();
    const withHeader = await s.server.request(url, { method, headers: { 'X-Scry-Caller': token, ...(body ? JSON_HDR : {}) }, body });
    const bare = await s.server.request(url, { method, headers: body ? JSON_HDR : {}, body });
    expect(withHeader.status).toBe(401);
    expect(bare.status).toBe(401);
    const strip = ({ request_id: _r, ...rest }: Record<string, unknown>) => rest;
    expect(strip(await withHeader.json())).toEqual(strip(await bare.json()));
    expect(s.createBuild).not.toHaveBeenCalled();
  });

  it('on another route a valid API key still decides alone, whatever X-Scry-Caller says', async () => {
    const s = setup();
    const res = await s.server.request(`/presigned-url/${PROJECT}/${VERSION}/storybook.zip`, {
      method: 'POST',
      headers: { ...JSON_HDR, 'X-API-Key': API_KEY, 'X-Scry-Caller': 'garbage' },
      body: JSON.stringify({ contentType: 'application/zip' }),
    });
    expect(res.status).toBe(200);
    expect(s.validateApiKey).toHaveBeenCalledTimes(1);
  });
});

describe('complete through the door, and guarantee-5 (server half)', () => {
  async function started(s: ReturnType<typeof setup>) {
    const res = await presign(s, { 'X-Scry-Caller': await sign() });
    const body = await res.json();
    return { buildId: body.buildId as string, key: body.fields.key as string };
  }
  const complete = async (s: ReturnType<typeof setup>, body: unknown, opts: SignOptions = {}, headers: Record<string, string> = {}) =>
    s.server.request(COMPLETE, {
      method: 'POST',
      headers: { ...JSON_HDR, 'X-Scry-Caller': await sign(opts), ...headers },
      body: JSON.stringify(body),
    });

  it('presign creates a bundlePending build that is never reported completed; a missing object leaves it pending', async () => {
    const s = setup();
    const { buildId, key } = await started(s);
    expect(s.builds.get(buildId)).toMatchObject({ bundlePending: true });
    expect(s.builds.get(buildId)?.processingStatus).toBeUndefined();

    const res = await complete(s, { buildId, zipKey: key });
    expect(res.status).toBe(400); // "upload it to the presigned URL first"
    expect(s.builds.get(buildId)?.processingStatus).not.toBe('completed');
    expect(s.builds.get(buildId)?.processingStatus).toBeUndefined();
    expect(s.send).not.toHaveBeenCalled();
  });

  it('accepts a valid bundle: validated, queued, status queued (not completed), skipped counts logged as counts only', async () => {
    const s = setup();
    const { buildId, key } = await started(s);
    await s.storage.upload(key, await zipDirectory(path.join(FIXTURES_ROOT, 'valid-basic')) as never, 'application/zip');
    const res = await complete(s, { buildId, zipKey: key, skippedExtCounts: { psd: 3, tiff: 1, 'EVIL/..': 9, toolongext: 4, heic: -2 } }, {}, { 'x-scry-request-id': REQ_ID });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, queued: true, buildId });
    expect(s.send).toHaveBeenCalledWith(expect.objectContaining({ buildId, format: 'scf', requestId: REQ_ID }));
    expect(s.builds.get(buildId)?.processingStatus).toBe('queued');
    const text = logged.join('\n');
    expect(text).toContain('import_start');
    expect(text).toContain('import_complete');
    expect(text).toContain('import_skip_psd_3');
    expect(text).toContain('import_skip_tiff_1');
    expect(text).not.toContain('EVIL');
    expect(text).not.toContain('toolongext');
    expect(text).not.toContain('heic');
  });

  it('a rejected bundle through the new door: 422, object deleted, build marked failed, nothing queued', async () => {
    const s = setup();
    const { buildId, key } = await started(s);
    await s.storage.upload(key, buildZip([{ name: 'not-a-bundle.txt', data: Buffer.from('hello') }]) as never, 'application/zip');
    const res = await complete(s, { buildId, zipKey: key });
    expect(res.status).toBe(422);
    expect((await res.json()).success).toBe(false);
    expect(await s.storage.head(key)).toBeNull();
    expect(s.builds.get(buildId)?.processingStatus).toBe('failed');
    expect(s.send).not.toHaveBeenCalled();
  });

  it('another user cannot complete a stolen build id (404, same as unknown; object untouched, nothing queued)', async () => {
    const s = setup();
    const { buildId, key } = await started(s);
    await s.storage.upload(key, await zipDirectory(path.join(FIXTURES_ROOT, 'valid-basic')) as never, 'application/zip');
    const stolen = await complete(s, { buildId, zipKey: key }, { claims: { sub: 'someone-else-uid-77' } });
    const unknown = await complete(s, { buildId: 'no-such-build', zipKey: key });
    expect(stolen.status).toBe(404);
    expect(unknown.status).toBe(404);
    const strip = ({ request_id: _r, ...rest }: Record<string, unknown>) => rest;
    expect(strip(await stolen.json())).toEqual(strip(await unknown.json()));
    expect(await s.storage.head(key)).not.toBeNull();
    expect(s.send).not.toHaveBeenCalled();
    expect(s.builds.get(buildId)?.processingStatus).toBeUndefined();
  });

  it('the door cannot complete a build that an API key created', async () => {
    const s = setup();
    const res = await presign(s, { 'X-API-Key': API_KEY }, `/presigned-url/${PROJECT}/${VERSION}/bundle.zip?source=${SRC}`);
    const { buildId, fields } = await res.json();
    await s.storage.upload(fields.key, await zipDirectory(path.join(FIXTURES_ROOT, 'valid-basic')) as never, 'application/zip');
    const out = await complete(s, { buildId, zipKey: fields.key });
    expect(out.status).toBe(404);
    expect(s.send).not.toHaveBeenCalled();
  });

  it('an assertion for another version or project cannot reach complete', async () => {
    const s = setup();
    const { buildId, key } = await started(s);
    expect((await complete(s, { buildId, zipKey: key }, { claims: { ver: 'import-x' } })).status).toBe(401);
    expect((await complete(s, { buildId, zipKey: key }, { claims: { prj: 'other' } })).status).toBe(401);
    expect((await complete(s, { buildId, zipKey: key }, { claims: { src: 'storybook:web' } })).status).toBe(401);
  });

  it('a dashboard assertion for a different signed source cannot complete a build created with another one', async () => {
    const s = setup();
    const { buildId, key } = await started(s); // x-adobe-bridge:other
    const res = await complete(s, { buildId, zipKey: key }, { claims: { src: 'x-adobe-bridge:ios' } });
    expect(res.status).toBe(404);
  });

  it('old API-key complete bodies (no skippedExtCounts) are unchanged and log no import lines', async () => {
    const s = setup();
    const res = await presign(s, { 'X-API-Key': API_KEY }, `/presigned-url/${PROJECT}/main/bundle.zip?source=storybook-rn:ios`);
    const { buildId, fields } = await res.json();
    await s.storage.upload(fields.key, await zipDirectory(path.join(FIXTURES_ROOT, 'valid-basic')) as never, 'application/zip');
    logged.length = 0;
    const out = await s.server.request(`/upload/${PROJECT}/main/bundle/complete`, {
      method: 'POST',
      headers: { ...JSON_HDR, 'X-API-Key': API_KEY },
      body: JSON.stringify({ buildId, zipKey: fields.key }),
    });
    expect(out.status).toBe(200);
    expect(logged.join('\n')).not.toContain('import_');
  });
});

describe('sanitizeSkippedExtCounts: unknown shapes are ignored, never rejected', () => {
  it.each([
    [undefined, {}],
    [null, {}],
    ['psd', {}],
    [[['psd', 3]], {}],
    [{ psd: 3 }, { psd: 3 }],
    [{ PSD: 3 }, {}],
    [{ psd: '3' }, {}],
    [{ psd: 0 }, {}],
    [{ psd: 1.5 }, {}],
    [{ psd: 10 ** 12 }, { psd: 100000 }],
    [{ 'a/b': 1, abcdef: 1, '': 1 }, {}],
  ])('%j -> %j', (input, expected) => {
    expect(sanitizeSkippedExtCounts(input)).toEqual(expected);
  });

  it('keeps at most 20 keys', () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`e${i}`, 1]));
    expect(Object.keys(sanitizeSkippedExtCounts(many))).toHaveLength(20);
  });
});

describe('L5: nothing secret or personal reaches a log line or an error body', () => {
  it('across accepted, denied and rejected requests the token, secret and uid never appear', async () => {
    const s = setup();
    const goodToken = await sign();
    const badToken = await sign({ secret: 'wrong-secret' });
    const bodies: string[] = [];
    for (const headers of [{ 'X-Scry-Caller': goodToken }, { 'X-Scry-Caller': badToken }, { 'X-Scry-Caller': 'x.y.z' }]) {
      const res = await presign(s, headers);
      bodies.push(await res.text());
    }
    const { buildId, key } = (() => {
      const [id] = [...s.builds.keys()];
      return { buildId: id, key: `${PROJECT}/${VERSION}/builds/1/bundle.zip` };
    })();
    await s.storage.upload(key, buildZip([{ name: 'x.txt', data: Buffer.from('x') }]) as never, 'application/zip');
    const res = await s.server.request(COMPLETE, {
      method: 'POST',
      headers: { ...JSON_HDR, 'X-Scry-Caller': await sign() },
      body: JSON.stringify({ buildId, zipKey: key, skippedExtCounts: { psd: 2 } }),
    });
    bodies.push(await res.text());

    const everything = [...logged, ...bodies].join('\n');
    for (const secretish of [goodToken, badToken, SECRET, UID, goodToken.split('.')[1], goodToken.split('.')[2]]) {
      expect(everything).not.toContain(secretish);
    }
    expect(logged.join('\n')).toContain(await hashUid(SECRET, UID)); // the hash is what we do log
  });

  it('canary sweep: route params, query and body fields do not reach a log before the signature verifies', async () => {
    const s = setup();
    const canary = 'CanaryProjectXyz9';
    const res = await s.server.request(`/presigned-url/${canary}/CanaryVersion77/bundle.zip?source=CanarySource55`, {
      method: 'POST',
      headers: { 'X-Scry-Caller': await sign({ secret: 'wrong' }), 'x-scry-client': 'CanaryClient/1.0.0' },
    });
    expect(res.status).toBe(401);
    const text = logged.join('\n') + (await res.text());
    for (const c of [canary, 'CanaryVersion77', 'CanarySource55', 'CanaryClient']) expect(text).not.toContain(c);
    expect(text).toContain('import_denied_signature');
  });

  it('logs the denial reason as a code only', async () => {
    const s = setup();
    await presign(s, { 'X-Scry-Caller': await sign({ claims: { aud: 'x' } }) });
    expect(logged.join('\n')).toContain('import_denied_aud');
  });
});

describe('verifyCallerAssertion', () => {
  it('verifies the signature before it reads any claim (a forged token with junk claims is a signature failure)', async () => {
    const forged = `${b64u('{"alg":"HS256"}')}.${b64u('not json at all')}.${b64u('sig')}`;
    expect(await verifyCallerAssertion(forged, SECRET, { project: PROJECT, version: VERSION })).toEqual({ ok: false, reason: 'signature' });
  });
});

/**
 * Shared fixtures for the dashboard's tests (docs/dashboard-import-contract.md). Generated here from
 * real responses of this service, never hand-written, so the two repos cannot drift: the dashboard's
 * mock upload service and its contract test read these files.
 */
describe('contract fixtures: test-fixtures/dashboard-import/*.json', () => {
  const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures', 'dashboard-import');
  const FIXED_NOW = 1790000000; // 2026-09-21T14:13:20Z, only used for the documented example
  const write = (name: string, value: unknown) => {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(path.join(OUT, name), `${JSON.stringify(value, null, 2)}\n`);
  };
  const clean = async (res: Response) => {
    const body = await res.json();
    // stable placeholders: request id is the dashboard's own (echoed) or a generated one
    if (body && typeof body === 'object' && 'request_id' in body) body.request_id = '<request id>';
    return body;
  };

  it('writes the assertion example and it verifies', async () => {
    const claims = baseClaims(FIXED_NOW);
    const token = await sign({}, FIXED_NOW);
    const verified = await verifyCallerAssertion(token, SECRET, { project: PROJECT, version: VERSION, source: SRC }, FIXED_NOW + 10);
    expect(verified.ok).toBe(true);
    write('assertion.json', {
      note: 'Example only. Signed with the TEST secret below, never a real one. The dashboard signs with SCRY_UPLOAD_ASSERTION_SECRET.',
      header: 'X-Scry-Caller',
      alg: 'HS256',
      testSecret: SECRET,
      claims,
      token,
      lifetimeSeconds: 30,
      maxLifetimeSeconds: 60,
      clockSkewSeconds: 5,
      verifiedAt: FIXED_NOW + 10,
    });
  });

  it('writes start and complete exchanges plus the three refusals', async () => {
    const s = setup();
    const startRes = await presign(s, { 'X-Scry-Caller': await sign(), 'x-scry-request-id': REQ_ID });
    const start = await startRes.json();
    write('start.request.json', { method: 'POST', path: `/presigned-url/${PROJECT}/${VERSION}/bundle.zip?source=${SRC}`, headers: ['X-Scry-Caller', 'x-scry-request-id'] });
    write('start.response.json', { status: startRes.status, body: { ...start, url: '<presigned PUT url>' } });

    await s.storage.upload(start.fields.key, await zipDirectory(path.join(FIXTURES_ROOT, 'valid-basic')) as never, 'application/zip');
    const doneBody = { buildId: start.buildId, zipKey: start.fields.key, skippedExtCounts: { psd: 3, tiff: 1 } };
    const doneRes = await s.server.request(COMPLETE, { method: 'POST', headers: { ...JSON_HDR, 'X-Scry-Caller': await sign() }, body: JSON.stringify(doneBody) });
    write('complete.request.json', { method: 'POST', path: COMPLETE, headers: ['X-Scry-Caller', 'Content-Type'], body: { ...doneBody, buildId: '<buildId from start>' } });
    write('complete.response.json', { status: doneRes.status, body: await doneRes.json() });

    const denied = await presign(setup(), { 'X-Scry-Caller': await sign({ secret: 'wrong' }) });
    write('error.401.json', { status: denied.status, note: 'every refusal is this body; the reason is only in the service log', body: await clean(denied) });

    const s2 = setup();
    const other = await s2.server.request(COMPLETE, { method: 'POST', headers: { ...JSON_HDR, 'X-Scry-Caller': await sign() }, body: JSON.stringify({ buildId: 'no-such-build', zipKey: `${PROJECT}/${VERSION}/builds/1/bundle.zip` }) });
    write('error.404.json', { status: other.status, note: 'unknown build, or a build this caller did not start', body: await clean(other) });

    const s3 = setup();
    const st = await (await presign(s3, { 'X-Scry-Caller': await sign() })).json();
    await s3.storage.upload(st.fields.key, buildZip([{ name: 'not-a-bundle.txt', data: Buffer.from('hello') }]) as never, 'application/zip');
    const rej = await s3.server.request(COMPLETE, { method: 'POST', headers: { ...JSON_HDR, 'X-Scry-Caller': await sign() }, body: JSON.stringify({ buildId: st.buildId, zipKey: st.fields.key }) });
    write('error.422.json', { status: rej.status, note: 'bundle rejected: the object is deleted and the build is marked failed', body: await clean(rej) });
    expect([denied.status, other.status, rej.status]).toEqual([401, 404, 422]);
  });
});
