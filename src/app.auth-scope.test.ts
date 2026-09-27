/**
 * regression-upload-project-key-scope
 *
 * An API key belongs to one project (scry_proj_<projectId>_…). Every upload
 * route must refuse a key from another project. The middleware was mounted on
 * '/upload/*', '/presigned-url/*' and '/upload-images/*', patterns with no
 * :project param, so its project-mismatch check never ran and the key was
 * validated against its own project: any valid key could write to any project.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { app, type AppEnv } from './app.js';
import type { ApiKeyService } from './services/apikey/apikey.service.js';
import type { FirestoreService } from './services/firestore/firestore.service.js';
import type { StorageService } from './services/storage/storage.service.js';

function setup() {
  const storage: StorageService = {
    upload: vi.fn(async (key: string) => ({ url: `https://r2.example/${key}`, key })) as any,
    getPresignedUploadUrl: vi.fn(async (key: string) => ({ url: `https://signed.example/${key}?s=1`, key })) as any,
    deleteByPrefix: vi.fn() as any,
  };
  const build = {
    id: 'b1', projectId: 'victim', versionId: 'v1', buildNumber: 1, zipUrl: 'z',
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
    validateApiKey: vi.fn(async () => ({ valid: true, apiKey: { id: 'k1', name: 'ci', prefix: 'scry_proj_' } })),
    listApiKeys: vi.fn(),
    revokeApiKey: vi.fn(),
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
  return { server, firestore, storage, apiKeyService };
}

const ZIP = { headers: { 'Content-Type': 'application/zip' }, body: new Uint8Array([1, 2, 3]) };
const JSON_BODY = (b: unknown) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

const ROUTES: Array<{ name: string; method: string; path: string; init: { headers: Record<string, string>; body?: any } }> = [
  { name: 'POST /upload/:project/:version', method: 'POST', path: '/upload/victim/v1', init: ZIP },
  { name: 'GET /upload/:project/:version', method: 'GET', path: '/upload/victim/v1', init: { headers: {} } },
  { name: 'POST /upload/:project/:version/coverage', method: 'POST', path: '/upload/victim/v1/coverage', init: JSON_BODY({}) },
  { name: 'POST /upload/:project/:version/metadata', method: 'POST', path: '/upload/victim/v1/metadata', init: ZIP },
  { name: 'POST /presigned-url/:project/:version/:filename', method: 'POST', path: '/presigned-url/victim/v1/storybook.zip', init: JSON_BODY({ contentType: 'application/zip' }) },
  { name: 'POST /upload-images/:project', method: 'POST', path: '/upload-images/victim', init: JSON_BODY({ imageCount: 1 }) },
  { name: 'POST /upload-images/:project/complete', method: 'POST', path: '/upload-images/victim/complete', init: JSON_BODY({ uploadId: 'u1', zipKey: 'victim/uploads/1/images.zip' }) },
];

describe('regression-upload-project-key-scope', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  for (const route of ROUTES) {
    it(`${route.name}: another project's key gets 403 and nothing is read, written or queued`, async () => {
      const { server, firestore, storage, apiKeyService } = setup();
      const res = await server.request(route.path, {
        method: route.method,
        ...route.init,
        headers: { ...route.init.headers, 'X-API-Key': 'scry_proj_attacker_abcdefghijklmnop' },
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('Project mismatch');
      expect(apiKeyService.validateApiKey).not.toHaveBeenCalled();
      expect(storage.upload).not.toHaveBeenCalled();
      expect(storage.getPresignedUploadUrl).not.toHaveBeenCalled();
      expect(firestore.createBuild).not.toHaveBeenCalled();
      expect(firestore.createUpload).not.toHaveBeenCalled();
      expect(firestore.updateBuild).not.toHaveBeenCalled();
    });

    it(`${route.name}: the project's own key is validated against that project and let through`, async () => {
      const { server, apiKeyService } = setup();
      const res = await server.request(route.path, {
        method: route.method,
        ...route.init,
        headers: { ...route.init.headers, 'X-API-Key': 'scry_proj_victim_abcdefghijklmnop' },
      });
      expect([401, 403]).not.toContain(res.status);
      expect(apiKeyService.validateApiKey).toHaveBeenCalledWith('victim', 'scry_proj_victim_abcdefghijklmnop');
    });

    it(`${route.name}: no key is still 401`, async () => {
      const { server } = setup();
      const res = await server.request(route.path, { method: route.method, ...route.init });
      expect(res.status).toBe(401);
    });
  }
});

describe('upload-project-key-scope detection', () => {
  it('every route under the authenticated prefixes carries :project as its first segment (so the auth middleware can check it)', () => {
    const guarded = app.routes
      .map((r) => r.path)
      .filter((p) => /^\/(upload|presigned-url|upload-images)(\/|$)/.test(p));
    expect(guarded.length).toBeGreaterThan(0);
    for (const path of guarded) {
      expect(path, path).toMatch(/^\/(upload|presigned-url|upload-images)\/:project(\/|$)/);
    }
  });
});

describe('upload-project-key-scope detection: who uploaded, and every auth outcome logged', () => {
  const KEY = 'scry_proj_victim_SECRETsecretSECRETsecret123456';
  const ATTACKER_KEY = 'scry_proj_attacker_SECRETsecretSECRETsecret654321';
  let logs: string[];

  beforeEach(() => {
    vi.restoreAllMocks();
    logs = [];
    const capture = (...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
    vi.spyOn(console, 'error').mockImplementation(capture);
    vi.spyOn(console, 'info').mockImplementation(capture);
  });

  const authLines = () =>
    logs.filter((l) => l.includes('"event":"upload_auth"')).map((l) => JSON.parse(l.slice(l.indexOf('{'))));

  it('the presigned route records the key doc id and key project on the build it creates', async () => {
    const { server, firestore } = setup();
    const res = await server.request('/presigned-url/victim/v1/storybook.zip', {
      method: 'POST',
      ...JSON_BODY({ contentType: 'application/zip' }),
      headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY },
    });
    expect(res.status).toBe(200);
    const data = (firestore.createBuild as any).mock.calls[0][1];
    expect(data.uploadedByKeyId).toBe('k1');
    expect(data.uploadedByKeyProject).toBe('victim');
    expect(JSON.stringify(data)).not.toContain('SECRET');
  });

  it('the direct upload route records them too', async () => {
    const { server, firestore } = setup();
    const res = await server.request('/upload/victim/v1', {
      method: 'POST',
      ...ZIP,
      headers: { 'Content-Type': 'application/zip', 'X-API-Key': KEY },
    });
    expect(res.status).toBe(201);
    const data = (firestore.createBuild as any).mock.calls[0][1];
    expect(data.uploadedByKeyId).toBe('k1');
    expect(data.uploadedByKeyProject).toBe('victim');
  });

  it('one structured log line per authenticated request with keyId, keyProject and routeProject', async () => {
    const { server } = setup();
    await server.request('/upload/victim/v1/metadata', {
      method: 'POST',
      ...ZIP,
      headers: { 'Content-Type': 'application/zip', 'X-API-Key': KEY },
    });
    const lines = authLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      event: 'upload_auth',
      outcome: 'ok',
      keyId: 'k1',
      keyProject: 'victim',
      routeProject: 'victim',
      method: 'POST',
      path: '/upload/victim/v1/metadata',
    });
  });

  it('a warn line on every 403 mismatch, naming both projects', async () => {
    const { server } = setup();
    const warn = console.warn as unknown as ReturnType<typeof vi.fn>;
    const res = await server.request('/presigned-url/victim/v1/storybook.zip', {
      method: 'POST',
      ...JSON_BODY({}),
      headers: { 'Content-Type': 'application/json', 'X-API-Key': ATTACKER_KEY },
    });
    expect(res.status).toBe(403);
    const warned = warn.mock.calls.map((a: unknown[]) => String(a[0])).filter((l: string) => l.includes('project_mismatch'));
    expect(warned).toHaveLength(1);
    expect(JSON.parse(warned[0])).toMatchObject({
      event: 'upload_auth',
      outcome: 'project_mismatch',
      keyProject: 'attacker',
      routeProject: 'victim',
    });
  });

  it('the key value never appears in any log line, on success or on mismatch, on any route', async () => {
    for (const route of ROUTES) {
      for (const key of [KEY, ATTACKER_KEY]) {
        const { server } = setup();
        await server.request(route.path, {
          method: route.method,
          ...route.init,
          headers: { ...route.init.headers, 'X-API-Key': key },
        });
      }
    }
    expect(authLines().length).toBeGreaterThanOrEqual(ROUTES.length * 2);
    const all = logs.join('\n');
    expect(all).not.toContain('SECRET');
    expect(all).not.toContain('secret123456');
    expect(all).not.toContain('secret654321');
  });
});
