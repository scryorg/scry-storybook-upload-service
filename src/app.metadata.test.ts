import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { app, type AppEnv } from './app.js';
import type { ApiKeyService } from './services/apikey/apikey.service.js';
import type { FirestoreService } from './services/firestore/firestore.service.js';
import type { Build } from './services/firestore/firestore.types.js';
import type { StorageService } from './services/storage/storage.service.js';

function createTestServer(options: {
  storage: StorageService;
  firestore?: FirestoreService;
  queue?: { send: (payload: unknown) => Promise<void> };
  apiKeyService?: ApiKeyService;
}) {
  const wrapper = new Hono<AppEnv>();
  wrapper.use('*', async (c, next) => {
    c.set('storage', options.storage);
    if (options.firestore) c.set('firestore', options.firestore);
    if (options.queue) c.set('processingQueue', options.queue as unknown as Queue);
    if (options.apiKeyService) c.set('apiKeyService', options.apiKeyService);
    await next();
  });
  wrapper.route('/', app);
  return wrapper;
}

function createFirestoreMock(overrides: Partial<FirestoreService> = {}): FirestoreService {
  const base: FirestoreService = {
    createBuild: vi.fn(async () => {
      throw new Error('createBuild was not mocked for this test');
    }),
    getBuild: vi.fn(async () => null),
    getProjectBuilds: vi.fn(async () => []),
    getBuildByVersion: vi.fn(async () => null),
    getLatestBuild: vi.fn(async () => null),
    updateBuild: vi.fn(async () => undefined),
    updateBuildCoverage: vi.fn(async () => undefined),
    updateProcessingStatus: vi.fn(async () => undefined),
    archiveBuild: vi.fn(async () => undefined),
    deleteBuild: vi.fn(async () => undefined),
  };

  return { ...base, ...overrides };
}

describe('app metadata route', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('stores metadata ZIP at build-specific R2 key and publishes queue message', async () => {
    const upload = vi.fn(async (key: string) => ({ url: `https://storage.test/${key}`, path: key }));
    const send = vi.fn(async () => undefined);
    const storage: StorageService = {
      upload: upload,
      getPresignedUploadUrl: vi.fn(),
      head: vi.fn(),
      getObjectStream: vi.fn(),
      getObjectRange: vi.fn(),      delete: vi.fn(),
      deleteByPrefix: vi.fn(),
    };

    const latestBuild: Build = {
        id: 'build-123',
        projectId: 'my-project',
        versionId: 'v1.0.0',
        buildNumber: 7,
        zipUrl: 'https://storage.test/my-project/v1.0.0/storybook.zip',
        status: 'active',
        createdAt: new Date(),
        createdBy: 'test',
    };
    const firestore = createFirestoreMock({
      getLatestBuild: vi.fn(async () => latestBuild),
      updateProcessingStatus: vi.fn(async () => undefined),
    });

    const server = createTestServer({
      storage,
      firestore,
      queue: { send },
    });

    const res = await server.request('/upload/my-project/v1.0.0/metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: new Uint8Array([80, 75, 3, 4]),
    });

    expect(res.status).toBe(201);
    expect(upload).toHaveBeenCalledWith(
      'my-project/v1.0.0/builds/7/metadata-screenshots.zip',
      expect.anything(),
      'application/zip'
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'my-project',
        versionId: 'v1.0.0',
        buildId: 'build-123',
        zipKey: 'my-project/v1.0.0/builds/7/metadata-screenshots.zip',
        timestamp: expect.any(Number),
      })
    );
    expect(firestore.updateProcessingStatus).toHaveBeenCalledWith('my-project', 'build-123', 'queued');

    const body = await res.json();
    expect(body.queued).toBe(true);
    expect(body.buildNumber).toBe(7);
  });

  // P13a: the indexer reads the build document to stamp build_sha on every row
  // it writes, so a commit that does not land here is lost for that build's life.
  it('records commitSha and branch on the build when the CLI sends them', async () => {
    const upload = vi.fn(async (key: string) => ({ url: `https://storage.test/${key}`, path: key }));
    const storage: StorageService = {
      upload: upload,
      getPresignedUploadUrl: vi.fn(),
      head: vi.fn(),
      getObjectStream: vi.fn(),
      getObjectRange: vi.fn(),      delete: vi.fn(),
      deleteByPrefix: vi.fn(),
    };

    const latestBuild: Build = {
      id: 'build-123',
      projectId: 'my-project',
      versionId: 'v1.0.0',
      buildNumber: 7,
      zipUrl: 'https://storage.test/my-project/v1.0.0/storybook.zip',
      status: 'active',
      createdAt: new Date(),
      createdBy: 'test',
    };
    const firestore = createFirestoreMock({ getLatestBuild: vi.fn(async () => latestBuild) });
    const server = createTestServer({ storage, firestore, queue: { send: vi.fn(async () => undefined) } });

    const res = await server.request(
      '/upload/my-project/v1.0.0/metadata?commitSha=a1b2c3d4e5f60718293a4b5c6d7e8f9012345678&branch=feature%2Flogin',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: new Uint8Array([80, 75, 3, 4]),
      }
    );

    expect(res.status).toBe(201);
    expect(firestore.updateBuild).toHaveBeenCalledWith('my-project', 'build-123', {
      commitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      branch: 'feature/login',
    });
  });

  // An older CLI sends neither, and must keep working exactly as before.
  it('writes no provenance and still queues when the CLI sends none', async () => {
    const upload = vi.fn(async (key: string) => ({ url: `https://storage.test/${key}`, path: key }));
    const send = vi.fn(async () => undefined);
    const storage: StorageService = {
      upload: upload,
      getPresignedUploadUrl: vi.fn(),
      head: vi.fn(),
      getObjectStream: vi.fn(),
      getObjectRange: vi.fn(),      delete: vi.fn(),
      deleteByPrefix: vi.fn(),
    };

    const latestBuild: Build = {
      id: 'build-123',
      projectId: 'my-project',
      versionId: 'v1.0.0',
      buildNumber: 7,
      zipUrl: 'https://storage.test/my-project/v1.0.0/storybook.zip',
      status: 'active',
      createdAt: new Date(),
      createdBy: 'test',
    };
    const firestore = createFirestoreMock({ getLatestBuild: vi.fn(async () => latestBuild) });
    const server = createTestServer({ storage, firestore, queue: { send } });

    const res = await server.request('/upload/my-project/v1.0.0/metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: new Uint8Array([80, 75, 3, 4]),
    });

    expect(res.status).toBe(201);
    expect(firestore.updateBuild).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalled();
  });

  // Provenance is a nicety; the upload it rides on is not. A build that indexes
  // without a SHA reports unknown freshness, which beats not indexing.
  it('still succeeds when recording provenance fails', async () => {
    const upload = vi.fn(async (key: string) => ({ url: `https://storage.test/${key}`, path: key }));
    const storage: StorageService = {
      upload: upload,
      getPresignedUploadUrl: vi.fn(),
      head: vi.fn(),
      getObjectStream: vi.fn(),
      getObjectRange: vi.fn(),      delete: vi.fn(),
      deleteByPrefix: vi.fn(),
    };

    const latestBuild: Build = {
      id: 'build-123',
      projectId: 'my-project',
      versionId: 'v1.0.0',
      buildNumber: 7,
      zipUrl: 'https://storage.test/my-project/v1.0.0/storybook.zip',
      status: 'active',
      createdAt: new Date(),
      createdBy: 'test',
    };
    const firestore = createFirestoreMock({
      getLatestBuild: vi.fn(async () => latestBuild),
      updateBuild: vi.fn(async () => {
        throw new Error('firestore is having a day');
      }),
    });
    const server = createTestServer({ storage, firestore, queue: { send: vi.fn(async () => undefined) } });

    const res = await server.request('/upload/my-project/v1.0.0/metadata?commitSha=abc1234', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: new Uint8Array([80, 75, 3, 4]),
    });

    expect(res.status).toBe(201);
  });

  it('rejects a commitSha that is not a git object name', async () => {
    const storage: StorageService = {
      upload: vi.fn(),
      getPresignedUploadUrl: vi.fn(),
      head: vi.fn(),
      getObjectStream: vi.fn(),
      getObjectRange: vi.fn(),      delete: vi.fn(),
      deleteByPrefix: vi.fn(),
    };
    const firestore = createFirestoreMock();
    const server = createTestServer({ storage, firestore });

    const res = await server.request('/upload/my-project/v1.0.0/metadata?commitSha=not-a-sha', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: new Uint8Array([80, 75, 3, 4]),
    });

    expect(res.status).toBe(400);
  });

  it('returns 400 when version parameter contains unsafe characters', async () => {
    const storage: StorageService = {
      upload: vi.fn(),
      getPresignedUploadUrl: vi.fn(),
      head: vi.fn(),
      getObjectStream: vi.fn(),
      getObjectRange: vi.fn(),      delete: vi.fn(),
      deleteByPrefix: vi.fn(),
    };
    const firestore = createFirestoreMock();
    const server = createTestServer({ storage, firestore });

    const res = await server.request('/upload/my-project/%24bad/metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: new Uint8Array([80, 75, 3, 4]),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when metadata ZIP body is empty', async () => {
    const storage: StorageService = {
      upload: vi.fn(),
      getPresignedUploadUrl: vi.fn(),
      head: vi.fn(),
      getObjectStream: vi.fn(),
      getObjectRange: vi.fn(),      delete: vi.fn(),
      deleteByPrefix: vi.fn(),
    };
    const firestore = createFirestoreMock();
    const server = createTestServer({ storage, firestore });

    const res = await server.request('/upload/my-project/v1.0.0/metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: new Uint8Array([]),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('No file provided');
  });

  it('returns 400 when no build exists for project/version', async () => {
    const storage: StorageService = {
      upload: vi.fn(),
      getPresignedUploadUrl: vi.fn(),
      head: vi.fn(),
      getObjectStream: vi.fn(),
      getObjectRange: vi.fn(),      delete: vi.fn(),
      deleteByPrefix: vi.fn(),
    };
    const firestore = createFirestoreMock({
      getLatestBuild: vi.fn(async () => null),
    });
    const server = createTestServer({ storage, firestore });

    const res = await server.request('/upload/my-project/v1.0.0/metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: new Uint8Array([1, 2, 3]),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Upload storybook.zip first');
  });

  it('works without queue binding and returns queued=false', async () => {
    const upload = vi.fn(async (key: string) => ({ url: `https://storage.test/${key}`, path: key }));
    const storage: StorageService = {
      upload: upload,
      getPresignedUploadUrl: vi.fn(),
      head: vi.fn(),
      getObjectStream: vi.fn(),
      getObjectRange: vi.fn(),      delete: vi.fn(),
      deleteByPrefix: vi.fn(),
    };
    const latestBuild: Build = {
        id: 'build-123',
        projectId: 'my-project',
        versionId: 'v1.0.0',
        buildNumber: 2,
        zipUrl: 'https://storage.test/my-project/v1.0.0/storybook.zip',
        status: 'active',
        createdAt: new Date(),
        createdBy: 'test',
    };
    const firestore = createFirestoreMock({
      getLatestBuild: vi.fn(async () => latestBuild),
      updateProcessingStatus: vi.fn(async () => undefined),
    });
    const server = createTestServer({ storage, firestore });

    const res = await server.request('/upload/my-project/v1.0.0/metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: new Uint8Array([1, 2, 3]),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.queued).toBe(false);
  });

  it('requires auth when API key service is configured', async () => {
    const storage: StorageService = {
      upload: vi.fn(),
      getPresignedUploadUrl: vi.fn(),
      head: vi.fn(),
      getObjectStream: vi.fn(),
      getObjectRange: vi.fn(),      delete: vi.fn(),
      deleteByPrefix: vi.fn(),
    };
    const firestore = createFirestoreMock();
    const apiKeyService: ApiKeyService = {
      createApiKey: vi.fn(),
      validateApiKey: vi.fn(),
      listApiKeys: vi.fn(),
      revokeApiKey: vi.fn(),
      deleteApiKey: vi.fn(),
      updateLastUsed: vi.fn(),
    };

    const server = createTestServer({ storage, firestore, apiKeyService });
    const res = await server.request('/upload/my-project/v1.0.0/metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: new Uint8Array([1, 2, 3]),
    });

    expect(res.status).toBe(401);
  });
});
