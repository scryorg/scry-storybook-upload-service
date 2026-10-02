/**
 * scry-sync server-side guarantees for the Scry Sync desktop key.
 *
 * guarantee-1-device-key-scope: a `kind: 'device'` key may presign a bundle, complete it and revoke
 * itself for its own project, and nothing else (no read, list, legacy upload, coverage, metadata,
 * images), and never for another project.
 * guarantee-5-revoke-stops-upload: after `DELETE /keys/self` the very next presign is refused.
 * guarantee-8-credential-only-in-keychain (server side): the key value never appears in a log line.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { app, type AppEnv } from '../app.js';
import type { ApiKeyService } from '../services/apikey/apikey.service.js';
import type { FirestoreService } from '../services/firestore/firestore.service.js';
import type { StorageService } from '../services/storage/storage.service.js';
import { SELF_REVOKED_BY } from './self-revoke.js';
import { deviceKeyMayUse, isRestrictedKeyKind } from '../middleware/auth.js';
import { MockStorageService } from '../services/storage/storage.mock.js';
import { buildZip } from '../bundle/__tests__/test-helpers.js';

const DEVICE_KEY = 'scry_proj_studio_DeViCeSeCrEtVaLuE0123456789';
const OTHER_KEY = 'scry_proj_other_DeViCeSeCrEtVaLuE0123456789';

/** A key store that behaves like Firestore: validate matches only status 'active'. */
type SetupOpts = {
  /** The key document's `kind` exactly as the key service would hand it on (any type). Default 'device'. */
  kind?: unknown;
  /** The key document has no `kind` field at all (a CI / legacy key). */
  noKind?: boolean;
  validateThrows?: boolean;
  revokeThrows?: boolean;
  /** The `source` stored on the build the complete call finds (default x-scry-sync:other). `null` = no source. */
  buildSource?: { kind: string; platform: string } | null;
  storage?: StorageService;
  queue?: { send: (payload: unknown) => Promise<void> };
  withoutKeyService?: boolean;
};

function setup(opts: SetupOpts = {}) {
  const keys = new Map<string, { id: string; projectId: string; status: string; kind?: unknown; hasKind: boolean }>([
    [DEVICE_KEY, { id: 'dev1', projectId: 'studio', status: 'active', kind: opts.kind ?? 'device', hasKind: !opts.noKind }],
  ]);
  const storage: StorageService = opts.storage ?? {
    upload: vi.fn(async (key: string) => ({ url: `https://r2.example/${key}`, key })),
    getPresignedUploadUrl: vi.fn(async (key: string) => ({ url: `https://signed.example/${key}?s=1`, key })),
    head: vi.fn(async () => ({ size: 3 })),
    getObjectStream: vi.fn(),
    getObjectRange: vi.fn(),
    delete: vi.fn(),
    deleteByPrefix: vi.fn(),
  } as unknown as StorageService;
  const build = {
    id: 'b1', projectId: 'studio', versionId: 'sync-1', buildNumber: 1, zipUrl: 'z',
    status: 'active', createdAt: new Date(), createdBy: 't',
    ...(opts.buildSource === null ? {} : { source: opts.buildSource ?? { kind: 'x-scry-sync', platform: 'other' } }),
  };
  const firestore = {
    createBuild: vi.fn(async () => build),
    getBuild: vi.fn(async () => build),
    getProjectBuilds: vi.fn(async () => []),
    getBuildByVersion: vi.fn(async () => build),
    getLatestBuild: vi.fn(async () => build),
    updateBuild: vi.fn(async () => undefined),
    updateBuildCoverage: vi.fn(async () => undefined),
    updateProcessingStatus: vi.fn(async () => undefined),
    archiveBuild: vi.fn(async () => undefined),
    deleteBuild: vi.fn(async () => undefined),
    createUpload: vi.fn(async () => ({ id: 'u1', uploadNumber: 1 })),
    getUpload: vi.fn(async () => null),
    getProjectUploads: vi.fn(async () => []),
    updateUploadProcessingStatus: vi.fn(async () => undefined),
    deleteUpload: vi.fn(async () => undefined),
    trackEvent: vi.fn(async () => undefined),
  } as unknown as FirestoreService;
  const apiKeyService = {
    createApiKey: vi.fn(),
    validateApiKey: vi.fn(async (projectId: string, raw: string) => {
      if (opts.validateThrows) throw new Error('firestore down');
      const k = keys.get(raw);
      if (!k || k.projectId !== projectId || k.status !== 'active') return { valid: false, error: 'Invalid or revoked API key' };
      return { valid: true, apiKey: { id: k.id, name: 'Scry Sync', prefix: 'scry_proj_st', ...(k.hasKind ? { kind: k.kind } : {}) } };
    }),
    listApiKeys: vi.fn(),
    revokeApiKey: vi.fn(async (projectId: string, id: string) => {
      if (opts.revokeThrows) throw new Error('firestore down');
      for (const k of keys.values()) if (k.projectId === projectId && k.id === id) k.status = 'revoked';
    }),
    deleteApiKey: vi.fn(),
    updateLastUsed: vi.fn(async () => undefined),
  } as unknown as ApiKeyService;

  const server = new Hono<AppEnv>();
  server.use('*', async (c, next) => {
    c.set('storage', storage);
    c.set('firestore', firestore);
    if (opts.queue) c.set('processingQueue', opts.queue as unknown as Queue);
    if (!opts.withoutKeyService) c.set('apiKeyService', apiKeyService);
    await next();
  });
  server.route('/', app);
  return { server, firestore, storage, apiKeyService, keys };
}

const JSON_BODY = (b: unknown) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
const ZIP = { headers: { 'Content-Type': 'application/zip' }, body: new Uint8Array([1, 2, 3]) };
const PRESIGN = '/presigned-url/studio/sync-1/bundle.zip?source=x-scry-sync:other';
const COMPLETE = '/upload/studio/sync-1/bundle/complete';
const ZIP_KEY = 'studio/sync-1/builds/1/bundle.zip';
const COMPLETE_BODY = { buildId: 'b1', zipKey: ZIP_KEY };

// A real 1x1 PNG: the vendored validator reads the image dimensions from the header.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');

/** A storage holding one real bundle at the key complete reads; `kind`/`platform` go in its scf.json. */
function syncStorage(source: { kind: string; platform: string } = { kind: 'x-scry-sync', platform: 'other' }): MockStorageService {
  const storage = new MockStorageService();
  storage.seed(
    ZIP_KEY,
    buildZip([
      { name: 'scf.json', data: Buffer.from(JSON.stringify({ scf: '1.0', source, captures: [{ id: 'p2', image: 'images/p2.png' }] })) },
      { name: 'images/p2.png', data: PNG },
    ])
  );
  return storage;
}

function req(server: Hono<AppEnv>, method: string, path: string, init: { headers?: Record<string, string>; body?: BodyInit } = {}, key: string | null = DEVICE_KEY) {
  return server.request(path, {
    method,
    ...init,
    headers: { ...(init.headers ?? {}), ...(key ? { 'X-API-Key': key } : {}) },
  });
}

let logged: string[] = [];
beforeEach(() => {
  vi.restoreAllMocks();
  logged = [];
  const capture = (...args: unknown[]) => { logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'info').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  vi.spyOn(console, 'debug').mockImplementation(capture);
});

describe('guarantee-1-device-key-scope', () => {
  it('a device key can presign a sync bundle for its own project', async () => {
    const { server, storage } = setup();
    const res = await req(server, 'POST', PRESIGN);
    expect(res.status).toBe(200);
    expect(storage.getPresignedUploadUrl).toHaveBeenCalled();
  });

  it('a device key completes a sync bundle for its own project (200, queued)', async () => {
    const send = vi.fn(async () => undefined);
    const { server, apiKeyService } = setup({ storage: syncStorage(), queue: { send } });
    const res = await req(server, 'POST', COMPLETE, JSON_BODY(COMPLETE_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, queued: true, buildId: 'b1' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(apiKeyService.validateApiKey).toHaveBeenCalledWith('studio', DEVICE_KEY);
  });

  const REFUSED: Array<{ name: string; method: string; path: string; init: { headers?: Record<string, string>; body?: BodyInit } }> = [
    { name: 'GET /upload/:project/:version (read)', method: 'GET', path: '/upload/studio/v1', init: {} },
    { name: 'POST /upload/:project/:version (legacy upload)', method: 'POST', path: '/upload/studio/v1', init: ZIP },
    { name: 'POST coverage', method: 'POST', path: '/upload/studio/v1/coverage', init: JSON_BODY({}) },
    { name: 'POST metadata', method: 'POST', path: '/upload/studio/v1/metadata', init: ZIP },
    { name: 'POST ci-timings', method: 'POST', path: '/upload/studio/v1/builds/b1/ci-timings', init: JSON_BODY({}) },
    { name: 'POST generic presigned-url', method: 'POST', path: '/presigned-url/studio/v1/storybook.zip', init: JSON_BODY({ contentType: 'application/zip' }) },
    { name: 'POST upload-images', method: 'POST', path: '/upload-images/studio', init: JSON_BODY({ imageCount: 1 }) },
    { name: 'POST upload-images complete', method: 'POST', path: '/upload-images/studio/complete', init: JSON_BODY({ uploadId: 'u1', zipKey: 'k' }) },
  ];
  for (const r of REFUSED) {
    it(`${r.name}: a device key gets 403 even for its own project, and nothing is read or written`, async () => {
      const { server, storage, firestore } = setup();
      const res = await req(server, r.method, r.path, r.init);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'Forbidden', message: 'This key can only upload pictures to its project' });
      expect(storage.upload).not.toHaveBeenCalled();
      expect(storage.getPresignedUploadUrl).not.toHaveBeenCalled();
      expect(storage.getObjectStream).not.toHaveBeenCalled();
      expect(firestore.createBuild).not.toHaveBeenCalled();
      expect(firestore.getBuildByVersion).not.toHaveBeenCalled();
      expect(firestore.updateBuild).not.toHaveBeenCalled();
      expect(firestore.createUpload).not.toHaveBeenCalled();
    });
  }

  it('a device key cannot presign or complete for another project', async () => {
    const { server, storage, apiKeyService } = setup();
    const a = await req(server, 'POST', '/presigned-url/other/sync-1/bundle.zip?source=x-scry-sync:other');
    const b = await req(server, 'POST', '/upload/other/sync-1/bundle/complete', JSON_BODY({ buildId: 'b1', zipKey: 'other/x' }));
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    expect(storage.getPresignedUploadUrl).not.toHaveBeenCalled();
    expect(apiKeyService.validateApiKey).not.toHaveBeenCalled();
  });

  it('a key with no kind field (CI / legacy key) keeps every route and every source it had', async () => {
    const { server, storage } = setup({ noKind: true });
    const res = await req(server, 'GET', '/upload/studio/v1');
    expect(res.status).not.toBe(403);
    for (const source of ['storybook:web', 'figma:web', 'x-scry-sync:other']) {
      const p = await req(server, 'POST', `/presigned-url/studio/sync-1/bundle.zip?source=${source}`);
      expect(p.status, source).toBe(200);
    }
    expect(storage.getPresignedUploadUrl).toHaveBeenCalledTimes(3);
  });

  it('the allow-list matches only the two device routes handled by apiKeyAuth', () => {
    expect(deviceKeyMayUse('POST', '/presigned-url/p/v/bundle.zip')).toBe(true);
    expect(deviceKeyMayUse('post', '/upload/p/v/bundle/complete')).toBe(true);
    expect(deviceKeyMayUse('GET', '/presigned-url/p/v/bundle.zip')).toBe(false);
    expect(deviceKeyMayUse('POST', '/upload/p/v/bundle/complete/x')).toBe(false);
    expect(deviceKeyMayUse('POST', '/upload/p/v')).toBe(false);
  });
});

describe('guarantee-5-revoke-stops-upload', () => {
  it('DELETE /keys/self answers 204 and the very next presign is refused with the existing auth error', async () => {
    const { server, apiKeyService } = setup();
    expect((await req(server, 'POST', PRESIGN)).status).toBe(200);

    const del = await req(server, 'DELETE', '/keys/self');
    expect(del.status).toBe(204);
    expect(await del.text()).toBe('');
    expect(apiKeyService.revokeApiKey).toHaveBeenCalledWith('studio', 'dev1', SELF_REVOKED_BY);

    const next = await req(server, 'POST', PRESIGN);
    expect(next.status).toBe(401);
    expect((await next.json()).error).toBe('Invalid API key');
  });

  it('is idempotent: a second DELETE also answers 204 and revokes nothing more', async () => {
    const { server, apiKeyService } = setup();
    expect((await req(server, 'DELETE', '/keys/self')).status).toBe(204);
    expect((await req(server, 'DELETE', '/keys/self')).status).toBe(204);
    expect(apiKeyService.revokeApiKey).toHaveBeenCalledTimes(1);
  });

  it('an unknown key answers 204 like a revoked one (no oracle) and revokes nothing', async () => {
    const { server, apiKeyService } = setup();
    expect((await req(server, 'DELETE', '/keys/self', {}, OTHER_KEY)).status).toBe(204);
    expect(apiKeyService.revokeApiKey).not.toHaveBeenCalled();
  });

  it('a missing or malformed key is 401', async () => {
    const { server } = setup();
    const a = await req(server, 'DELETE', '/keys/self', {}, null);
    expect(a.status).toBe(401);
    expect(await a.json()).toMatchObject({ error: 'Authentication required', message: 'Missing X-API-Key header' });
    const b = await req(server, 'DELETE', '/keys/self', {}, 'not-a-key');
    expect(b.status).toBe(401);
    expect((await b.json()).error).toBe('Invalid API key format');
  });

  it('a key-store failure is 503 with Retry-After, so the app retries instead of claiming it disconnected', async () => {
    for (const opts of [{ validateThrows: true }, { revokeThrows: true }]) {
      const { server } = setup(opts);
      const res = await req(server, 'DELETE', '/keys/self');
      expect(res.status).toBe(503);
      expect(res.headers.get('Retry-After')).toBe('2');
    }
  });

  it('every answer carries x-scry-request-id', async () => {
    const { server } = setup();
    const res = await req(server, 'DELETE', '/keys/self', { headers: { 'x-scry-request-id': 'req_sync_test_1' } });
    expect(res.status).toBe(204);
    expect(res.headers.get('x-scry-request-id')).toBeTruthy();
  });
});

describe('guarantee-8-credential-only-in-keychain (server side)', () => {
  it('no log line carries the key value across presign, refusal, revoke and rejected reuse', async () => {
    const { server } = setup();
    await req(server, 'POST', PRESIGN);
    await req(server, 'GET', '/upload/studio/v1');
    await req(server, 'DELETE', '/keys/self');
    await req(server, 'DELETE', '/keys/self');
    await req(server, 'POST', PRESIGN);
    await req(server, 'DELETE', '/keys/self', {}, OTHER_KEY);
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line).not.toContain('DeViCeSeCrEtVaLuE');
      expect(line).not.toContain(DEVICE_KEY);
    }
    expect(logged.some((l) => l.includes('key self revoked'))).toBe(true);
  });
});

const REFUSAL = { error: 'Forbidden', message: 'This key can only upload pictures to its project' };

describe('guarantee-1 fail closed: a present `kind` is the restricted device class (F39)', () => {
  // The key service hands on whatever the document holds; the middleware must not read "present but
  // not exactly 'device'" as "no kind".
  const ODD_KINDS: Array<[string, unknown]> = [
    ["mis-cased 'Device'", 'Device'],
    ["upper-case 'DEVICE'", 'DEVICE'],
    ["padded 'device '", 'device '],
    ['unknown string', 'service-account'],
    ['empty string', ''],
    ['unrecognised marker the services use for unreadable values', 'unrecognised'],
    ['number', 5],
    ['boolean', true],
    ['null', null],
    ['object', { v: 'device' }],
    ['array', ['device']],
  ];
  for (const [label, kind] of ODD_KINDS) {
    it(`${label}: refused on every non-device route, source-pinned on presign`, async () => {
      const { server, storage, firestore } = setup({ kind });
      for (const r of [
        { method: 'GET', path: '/upload/studio/v1', init: {} },
        { method: 'POST', path: '/upload/studio/v1', init: ZIP },
        { method: 'POST', path: '/upload-images/studio', init: JSON_BODY({ imageCount: 1 }) },
        { method: 'POST', path: '/presigned-url/studio/v1/storybook.zip', init: JSON_BODY({}) },
        { method: 'POST', path: '/presigned-url/studio/sync-1/bundle.zip?source=storybook:web', init: {} },
      ]) {
        const res = await req(server, r.method, r.path, r.init);
        expect(res.status, `${r.method} ${r.path}`).toBe(403);
        expect(await res.json()).toMatchObject(REFUSAL);
      }
      expect(storage.getPresignedUploadUrl).not.toHaveBeenCalled();
      expect(storage.upload).not.toHaveBeenCalled();
      expect(firestore.createBuild).not.toHaveBeenCalled();
      expect(firestore.createUpload).not.toHaveBeenCalled();
    });

    it(`${label}: still gets the device routes (presign x-scry-sync) and nothing more`, async () => {
      const { server } = setup({ kind });
      expect((await req(server, 'POST', PRESIGN)).status).toBe(200);
    });
  }

  it('isRestrictedKeyKind: only an absent kind is unrestricted', () => {
    expect(isRestrictedKeyKind(undefined)).toBe(false);
    for (const k of ['device', 'Device', '', 'ci', 'unrecognised', ' ']) expect(isRestrictedKeyKind(k), JSON.stringify(k)).toBe(true);
    // The middleware also tolerates a service that leaks a non-string (defence in depth).
    for (const k of [0, false, null, {}, []]) expect(isRestrictedKeyKind(k as unknown as string), JSON.stringify(k)).toBe(true);
  });
});

describe('guarantee-1 source pin: a device key only presigns and completes x-scry-sync (F40)', () => {
  it('presign: ?source=storybook:web and ?source=figma:web are 403 with the existing body; nothing is created', async () => {
    const { server, storage, firestore } = setup();
    for (const source of ['storybook:web', 'figma:web', 'x-adobe-bridge:other', 'upload:other', 'x-scry-syncx:other', 'x-scry-sync-2:other']) {
      const res = await req(server, 'POST', `/presigned-url/studio/sync-1/bundle.zip?source=${encodeURIComponent(source)}`);
      expect(res.status, source).toBe(403);
      expect(await res.json()).toMatchObject(REFUSAL);
    }
    expect(firestore.createBuild).not.toHaveBeenCalled();
    expect(storage.getPresignedUploadUrl).not.toHaveBeenCalled();
    expect(logged.some((l) => l.includes('device_key_source'))).toBe(true);
  });

  it('presign: x-scry-sync still 200 and the build is stored as x-scry-sync', async () => {
    const { server, firestore } = setup();
    const res = await req(server, 'POST', PRESIGN);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ buildId: 'b1', fields: { key: ZIP_KEY } });
    expect(firestore.createBuild).toHaveBeenCalledWith('studio', expect.objectContaining({ source: { kind: 'x-scry-sync', platform: 'other' } }));
  });

  it('presign: a missing or malformed source stays the existing 400, not a 200', async () => {
    const { server, firestore } = setup();
    expect((await req(server, 'POST', '/presigned-url/studio/sync-1/bundle.zip')).status).toBe(400);
    expect((await req(server, 'POST', '/presigned-url/studio/sync-1/bundle.zip?source=nonsense')).status).toBe(400);
    expect(firestore.createBuild).not.toHaveBeenCalled();
  });

  it('complete: a build presigned for another source (storybook:web) is 403, not queued, object kept', async () => {
    const send = vi.fn(async () => undefined);
    const storage = syncStorage();
    const { server, firestore } = setup({ storage, queue: { send }, buildSource: { kind: 'storybook', platform: 'web' } });
    const res = await req(server, 'POST', COMPLETE, JSON_BODY(COMPLETE_BODY));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject(REFUSAL);
    expect(send).not.toHaveBeenCalled();
    expect(firestore.updateProcessingStatus).not.toHaveBeenCalled();
    expect(firestore.updateBuild).not.toHaveBeenCalled();
  });

  it('complete: a legacy build with no source is 403 for a device key', async () => {
    const send = vi.fn(async () => undefined);
    const { server } = setup({ storage: syncStorage(), queue: { send }, buildSource: null });
    expect((await req(server, 'POST', COMPLETE, JSON_BODY(COMPLETE_BODY))).status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it('complete: an x-scry-sync build whose bundle manifest names another source is 403; object deleted, build marked failed, not queued', async () => {
    const send = vi.fn(async () => undefined);
    const storage = syncStorage({ kind: 'storybook', platform: 'web' });
    const { server, firestore } = setup({ storage, queue: { send } });
    const res = await req(server, 'POST', COMPLETE, JSON_BODY(COMPLETE_BODY));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject(REFUSAL);
    expect(send).not.toHaveBeenCalled();
    expect(firestore.updateProcessingStatus).not.toHaveBeenCalled();
    expect(firestore.updateBuild).toHaveBeenCalledWith('studio', 'b1', expect.objectContaining({ processingStatus: 'failed' }));
    expect(await storage.head(ZIP_KEY)).toBeNull();
  });

  it('complete: a key with no kind field may still complete a non-sync build (legacy behaviour unchanged)', async () => {
    const send = vi.fn(async () => undefined);
    const { server } = setup({ noKind: true, storage: syncStorage({ kind: 'storybook', platform: 'web' }), queue: { send }, buildSource: { kind: 'storybook', platform: 'web' } });
    const res = await req(server, 'POST', COMPLETE, JSON_BODY(COMPLETE_BODY));
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('complete: an unknown-kind key is pinned the same way as a device key', async () => {
    const send = vi.fn(async () => undefined);
    const { server } = setup({ kind: 'Device', storage: syncStorage(), queue: { send }, buildSource: { kind: 'figma', platform: 'web' } });
    expect((await req(server, 'POST', COMPLETE, JSON_BODY(COMPLETE_BODY))).status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('guarantee-1 full source pin: a device key presigns and completes exactly x-scry-sync:other (F68)', () => {
  it.each(['x-scry-sync:ios', 'x-scry-sync:web', 'x-scry-sync:android', 'x-scry-sync:macos', 'x-scry-sync:windows', 'x-scry-sync:email'])(
    'presign: ?source=%s is 403 with the existing body; no build, no presigned URL',
    async (source) => {
      const { server, storage, firestore } = setup();
      const res = await req(server, 'POST', `/presigned-url/studio/sync-1/bundle.zip?source=${encodeURIComponent(source)}`);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject(REFUSAL);
      expect(firestore.createBuild).not.toHaveBeenCalled();
      expect(storage.getPresignedUploadUrl).not.toHaveBeenCalled();
      expect(logged.some((l) => l.includes('device_key_source'))).toBe(true);
    }
  );

  it('complete: a build stored as x-scry-sync:ios is 403 for a device key, not queued', async () => {
    const send = vi.fn(async () => undefined);
    const { server, firestore } = setup({ storage: syncStorage(), queue: { send }, buildSource: { kind: 'x-scry-sync', platform: 'ios' } });
    const res = await req(server, 'POST', COMPLETE, JSON_BODY(COMPLETE_BODY));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject(REFUSAL);
    expect(send).not.toHaveBeenCalled();
    expect(firestore.updateProcessingStatus).not.toHaveBeenCalled();
  });

  it.each(['ios', 'web', 'android'])(
    'complete: an x-scry-sync:other build whose manifest says platform %s is 403; object deleted, build failed, not queued',
    async (platform) => {
      const send = vi.fn(async () => undefined);
      const storage = syncStorage({ kind: 'x-scry-sync', platform });
      const { server, firestore } = setup({ storage, queue: { send } });
      const res = await req(server, 'POST', COMPLETE, JSON_BODY(COMPLETE_BODY));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject(REFUSAL);
      expect(send).not.toHaveBeenCalled();
      expect(firestore.updateBuild).toHaveBeenCalledWith('studio', 'b1', expect.objectContaining({ processingStatus: 'failed' }));
      expect(await storage.head(ZIP_KEY)).toBeNull();
    }
  );

  it('complete: a manifest with no platform (defaults to web) is refused for a device key', async () => {
    const send = vi.fn(async () => undefined);
    const storage = new MockStorageService();
    storage.seed(
      ZIP_KEY,
      buildZip([
        { name: 'scf.json', data: Buffer.from(JSON.stringify({ scf: '1.0', source: { kind: 'x-scry-sync' }, captures: [{ id: 'p2', image: 'images/p2.png' }] })) },
        { name: 'images/p2.png', data: PNG },
      ])
    );
    const { server } = setup({ storage, queue: { send } });
    expect((await req(server, 'POST', COMPLETE, JSON_BODY(COMPLETE_BODY))).status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it('exactly x-scry-sync:other still passes presign and complete (recorded fixture shape)', async () => {
    const send = vi.fn(async () => undefined);
    const { server } = setup({ storage: syncStorage(), queue: { send } });
    expect((await req(server, 'POST', PRESIGN)).status).toBe(200);
    expect((await req(server, 'POST', COMPLETE, JSON_BODY(COMPLETE_BODY))).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('other key kinds are unaffected: a key with no kind may presign x-scry-sync:ios and storybook:web', async () => {
    const { server } = setup({ noKind: true });
    for (const source of ['x-scry-sync:ios', 'storybook:web']) {
      expect((await req(server, 'POST', `/presigned-url/studio/sync-1/bundle.zip?source=${encodeURIComponent(source)}`)).status, source).toBe(200);
    }
  });
});

describe('DELETE /keys/self is not behind apiKeyAuth (F41)', () => {
  it('a restricted key, whatever its kind, revokes itself through the self-authenticating handler', async () => {
    for (const kind of ['device', 'Device', 5]) {
      const { server, apiKeyService } = setup({ kind });
      expect((await req(server, 'DELETE', '/keys/self')).status, String(kind)).toBe(204);
      expect(apiKeyService.revokeApiKey).toHaveBeenCalledWith('studio', 'dev1', SELF_REVOKED_BY);
    }
  });

  it('a missing key service is 503 with Retry-After, never 204', async () => {
    const { server } = setup({ withoutKeyService: true });
    const res = await req(server, 'DELETE', '/keys/self');
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('2');
  });
});

describe('guarantee-8 canary beyond the header (F42)', () => {
  it('a canary in the path, query, body and x-scry-client reaches no log line before or after authorization', async () => {
    const CANARY = 'CANARYzz9Q';
    const { server } = setup();
    await req(server, 'POST', `/presigned-url/${CANARY}/sync-1/bundle.zip?source=${CANARY}`, { headers: { 'x-scry-client': CANARY } });
    await req(server, 'POST', `/upload/studio/sync-1/bundle/complete?x=${CANARY}`, { ...JSON_BODY({ buildId: CANARY, zipKey: CANARY }), headers: { 'Content-Type': 'application/json', 'x-scry-client': CANARY } });
    await req(server, 'POST', `/presigned-url/studio/sync-1/bundle.zip?source=${CANARY}:web`, { headers: { 'x-scry-client': CANARY } });
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) expect(line).not.toContain(CANARY);
  });
});
