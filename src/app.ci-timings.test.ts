/**
 * CI timings recorded with every upload (storybook-preview-ci-runtime, ISSUES.md #54).
 *
 * The deployer sends the pre-upload part of its timings in the presigned-URL
 * body and the final record on POST /upload/:project/:version/builds/:n/ci-timings.
 * Before this fix the service dropped the first and had no route for the second,
 * so no build ever recorded how much CI time Scry took.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { app, type AppEnv } from './app.js';
import type { ApiKeyService } from './services/apikey/apikey.service.js';
import type { FirestoreService } from './services/firestore/firestore.service.js';
import type { Build } from './services/firestore/firestore.types.js';
import type { StorageService } from './services/storage/storage.service.js';

function createTestServer(options: {
  storage: StorageService;
  firestore?: FirestoreService;
  apiKeyService?: ApiKeyService;
}) {
  const wrapper = new Hono<AppEnv>();
  wrapper.use('*', async (c, next) => {
    c.set('storage', options.storage);
    if (options.firestore) c.set('firestore', options.firestore);
    if (options.apiKeyService) c.set('apiKeyService', options.apiKeyService);
    await next();
  });
  wrapper.route('/', app);
  return wrapper;
}

function createStorage(): StorageService {
  return {
    upload: vi.fn(async (key: string) => ({ url: `https://r2.example/${key}`, key })) as any,
    getPresignedUploadUrl: vi.fn(async (key: string, contentType: string) => ({
      url: `https://signed.example/${key}?sig=1`,
      key,
      contentType,
    })) as any,
    deleteByPrefix: vi.fn() as any,
  };
}

function makeBuild(overrides: Partial<Build> = {}): Build {
  return {
    id: 'build-7',
    projectId: 'my-proj',
    versionId: 'pr-123',
    buildNumber: 7,
    zipUrl: 'https://signed.example/my-proj/pr-123/storybook.zip',
    status: 'active',
    createdAt: new Date('2026-09-27T00:00:00Z'),
    createdBy: 'test',
    ...overrides,
  };
}

function createFirestore(overrides: Partial<FirestoreService> = {}): FirestoreService {
  return {
    createBuild: vi.fn(async (_p: string, data: any) => makeBuild({ versionId: data.versionId, zipUrl: data.zipUrl })),
    getBuild: vi.fn(async () => null),
    getProjectBuilds: vi.fn(async () => []),
    getBuildByVersion: vi.fn(async () => null),
    getLatestBuild: vi.fn(async () => null),
    getBuildByNumber: vi.fn(async () => null),
    updateBuild: vi.fn(async () => undefined),
    updateBuildCoverage: vi.fn(async () => undefined),
    archiveBuild: vi.fn(async () => undefined),
    deleteBuild: vi.fn(async () => undefined),
    trackEvent: vi.fn(async () => undefined),
    ...overrides,
  } as FirestoreService;
}

/** What deployer 0.8.0 sends before the upload (plan.md "CI timings"). */
const PRE_UPLOAD = {
  analyzeMs: 4210,
  executeMs: 212_000,
  executeSource: 'sbcov',
  archiveMs: 1830,
  stories: { declared: 461, passed: 457, failed: 4, timeouts: 0, notIndexed: 4 },
  timeLostMs: { timeout: 0, console_error: 3100 },
  sbcovVersion: '0.6.0',
  deployerVersion: '0.8.0',
  runner: 'self-hosted',
  ci: { provider: 'github', runId: '18123456789', runAttempt: 1, workflow: 'Storybook preview', job: 'deploy' },
  budgetMs: 350_500,
  overBudget: false,
  failedTimeShare: 0.12,
  concurrency: 4,
};

/** What it sends after the metadata ZIP. */
const FINAL = {
  uploadMs: 9_400,
  deployerTotalMs: 231_000,
  jobElapsedMs: 305_000,
  jobTimeSource: 'actions-api',
};

async function presign(server: ReturnType<typeof createTestServer>, body: unknown) {
  return server.request('/presigned-url/my-proj/pr-123/storybook.zip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('regression-storybook-preview-ci-runtime: CI timings stored with the upload', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  const logged = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.map((args: unknown[]) => args.map(String).join(' ')).join('\n');

  it('regression: the presigned-URL body ciTimings is stored on the new build document', async () => {
    const firestore = createFirestore();
    const server = createTestServer({ storage: createStorage(), firestore });

    const res = await presign(server, { contentType: 'application/zip', ciTimings: PRE_UPLOAD });
    expect(res.status).toBe(200);

    const data = (firestore.createBuild as any).mock.calls[0][1];
    expect(data.ciTimings).toEqual(PRE_UPLOAD);
  });

  it('regression: storybook_uploaded carries ciExecuteMs, ciRunner, ciStoryCount, ciOverBudget', async () => {
    const firestore = createFirestore();
    const server = createTestServer({ storage: createStorage(), firestore });

    await presign(server, { contentType: 'application/zip', ciTimings: PRE_UPLOAD });

    expect(firestore.trackEvent).toHaveBeenCalledWith('storybook_uploaded', {
      projectId: 'my-proj',
      buildId: 'build-7',
      buildNumber: 7,
      versionId: 'pr-123',
      ciExecuteMs: 212_000,
      ciRunner: 'self-hosted',
      ciStoryCount: 461,
      ciOverBudget: false,
    });
  });

  it('guarantee-7 absent-not-zero: an old-deployer body creates the build with no ciTimings field and counts it absent', async () => {
    const firestore = createFirestore();
    const server = createTestServer({ storage: createStorage(), firestore });

    const res = await presign(server, { contentType: 'application/zip' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.buildId).toBe('build-7');

    const data = (firestore.createBuild as any).mock.calls[0][1];
    expect('ciTimings' in data).toBe(false);

    const event = (firestore.trackEvent as any).mock.calls[0][1];
    expect(Object.keys(event).filter((k) => k.startsWith('ci'))).toEqual([]);

    expect(logged(logSpy)).toContain('ci_timings_absent=1');
  });

  it('guarantee-7 absent-not-zero: a partial block stores only the fields sent, never a 0 for the rest', async () => {
    const firestore = createFirestore();
    const server = createTestServer({ storage: createStorage(), firestore });

    await presign(server, { contentType: 'application/zip', ciTimings: { analyzeMs: 1200, runner: 'unknown' } });

    const data = (firestore.createBuild as any).mock.calls[0][1];
    expect(data.ciTimings).toEqual({ analyzeMs: 1200, runner: 'unknown' });
    const event = (firestore.trackEvent as any).mock.calls[0][1];
    expect(event.ciRunner).toBe('unknown');
    expect('ciExecuteMs' in event).toBe(false);
    expect('ciStoryCount' in event).toBe(false);
  });

  it('guarantee-7 bad values rejected: a negative, a >24 h and an oversized string are not stored; the build is still created and the drop is counted', async () => {
    for (const bad of [
      { executeMs: -1 },
      { executeMs: 24 * 60 * 60 * 1000 },
      { executeMs: Number.NaN },
      { executeMs: '212000' },
      { sbcovVersion: 'x'.repeat(200) },
      { runner: 'my-laptop' },
      { stories: { declared: 1.5 } },
      { ci: { runId: 'a b c; drop' } },
      { failedTimeShare: 1.2 },
      { failedTimeShare: -0.1 },
      { concurrency: 0 },
      { concurrency: 65 },
      { concurrency: 2.5 },
    ]) {
      logSpy.mockClear();
      warnSpy.mockClear();
      const firestore = createFirestore();
      const server = createTestServer({ storage: createStorage(), firestore });

      const res = await presign(server, { contentType: 'application/zip', ciTimings: { ...PRE_UPLOAD, ...bad } });
      expect(res.status, JSON.stringify(bad)).toBe(200);
      const data = (firestore.createBuild as any).mock.calls[0][1];
      expect('ciTimings' in data, JSON.stringify(bad)).toBe(false);
      expect(logged(warnSpy), JSON.stringify(bad)).toContain('ci_timings_invalid=1');
    }
  });

  it('guarantee-7 unknown keys dropped: extra keys are stripped, timeLostMs keeps only short reason keys with sane values', async () => {
    const firestore = createFirestore();
    const server = createTestServer({ storage: createStorage(), firestore });

    await presign(server, {
      contentType: 'application/zip',
      ciTimings: {
        ...PRE_UPLOAD,
        secretToken: 'ghp_should_not_be_stored',
        ci: { ...PRE_UPLOAD.ci, env: { GITHUB_TOKEN: 'nope' } },
        timeLostMs: {
          timeout: 1500,
          render_timeout: 400,
          'Not A Reason!': 10,
          ['x'.repeat(80)]: 10,
          negative: -5,
          huge: 1e12,
        },
      },
    });

    const stored = (firestore.createBuild as any).mock.calls[0][1].ciTimings;
    expect(stored.secretToken).toBeUndefined();
    expect(stored.ci).toEqual(PRE_UPLOAD.ci);
    expect(stored.timeLostMs).toEqual({ timeout: 1500, render_timeout: 400 });
  });
});

describe('POST /upload/:project/:version/builds/:buildNumber/ci-timings', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  const url = '/upload/my-proj/pr-123/builds/7/ci-timings';
  const post = (server: ReturnType<typeof createTestServer>, body: unknown, headers: Record<string, string> = {}, path = url) =>
    server.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('merges the final record into the build ciTimings', async () => {
    const build = makeBuild({ ciTimings: PRE_UPLOAD as any });
    const firestore = createFirestore({ getBuildByNumber: vi.fn(async () => build) });
    const server = createTestServer({ storage: createStorage(), firestore });

    const res = await post(server, { ciTimings: FINAL });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.buildId).toBe('build-7');

    expect(firestore.getBuildByNumber).toHaveBeenCalledWith('my-proj', 7);
    expect(firestore.updateBuild).toHaveBeenCalledWith('my-proj', 'build-7', {
      ciTimings: { ...PRE_UPLOAD, ...FINAL },
    });
  });

  it('accepts the record as the bare body too, and is idempotent', async () => {
    let doc = makeBuild({ ciTimings: PRE_UPLOAD as any });
    const firestore = createFirestore({
      getBuildByNumber: vi.fn(async () => doc),
      updateBuild: vi.fn(async (_p: string, _b: string, u: any) => {
        doc = { ...doc, ...u };
      }),
    });
    const server = createTestServer({ storage: createStorage(), firestore });

    expect((await post(server, FINAL)).status).toBe(200);
    const first = doc.ciTimings;
    expect((await post(server, FINAL)).status).toBe(200);
    expect(doc.ciTimings).toEqual(first);
    expect(doc.ciTimings).toEqual({ ...PRE_UPLOAD, ...FINAL });
  });

  it('merges nested blocks rather than replacing them', async () => {
    const build = makeBuild({ ciTimings: { stories: { declared: 461 }, ci: { runId: '1' } } as any });
    const firestore = createFirestore({ getBuildByNumber: vi.fn(async () => build) });
    const server = createTestServer({ storage: createStorage(), firestore });

    await post(server, { ciTimings: { stories: { passed: 457 }, ci: { runAttempt: 2 } } });
    expect((firestore.updateBuild as any).mock.calls[0][2].ciTimings).toEqual({
      stories: { declared: 461, passed: 457 },
      ci: { runId: '1', runAttempt: 2 },
    });
  });

  it('guarantee-7 bad values rejected: 400 with the issue paths, nothing written', async () => {
    const firestore = createFirestore({ getBuildByNumber: vi.fn(async () => makeBuild()) });
    const server = createTestServer({ storage: createStorage(), firestore });

    const res = await post(server, { ciTimings: { uploadMs: -3, jobTimeSource: 'guess' } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('uploadMs');
    expect(body.error).toContain('jobTimeSource');
    expect(firestore.updateBuild).not.toHaveBeenCalled();
  });

  it('rejects a body that is not an object or is empty', async () => {
    const firestore = createFirestore({ getBuildByNumber: vi.fn(async () => makeBuild()) });
    const server = createTestServer({ storage: createStorage(), firestore });

    expect((await post(server, [1, 2])).status).toBe(400);
    expect((await post(server, {})).status).toBe(400);
    expect(firestore.updateBuild).not.toHaveBeenCalled();
  });

  it('404 when the build number does not exist for the project', async () => {
    const firestore = createFirestore({ getBuildByNumber: vi.fn(async () => null) });
    const server = createTestServer({ storage: createStorage(), firestore });

    const res = await post(server, { ciTimings: FINAL });
    expect(res.status).toBe(404);
    expect(firestore.updateBuild).not.toHaveBeenCalled();
  });

  it('404 when the build number belongs to another version of the project', async () => {
    const firestore = createFirestore({
      getBuildByNumber: vi.fn(async () => makeBuild({ versionId: 'main' })),
    });
    const server = createTestServer({ storage: createStorage(), firestore });

    const res = await post(server, { ciTimings: FINAL });
    expect(res.status).toBe(404);
    expect(firestore.updateBuild).not.toHaveBeenCalled();
  });

  it('400 on a non-numeric build number', async () => {
    const firestore = createFirestore();
    const server = createTestServer({ storage: createStorage(), firestore });
    const res = await post(server, { ciTimings: FINAL }, {}, '/upload/my-proj/pr-123/builds/abc/ci-timings');
    expect(res.status).toBe(400);
  });

  describe('auth (same as the other upload routes)', () => {
    const apiKeyService: ApiKeyService = {
      createApiKey: vi.fn() as any,
      validateApiKey: vi.fn(async () => ({
        valid: true,
        apiKey: { id: 'k1', name: 'ci', prefix: 'scry_proj_my' },
      })) as any,
      listApiKeys: vi.fn() as any,
      revokeApiKey: vi.fn() as any,
      deleteApiKey: vi.fn() as any,
      updateLastUsed: vi.fn(async () => undefined) as any,
    };

    it('401 without an API key', async () => {
      const firestore = createFirestore({ getBuildByNumber: vi.fn(async () => makeBuild()) });
      const server = createTestServer({ storage: createStorage(), firestore, apiKeyService });
      const res = await post(server, { ciTimings: FINAL });
      expect(res.status).toBe(401);
      expect(firestore.updateBuild).not.toHaveBeenCalled();
    });

    it("403 with another project's key, nothing read or written", async () => {
      const firestore = createFirestore({ getBuildByNumber: vi.fn(async () => makeBuild()) });
      const server = createTestServer({ storage: createStorage(), firestore, apiKeyService });
      const res = await post(server, { ciTimings: FINAL }, { 'X-API-Key': 'scry_proj_other-proj_abcdef' });
      expect(res.status).toBe(403);
      expect(firestore.getBuildByNumber).not.toHaveBeenCalled();
      expect(firestore.updateBuild).not.toHaveBeenCalled();
    });

    it("200 with the project's own key", async () => {
      const firestore = createFirestore({ getBuildByNumber: vi.fn(async () => makeBuild()) });
      const server = createTestServer({ storage: createStorage(), firestore, apiKeyService });
      const res = await post(server, { ciTimings: FINAL }, { 'X-API-Key': 'scry_proj_my-proj_abcdef' });
      expect(res.status).toBe(200);
      expect(firestore.updateBuild).toHaveBeenCalledTimes(1);
    });
  });
});
