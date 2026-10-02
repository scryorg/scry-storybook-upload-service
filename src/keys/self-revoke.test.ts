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
import { deviceKeyMayUse } from '../middleware/auth.js';

const DEVICE_KEY = 'scry_proj_studio_DeViCeSeCrEtVaLuE0123456789';
const OTHER_KEY = 'scry_proj_other_DeViCeSeCrEtVaLuE0123456789';

/** A key store that behaves like Firestore: validate matches only status 'active'. */
function setup(opts: { kind?: string; validateThrows?: boolean; revokeThrows?: boolean } = {}) {
  const keys = new Map<string, { id: string; projectId: string; status: string; kind?: string }>([
    [DEVICE_KEY, { id: 'dev1', projectId: 'studio', status: 'active', kind: opts.kind ?? 'device' }],
  ]);
  const storage: StorageService = {
    upload: vi.fn(async (key: string) => ({ url: `https://r2.example/${key}`, key })),
    getPresignedUploadUrl: vi.fn(async (key: string) => ({ url: `https://signed.example/${key}?s=1`, key })),
    head: vi.fn(async () => ({ size: 3 })),
    getObjectStream: vi.fn(),
    getObjectRange: vi.fn(),
    delete: vi.fn(),
    deleteByPrefix: vi.fn(),
  } as unknown as StorageService;
  const build = {
    id: 'b1', projectId: 'studio', versionId: 'v1', buildNumber: 1, zipUrl: 'z',
    status: 'active', createdAt: new Date(), createdBy: 't',
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
      return { valid: true, apiKey: { id: k.id, name: 'Scry Sync', prefix: 'scry_proj_st', ...(k.kind ? { kind: k.kind } : {}) } };
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
    c.set('apiKeyService', apiKeyService);
    await next();
  });
  server.route('/', app);
  return { server, firestore, storage, apiKeyService, keys };
}

const JSON_BODY = (b: unknown) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
const ZIP = { headers: { 'Content-Type': 'application/zip' }, body: new Uint8Array([1, 2, 3]) };
const PRESIGN = '/presigned-url/studio/sync-1/bundle.zip?source=x-scry-sync:other';
const COMPLETE = '/upload/studio/sync-1/bundle/complete';

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

  it('a device key gets through auth on bundle complete for its own project', async () => {
    const { server, apiKeyService } = setup();
    const res = await req(server, 'POST', COMPLETE, JSON_BODY({ buildId: 'b1', zipKey: 'studio/sync-1/builds/1/bundle.zip' }));
    expect([401, 403]).not.toContain(res.status);
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

  it('a key with no kind (CI key) keeps every route it had', async () => {
    const { server } = setup({ kind: '' });
    const res = await req(server, 'GET', '/upload/studio/v1');
    expect(res.status).not.toBe(403);
  });

  it('the allow-list matches only the three device routes', () => {
    expect(deviceKeyMayUse('POST', '/presigned-url/p/v/bundle.zip')).toBe(true);
    expect(deviceKeyMayUse('post', '/upload/p/v/bundle/complete')).toBe(true);
    expect(deviceKeyMayUse('DELETE', '/keys/self')).toBe(true);
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
