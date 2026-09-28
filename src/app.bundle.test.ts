/**
 * capture-sources PR 2: the SCF bundle upload route
 * (`/presigned-url/:project/:version/bundle.zip` + `/upload/:project/:version/bundle/complete`).
 *
 * guarantee-6 (a bundle ZIP holding only PNG/JPEG/WebP + JSON is accepted; anything else is
 * rejected, nothing stored or queued) and guarantee-7 (the vendored validator accepts/rejects a
 * bundle with the same messages the CLI would, never half-accepting) against real conformance
 * fixtures copied from scryorg/scry-capture-format (`__fixtures__/`, sha in src/vendor/scf/VERSION).
 * guarantee-3 (auth) lives in app.auth-scope.test.ts, which this file does not repeat.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { app, type AppEnv } from './app.js';
import type { FirestoreService } from './services/firestore/firestore.service.js';
import type { Build } from './services/firestore/firestore.types.js';
import { MockStorageService } from './services/storage/storage.mock.js';
import { buildZip, zipDirectory } from './bundle/__tests__/test-helpers.js';

const FIXTURES_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bundle/__fixtures__');

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
    trackEvent: vi.fn(async () => undefined),
  };
  return { ...base, ...overrides };
}

function createServer(options: { storage: MockStorageService; firestore: FirestoreService; queue?: { send: (payload: unknown) => Promise<void> } }) {
  const server = new Hono<AppEnv>();
  server.use('*', async (c, next) => {
    c.set('storage', options.storage);
    c.set('firestore', options.firestore);
    if (options.queue) c.set('processingQueue', options.queue as unknown as Queue);
    await next();
  });
  server.route('/', app);
  return server;
}

const build100: Build = {
  id: 'build-100',
  projectId: 'acme',
  versionId: 'main',
  buildNumber: 5,
  zipUrl: '',
  status: 'active',
  createdAt: new Date(),
  createdBy: 'test',
};

describe('POST /presigned-url/:project/:version/bundle.zip', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('parses ?source, creates the build with source, and keys the presigned URL by build number', async () => {
    const storage = new MockStorageService({ baseUrl: 'https://storage.test' });
    const createBuild = vi.fn(async () => build100);
    const firestore = createFirestoreMock({ createBuild });
    const server = createServer({ storage, firestore });

    const res = await server.request('/presigned-url/acme/main/bundle.zip?source=storybook-rn:ios', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.buildId).toBe('build-100');
    expect(body.buildNumber).toBe(5);
    expect(body.fields.key).toBe('acme/main/builds/5/bundle.zip');

    expect(createBuild).toHaveBeenCalledWith(
      'acme',
      expect.objectContaining({ versionId: 'main', source: { kind: 'storybook-rn', platform: 'ios' } })
    );
  });

  it('400s on a missing source, and creates no build', async () => {
    const storage = new MockStorageService();
    const createBuild = vi.fn(async () => build100);
    const firestore = createFirestoreMock({ createBuild });
    const server = createServer({ storage, firestore });

    const res = await server.request('/presigned-url/acme/main/bundle.zip', { method: 'POST' });
    expect(res.status).toBe(400);
    expect(createBuild).not.toHaveBeenCalled();
  });

  it.each(['storybook', 'not-a-registered-kind:web', 'storybook:mars', ''])(
    '400s on the invalid source %s, and creates no build',
    async (source) => {
      const storage = new MockStorageService();
      const createBuild = vi.fn(async () => build100);
      const firestore = createFirestoreMock({ createBuild });
      const server = createServer({ storage, firestore });

      const res = await server.request(`/presigned-url/acme/main/bundle.zip?source=${encodeURIComponent(source)}`, { method: 'POST' });
      expect(res.status).toBe(400);
      expect(createBuild).not.toHaveBeenCalled();
    }
  );
});

describe('POST /upload/:project/:version/bundle/complete', () => {
  beforeEach(() => vi.restoreAllMocks());

  const ZIP_KEY = 'acme/main/builds/5/bundle.zip';

  it('accepts a valid SCF bundle (conformance fixture valid/basic): validates, enqueues format:"scf", marks queued', async () => {
    const storage = new MockStorageService();
    storage.seed(ZIP_KEY, await zipDirectory(path.join(FIXTURES_ROOT, 'valid-basic')));
    const getBuild = vi.fn(async () => build100);
    const updateProcessingStatus = vi.fn(async () => undefined);
    const firestore = createFirestoreMock({ getBuild, updateProcessingStatus });
    const send = vi.fn(async () => undefined);
    const server = createServer({ storage, firestore, queue: { send } });

    const res = await server.request('/upload/acme/main/bundle/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ buildId: 'build-100', zipKey: ZIP_KEY }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, queued: true, buildId: 'build-100', buildNumber: 5 });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'acme', versionId: 'main', buildId: 'build-100', zipKey: ZIP_KEY, format: 'scf' })
    );
    expect(updateProcessingStatus).toHaveBeenCalledWith('acme', 'build-100', 'queued');
    // the bundle stays: nothing here should have deleted it
    expect(await storage.head(ZIP_KEY)).not.toBeNull();
  });

  it.each([
    ['invalid-forbidden-member', ['FORBIDDEN_MEMBER']],
    ['invalid-duplicate-ids', ['DUPLICATE_ID']],
    ['invalid-unsafe-link-javascript', ['links.live.not_https']],
  ] as const)(
    'rejects the conformance fixture %s with the same error codes as expected.json (G7): 422, object deleted, build marked failed, nothing queued',
    async (name, expectedCodes) => {
      const storage = new MockStorageService();
      storage.seed(ZIP_KEY, await zipDirectory(path.join(FIXTURES_ROOT, name, 'bundle')));
      const expectedJson = JSON.parse(await readFile(path.join(FIXTURES_ROOT, name, 'expected.json'), 'utf8')) as { errors: string[] };
      expect(expectedCodes).toEqual(expectedJson.errors); // the fixture and this test agree on what "expected" means

      const getBuild = vi.fn(async () => build100);
      const updateBuild = vi.fn(async () => undefined);
      const firestore = createFirestoreMock({ getBuild, updateBuild });
      const send = vi.fn(async () => undefined);
      const server = createServer({ storage, firestore, queue: { send } });

      const res = await server.request('/upload/acme/main/bundle/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ buildId: 'build-100', zipKey: ZIP_KEY }),
      });

      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.errors.map((e: { code: string }) => e.code)).toEqual(expect.arrayContaining(expectedCodes));

      expect(send).not.toHaveBeenCalled();
      expect(await storage.head(ZIP_KEY)).toBeNull(); // rejected object is deleted
      expect(updateBuild).toHaveBeenCalledWith(
        'acme',
        'build-100',
        expect.objectContaining({
          processingStatus: 'failed',
          validationErrors: expect.arrayContaining(expectedCodes.map((code) => expect.objectContaining({ code }))),
        })
      );
    }
  );

  it('guarantee-6: a bundle whose "image" is actually not an image (renamed binary / zip-in-zip) is rejected by content sniff, not extension', async () => {
    const scf = {
      scf: '1.0',
      source: { kind: 'storybook', platform: 'web' },
      captures: [{ id: 'a', image: 'images/a.png' }],
    };
    // a real nested ZIP's bytes, named like a PNG — extension says image, magic bytes say ZIP.
    const nested = buildZip([{ name: 'x.txt', data: Buffer.from('hi') }]);
    const zip = buildZip([
      { name: 'scf.json', data: Buffer.from(JSON.stringify(scf)) },
      { name: 'images/a.png', data: nested },
    ]);

    const storage = new MockStorageService();
    storage.seed(ZIP_KEY, zip);
    const firestore = createFirestoreMock({ getBuild: vi.fn(async () => build100) });
    const send = vi.fn(async () => undefined);
    const server = createServer({ storage, firestore, queue: { send } });

    const res = await server.request('/upload/acme/main/bundle/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ buildId: 'build-100', zipKey: ZIP_KEY }),
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.errors.map((e: { code: string }) => e.code)).toContain('IMAGE_FORMAT_INVALID');
    expect(send).not.toHaveBeenCalled();
    expect(await storage.head(ZIP_KEY)).toBeNull();
  });

  it.each(['evil.html', 'evil.js'])(
    'guarantee-6: an extra %s member not referenced by any capture is rejected (FORBIDDEN_MEMBER), nothing stored or queued',
    async (filename) => {
      const scf = {
        scf: '1.0',
        source: { kind: 'storybook', platform: 'web' },
        captures: [{ id: 'a', image: 'images/a.png' }],
      };
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const zip = buildZip([
        { name: 'scf.json', data: Buffer.from(JSON.stringify(scf)) },
        { name: 'images/a.png', data: png },
        { name: filename, data: Buffer.from('<script>alert(1)</script>') },
      ]);

      const storage = new MockStorageService();
      storage.seed(ZIP_KEY, zip);
      const firestore = createFirestoreMock({ getBuild: vi.fn(async () => build100) });
      const send = vi.fn(async () => undefined);
      const server = createServer({ storage, firestore, queue: { send } });

      const res = await server.request('/upload/acme/main/bundle/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ buildId: 'build-100', zipKey: ZIP_KEY }),
      });

      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.errors.map((e: { code: string }) => e.code)).toContain('FORBIDDEN_MEMBER');
      expect(send).not.toHaveBeenCalled();
      expect(await storage.head(ZIP_KEY)).toBeNull();
    }
  );

  it('ledger F11: a bundle whose ZIP contains a path-traversal entry is rejected before it ever reaches the validator', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const zip = buildZip([
      { name: 'scf.json', data: Buffer.from('{"scf":"1.0","source":{"kind":"storybook"},"captures":[]}') },
      { name: '../../etc/passwd', data: png },
    ]);
    const storage = new MockStorageService();
    storage.seed(ZIP_KEY, zip);
    const firestore = createFirestoreMock({ getBuild: vi.fn(async () => build100) });
    const send = vi.fn(async () => undefined);
    const server = createServer({ storage, firestore, queue: { send } });

    const res = await server.request('/upload/acme/main/bundle/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ buildId: 'build-100', zipKey: ZIP_KEY }),
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.errors.map((e: { code: string }) => e.code)).toContain('BUNDLE_UNSAFE_PATH');
    expect(send).not.toHaveBeenCalled();
    expect(await storage.head(ZIP_KEY)).toBeNull();
  });

  it('400s when the object has not been uploaded yet, without touching the build', async () => {
    const storage = new MockStorageService(); // nothing seeded at ZIP_KEY
    const updateBuild = vi.fn(async () => undefined);
    const firestore = createFirestoreMock({ getBuild: vi.fn(async () => build100), updateBuild });
    const server = createServer({ storage, firestore });

    const res = await server.request('/upload/acme/main/bundle/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ buildId: 'build-100', zipKey: ZIP_KEY }),
    });

    expect(res.status).toBe(400);
    expect(updateBuild).not.toHaveBeenCalled();
  });

  it('404s when buildId does not resolve to a build', async () => {
    const storage = new MockStorageService();
    storage.seed(ZIP_KEY, buildZip([{ name: 'scf.json', data: Buffer.from('{}') }]));
    const firestore = createFirestoreMock({ getBuild: vi.fn(async () => null) });
    const server = createServer({ storage, firestore });

    const res = await server.request('/upload/acme/main/bundle/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ buildId: 'nope', zipKey: ZIP_KEY }),
    });
    expect(res.status).toBe(404);
  });

  it('400s when zipKey is not scoped under this project/version', async () => {
    const storage = new MockStorageService();
    const firestore = createFirestoreMock({ getBuild: vi.fn(async () => build100) });
    const server = createServer({ storage, firestore });

    const res = await server.request('/upload/acme/main/bundle/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ buildId: 'build-100', zipKey: 'someone-else/other/builds/1/bundle.zip' }),
    });
    expect(res.status).toBe(400);
  });

  it('400s when the build belongs to a different version', async () => {
    const storage = new MockStorageService();
    storage.seed(ZIP_KEY, buildZip([{ name: 'scf.json', data: Buffer.from('{}') }]));
    const firestore = createFirestoreMock({ getBuild: vi.fn(async () => ({ ...build100, versionId: 'other-version' })) });
    const server = createServer({ storage, firestore });

    const res = await server.request('/upload/acme/main/bundle/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ buildId: 'build-100', zipKey: ZIP_KEY }),
    });
    expect(res.status).toBe(400);
  });
});
