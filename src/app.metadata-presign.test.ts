/**
 * regression-metadata-zip-100mb-limit (ISSUES.md #74)
 *
 * The deployer's metadata ZIP grew past 100 MiB and had no way to reach the service except one
 * POST through the Worker (client cap 100 MiB). The ZIP now travels like the Storybook archive:
 * presign, PUT straight to storage, complete. These tests assert the symptom (a ZIP over 100 MiB
 * is accepted and queued without its bytes passing through the Worker) and one negative path per
 * guarantee of the plan (G1 to G5).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { app, type AppEnv } from './app.js';
import type { ApiKeyService } from './services/apikey/apikey.service.js';
import type { FirestoreService } from './services/firestore/firestore.service.js';
import type { Build } from './services/firestore/firestore.types.js';
import type { StorageService } from './services/storage/storage.service.js';

const MIB = 1024 * 1024;
const KEY_OK = 'scry_proj_my-project_abcdefghijklmnop';
const KEY_OTHER = 'scry_proj_attacker_abcdefghijklmnop';
const ZIP_KEY = 'my-project/v1.0.0/builds/7/metadata-screenshots.zip';

function makeBuild(overrides: Partial<Build> = {}): Build {
  return {
    id: 'build-123',
    projectId: 'my-project',
    versionId: 'v1.0.0',
    buildNumber: 7,
    zipUrl: 'https://storage.test/my-project/v1.0.0/storybook.zip',
    status: 'active',
    createdAt: new Date(),
    createdBy: 'test',
    ...overrides,
  };
}

function setup(opts: { build?: Build | null; headSize?: number | null; withQueue?: boolean } = {}) {
  const build = opts.build === undefined ? makeBuild() : opts.build;
  const headSize = opts.headSize === undefined ? 120 * MIB : opts.headSize;
  const storage = {
    upload: vi.fn(async (key: string) => ({ url: `https://storage.test/${key}`, path: key })),
    getPresignedUploadUrl: vi.fn(async (key: string) => ({ url: `https://signed.test/${key}?sig=1`, key })),
    head: vi.fn(async () => (headSize === null ? null : { size: headSize, contentType: 'application/zip' })),
    getObjectStream: vi.fn(),
    getObjectRange: vi.fn(),
    delete: vi.fn(async () => undefined),
    deleteByPrefix: vi.fn(),
  } as unknown as StorageService;
  const firestore = {
    createBuild: vi.fn(),
    getBuild: vi.fn(async () => build),
    getProjectBuilds: vi.fn(async () => []),
    getBuildByVersion: vi.fn(async () => build),
    getLatestBuild: vi.fn(async () => build),
    updateBuild: vi.fn(async () => undefined),
    updateBuildCoverage: vi.fn(async () => undefined),
    updateProcessingStatus: vi.fn(async () => undefined),
    archiveBuild: vi.fn(async () => undefined),
    deleteBuild: vi.fn(async () => undefined),
  } as unknown as FirestoreService;
  const send = vi.fn(async () => undefined);
  const apiKeyService = {
    validateApiKey: vi.fn(async () => ({ valid: true, apiKey: { id: 'k1', name: 'ci', prefix: 'scry_proj_' } })),
    updateLastUsed: vi.fn(async () => undefined),
  } as unknown as ApiKeyService;

  const server = new Hono<AppEnv>();
  server.use('*', async (c, next) => {
    c.set('storage', storage);
    c.set('firestore', firestore);
    if (opts.withQueue !== false) c.set('processingQueue', { send } as unknown as Queue);
    c.set('apiKeyService', apiKeyService);
    await next();
  });
  server.route('/', app);
  return { server, storage, firestore, send };
}

const AUTH = { 'X-API-Key': KEY_OK };
const json = (body: unknown, key = KEY_OK) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
  body: JSON.stringify(body),
});
const presign = (server: Hono<AppEnv>, key = KEY_OK) =>
  server.request('/upload/my-project/v1.0.0/metadata/presign', { method: 'POST', headers: { 'X-API-Key': key } });
const complete = (server: Hono<AppEnv>, body: unknown, key = KEY_OK, qs = '') =>
  server.request(`/upload/my-project/v1.0.0/metadata/complete${qs}`, json(body, key));
const failed = (server: Hono<AppEnv>, body: unknown, key = KEY_OK) =>
  server.request('/upload/my-project/v1.0.0/metadata/failed', json(body, key));

describe('regression-metadata-zip-100mb-limit', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('a 120 MiB metadata ZIP is presigned, uploaded straight to storage and queued; the Worker never holds its bytes', async () => {
    const { server, storage, firestore, send } = setup({ headSize: 120 * MIB });

    const p = await presign(server);
    expect(p.status).toBe(200);
    const issued = await p.json();
    expect(issued).toMatchObject({ buildId: 'build-123', buildNumber: 7, key: ZIP_KEY });
    expect(issued.url).toContain(ZIP_KEY);
    expect(storage.getPresignedUploadUrl).toHaveBeenCalledWith(ZIP_KEY, 'application/zip');

    const c = await complete(server, { buildId: issued.buildId, zipKey: issued.key });
    expect(c.status).toBe(200);
    expect(await c.json()).toMatchObject({ success: true, queued: true, buildNumber: 7, zipKey: ZIP_KEY });
    expect(storage.upload).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(firestore.updateProcessingStatus).toHaveBeenCalledWith(
      'my-project',
      'build-123',
      'queued',
      expect.objectContaining({ lastStep: 'enqueue', outcome: 'ok' })
    );
  });
});

describe('guarantee tests: metadata presign, complete, failed', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('guarantee-1 large zip is presigned and no ZIP byte passes through the service', async () => {
    for (const mib of [101, 200]) {
      const { server, storage, send } = setup({ headSize: mib * MIB });
      const issued = await (await presign(server)).json();
      const res = await complete(server, { buildId: issued.buildId, zipKey: issued.key });
      expect(res.status, `${mib} MiB`).toBe(200);
      expect(storage.upload).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledTimes(1);
    }
  });

  it('guarantee-1b presign with no build for this version is a clear 400 and issues no URL', async () => {
    const { server, storage } = setup({ build: null });
    const res = await presign(server);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Upload storybook\.zip first/);
    expect(storage.getPresignedUploadUrl).not.toHaveBeenCalled();
  });

  it('guarantee-2 failed upload marks the build failed with a reason, and the status is never set queued', async () => {
    const { server, firestore, send } = setup();
    const res = await failed(server, { buildId: 'build-123', reason: 'PUT failed after 3 attempts: ECONNRESET' });
    expect(res.status).toBe(200);
    expect(firestore.updateBuild).toHaveBeenCalledWith(
      'my-project',
      'build-123',
      expect.objectContaining({
        processingStatus: 'failed',
        processingError: expect.stringContaining('metadata upload failed'),
      })
    );
    const written = (firestore.updateBuild as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(written.processingError).toContain('ECONNRESET');
    expect(send).not.toHaveBeenCalled();
  });

  it('guarantee-2b failed refuses a build that is already queued (it never overwrites a good build) and a missing build', async () => {
    const queued = setup({ build: makeBuild({ processingStatus: 'queued' }) });
    const r1 = await failed(queued.server, { buildId: 'build-123', reason: 'x' });
    expect(r1.status).toBe(409);
    expect(queued.firestore.updateBuild).not.toHaveBeenCalled();

    const missing = setup({ build: null });
    const r2 = await failed(missing.server, { buildId: 'nope', reason: 'x' });
    expect(r2.status).toBe(404);
    expect(missing.firestore.updateBuild).not.toHaveBeenCalled();
  });

  it('guarantee-2c failed with no reason, a huge reason or control characters stores a bounded one-line reason', async () => {
    const { server, firestore } = setup();
    const res = await failed(server, { buildId: 'build-123', reason: `bad\u0000\n${'x'.repeat(5000)}` });
    expect(res.status).toBe(200);
    const written = (firestore.updateBuild as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(written.processingError.length).toBeLessThanOrEqual(300);
    expect(written.processingError).not.toMatch(/[\u0000-\u001f]/);
  });

  it('guarantee-3 old deployers: the old route still takes up to 100 MiB; above 100 MiB it answers 413 with guidance and stores nothing', async () => {
    const small = setup();
    const ok = await small.server.request('/upload/my-project/v1.0.0/metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip', ...AUTH },
      body: new Uint8Array([80, 75, 3, 4]),
    });
    expect(ok.status).toBe(201);
    expect(small.storage.upload).toHaveBeenCalledWith(ZIP_KEY, expect.anything(), 'application/zip');

    const big = setup();
    const res = await big.server.request('/upload/my-project/v1.0.0/metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip', ...AUTH },
      body: new Uint8Array(100 * MIB + 1),
    });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/0\.12\.0 or later/);
    expect(big.storage.upload).not.toHaveBeenCalled();
    expect(big.send).not.toHaveBeenCalled();
  });

  it('guarantee-3b old route: a declared Content-Length over 100 MiB is refused before the body is read', async () => {
    const { server, storage } = setup();
    const res = await server.request('/upload/my-project/v1.0.0/metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip', 'Content-Length': String(150 * MIB), ...AUTH },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(res.status).toBe(413);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  describe('guarantee-4 project-scoped-and-key-pinned', () => {
    it('another project key cannot presign, complete or fail this project metadata ZIP', async () => {
      for (const call of [
        (s: Hono<AppEnv>) => presign(s, KEY_OTHER),
        (s: Hono<AppEnv>) => complete(s, { buildId: 'build-123', zipKey: ZIP_KEY }, KEY_OTHER),
        (s: Hono<AppEnv>) => failed(s, { buildId: 'build-123', reason: 'x' }, KEY_OTHER),
      ]) {
        const { server, storage, firestore, send } = setup();
        const res = await call(server);
        expect(res.status).toBe(403);
        expect(storage.getPresignedUploadUrl).not.toHaveBeenCalled();
        expect(storage.head).not.toHaveBeenCalled();
        expect(firestore.updateBuild).not.toHaveBeenCalled();
        expect(firestore.updateProcessingStatus).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
      }
    });

    it('no key at all is 401 on all three routes', async () => {
      const { server } = setup();
      const bodies = ['presign', 'complete', 'failed'].map((r) =>
        server.request(`/upload/my-project/v1.0.0/metadata/${r}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      );
      for (const res of await Promise.all(bodies)) expect(res.status).toBe(401);
    });

    it('complete accepts only the object issued for that build: wrong key is 400, nothing queued', async () => {
      for (const zipKey of [
        'my-project/v1.0.0/builds/8/metadata-screenshots.zip', // another build of this project
        'other-project/v1.0.0/builds/7/metadata-screenshots.zip', // another project's object
        'my-project/v1.0.0/builds/7/bundle.zip', // another artifact of this build
        'my-project/v1.0.0/builds/7/../8/metadata-screenshots.zip',
      ]) {
        const { server, storage, send, firestore } = setup();
        const res = await complete(server, { buildId: 'build-123', zipKey });
        expect(res.status, zipKey).toBe(400);
        expect(storage.head).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
        expect(firestore.updateProcessingStatus).not.toHaveBeenCalled();
      }
    });

    it('complete with a build id that belongs to another version or does not exist is refused', async () => {
      const other = setup({ build: makeBuild({ versionId: 'v9' }) });
      expect((await complete(other.server, { buildId: 'build-123', zipKey: ZIP_KEY })).status).toBe(400);
      expect(other.send).not.toHaveBeenCalled();
      const none = setup({ build: null });
      expect((await complete(none.server, { buildId: 'nope', zipKey: ZIP_KEY })).status).toBe(404);
      expect(none.send).not.toHaveBeenCalled();
    });

    it('complete with the object missing (never PUT) or empty is 400 and queues nothing', async () => {
      for (const headSize of [null, 0]) {
        const { server, send, firestore } = setup({ headSize });
        const res = await complete(server, { buildId: 'build-123', zipKey: ZIP_KEY });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/not found/i);
        expect(send).not.toHaveBeenCalled();
        expect(firestore.updateProcessingStatus).not.toHaveBeenCalled();
      }
    });

    it('complete rejects an object over the 2 GiB safety limit with 413, deletes it and marks the build failed', async () => {
      const { server, storage, send, firestore } = setup({ headSize: 2 * 1024 * MIB + 1 });
      const res = await complete(server, { buildId: 'build-123', zipKey: ZIP_KEY });
      expect(res.status).toBe(413);
      expect((await res.json()).error).toMatch(/2 GiB/);
      expect(storage.delete).toHaveBeenCalledWith(ZIP_KEY);
      expect(firestore.updateBuild).toHaveBeenCalledWith(
        'my-project',
        'build-123',
        expect.objectContaining({ processingStatus: 'failed' })
      );
      expect(send).not.toHaveBeenCalled();
    });
  });

  it('guarantee-4b a second complete for the same build answers 200 and queues once', async () => {
    const first = setup();
    const r1 = await complete(first.server, { buildId: 'build-123', zipKey: ZIP_KEY });
    expect(r1.status).toBe(200);
    expect(first.send).toHaveBeenCalledTimes(1);

    // The build now carries the status the first call wrote.
    const again = setup({ build: makeBuild({ processingStatus: 'queued' }) });
    const r2 = await complete(again.server, { buildId: 'build-123', zipKey: ZIP_KEY });
    expect(r2.status).toBe(200);
    expect(again.send).not.toHaveBeenCalled();
    expect(again.firestore.updateProcessingStatus).not.toHaveBeenCalled();
    expect(again.storage.head).not.toHaveBeenCalled();
  });

  it('guarantee-4c complete on a build already marked failed is refused (409) and queues nothing', async () => {
    const { server, send } = setup({ build: makeBuild({ processingStatus: 'failed' }) });
    const res = await complete(server, { buildId: 'build-123', zipKey: ZIP_KEY });
    expect(res.status).toBe(409);
    expect(send).not.toHaveBeenCalled();
  });

  it('guarantee-5 same key, same queue message: the new route and the old route queue identical messages', async () => {
    const oldRoute = setup();
    await oldRoute.server.request('/upload/my-project/v1.0.0/metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip', ...AUTH },
      body: new Uint8Array([80, 75, 3, 4]),
    });
    const newRoute = setup({ headSize: 4 });
    const issued = await (await presign(newRoute.server)).json();
    await complete(newRoute.server, { buildId: issued.buildId, zipKey: issued.key });

    const strip = (m: Record<string, unknown>) => {
      const { timestamp: _t, trace: _tr, requestId: _r, ...rest } = m;
      return rest;
    };
    const a = strip(oldRoute.send.mock.calls[0][0] as Record<string, unknown>);
    const b = strip(newRoute.send.mock.calls[0][0] as Record<string, unknown>);
    expect(b).toEqual(a);
    expect(b).toEqual({ projectId: 'my-project', versionId: 'v1.0.0', buildId: 'build-123', zipKey: ZIP_KEY });
    expect(newRoute.storage.getPresignedUploadUrl).toHaveBeenCalledWith(ZIP_KEY, 'application/zip');
  });

  it('guarantee-5b complete records commitSha and branch from the query exactly as the old route does', async () => {
    const { server, firestore } = setup();
    const res = await complete(server, { buildId: 'build-123', zipKey: ZIP_KEY }, KEY_OK, '?commitSha=a1b2c3d4e5f6&branch=main');
    expect(res.status).toBe(200);
    expect(firestore.updateBuild).toHaveBeenCalledWith('my-project', 'build-123', { commitSha: 'a1b2c3d4e5f6', branch: 'main' });
  });

  it('guarantee-2d complete with no processing queue configured says so (queued false), as the old route does', async () => {
    const { server } = setup({ withQueue: false });
    const res = await complete(server, { buildId: 'build-123', zipKey: ZIP_KEY });
    expect(res.status).toBe(200);
    expect((await res.json()).queued).toBe(false);
  });

  it('guarantee-2e a queue send failure on complete is a 500 and the build is not marked queued', async () => {
    const { server, send, firestore } = setup();
    send.mockRejectedValueOnce(new Error('queue down'));
    const res = await complete(server, { buildId: 'build-123', zipKey: ZIP_KEY });
    expect(res.status).toBe(500);
    expect(firestore.updateProcessingStatus).not.toHaveBeenCalled();
  });
});
