import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { app, type AppEnv } from './app.js';

import type { StorageService } from './services/storage/storage.service.js';
import type { FirestoreService } from './services/firestore/firestore.service.js';

function createTestServer(options: { storage: StorageService; firestore?: FirestoreService }) {
  const wrapper = new Hono<AppEnv>();
  wrapper.use('*', async (c, next) => {
    c.set('storage', options.storage);
    if (options.firestore) c.set('firestore', options.firestore);
    await next();
  });
  wrapper.route('/', app);
  return wrapper;
}

describe('coverage endpoints', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('POST /upload/:project/:version uploads storybook + coverage and creates a build with coverage', async () => {
    const uploadMock = vi.fn(async (key: string) => ({ url: `https://storage.test/${key}`, path: key }));

    const storage: StorageService = {
      upload: uploadMock as any,
      getPresignedUploadUrl: vi.fn() as any,
      head: vi.fn() as any,
      getObjectStream: vi.fn() as any,
      getObjectRange: vi.fn() as any,      delete: vi.fn() as any,
      deleteByPrefix: vi.fn() as any,
    };

    const createBuildMock = vi.fn(async (_projectId: string, data: any) => ({
      id: 'build-1',
      projectId: 'my-project',
      versionId: data.versionId,
      buildNumber: 1,
      zipUrl: data.zipUrl,
      status: 'active',
      createdAt: new Date(),
      createdBy: 'test',
      coverage: data.coverage,
    }));

    const firestore: FirestoreService = {
      createBuild: createBuildMock as any,
      getBuild: vi.fn() as any,
      getProjectBuilds: vi.fn() as any,
      getBuildByVersion: vi.fn() as any,
      getLatestBuild: vi.fn() as any,
      updateBuild: vi.fn() as any,
      updateBuildCoverage: vi.fn() as any,
      archiveBuild: vi.fn() as any,
      deleteBuild: vi.fn() as any,
    };

    const server = createTestServer({ storage, firestore });

    const coverageJson = {
      summary: {
        metrics: {
          componentCoverage: 0.91,
          propCoverage: 0.81,
          variantCoverage: 0.71,
        },
        health: {
          passRate: 0.96,
          failingStories: 1,
        },
        totalComponents: 50,
        componentsWithStories: 45,
      },
      qualityGate: {
        passed: true,
        checks: [{ name: 'passRate', threshold: 0.9, actual: 0.96, passed: true }],
      },
      generatedAt: '2026-01-02T00:00:00.000Z',
    };

    const form = new FormData();
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'storybook.zip', { type: 'application/zip' }));
    form.set('coverage', new File([JSON.stringify(coverageJson)], 'coverage.json', { type: 'application/json' }));

    const res = await server.request('/upload/my-project/v1.0.0', {
      method: 'POST',
      body: form,
    });

    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.data.coverageUrl).toBe('https://storage.test/my-project/v1.0.0/coverage-report.json');
    expect(body.data.buildId).toBe('build-1');

    // storage.upload called for coverage + storybook
    expect(uploadMock).toHaveBeenCalledWith(
      'my-project/v1.0.0/coverage-report.json',
      expect.anything(),
      'application/json'
    );
    expect(uploadMock).toHaveBeenCalledWith('my-project/v1.0.0/storybook.zip', expect.anything(), 'application/zip');

    // coverage is normalized into Firestore build payload
    const buildData = (createBuildMock.mock.calls[0] as any)[1];
    expect(buildData.coverage.reportUrl).toBe('https://storage.test/my-project/v1.0.0/coverage-report.json');
    expect(buildData.coverage.summary.totalComponents).toBe(50);
    expect(buildData.coverage.summary.componentCoverage).toBe(0.91);
  });

  it('POST /upload/:project/:version/coverage uploads JSON and updates Firestore coverage', async () => {
    const uploadMock = vi.fn(async (key: string) => ({ url: `https://storage.test/${key}`, path: key }));

    const storage: StorageService = {
      upload: uploadMock as any,
      getPresignedUploadUrl: vi.fn() as any,
      head: vi.fn() as any,
      getObjectStream: vi.fn() as any,
      getObjectRange: vi.fn() as any,      delete: vi.fn() as any,
      deleteByPrefix: vi.fn() as any,
    };

    const updateBuildCoverageMock = vi.fn(async () => undefined);

    const firestore: FirestoreService = {
      createBuild: vi.fn() as any,
      getBuild: vi.fn() as any,
      getProjectBuilds: vi.fn() as any,
      getBuildByVersion: vi.fn(async () => ({
        id: 'build-1',
        projectId: 'my-project',
        versionId: 'v1.0.0',
        buildNumber: 1,
        zipUrl: 'https://storage.test/my-project/v1.0.0/storybook.zip',
        status: 'active',
        createdAt: new Date(),
        createdBy: 'test',
      })) as any,
      getLatestBuild: vi.fn() as any,
      updateBuild: vi.fn() as any,
      updateBuildCoverage: updateBuildCoverageMock as any,
      archiveBuild: vi.fn() as any,
      deleteBuild: vi.fn() as any,
    };

    const server = createTestServer({ storage, firestore });

    const payload = {
      summary: {
        componentCoverage: 0.9,
        propCoverage: 0.8,
        variantCoverage: 0.7,
        passRate: 0.95,
        totalComponents: 10,
        componentsWithStories: 9,
        failingStories: 1,
      },
      qualityGate: {
        passed: true,
        checks: [{ name: 'passRate', threshold: 0.9, actual: 0.95, passed: true }],
      },
      generatedAt: '2026-01-01T00:00:00.000Z',
    };

    const res = await server.request('/upload/my-project/v1.0.0/coverage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(201);

    expect(uploadMock).toHaveBeenCalledWith(
      'my-project/v1.0.0/coverage-report.json',
      expect.anything(),
      'application/json'
    );

    expect(updateBuildCoverageMock).toHaveBeenCalledWith(
      'my-project',
      'build-1',
      expect.objectContaining({
        reportUrl: 'https://storage.test/my-project/v1.0.0/coverage-report.json',
      })
    );
  });

  // P13a: the report has always carried the commit; the build document has not,
  // so search could name the deploy a component came from but not the code.
  it('POST /upload/:project/:version/coverage records the report\'s commit on the build', async () => {
    const uploadMock = vi.fn(async (key: string) => ({ url: `https://storage.test/${key}`, path: key }));
    const storage: StorageService = {
      upload: uploadMock as any,
      getPresignedUploadUrl: vi.fn() as any,
      head: vi.fn() as any,
      getObjectStream: vi.fn() as any,
      getObjectRange: vi.fn() as any,      delete: vi.fn() as any,
      deleteByPrefix: vi.fn() as any,
    };

    const updateBuildMock = vi.fn(async () => undefined);
    const firestore: FirestoreService = {
      createBuild: vi.fn() as any,
      getBuild: vi.fn() as any,
      getProjectBuilds: vi.fn() as any,
      getBuildByVersion: vi.fn(async () => ({
        id: 'build-1',
        projectId: 'my-project',
        versionId: 'v1.0.0',
        buildNumber: 1,
        zipUrl: 'https://storage.test/my-project/v1.0.0/storybook.zip',
        status: 'active',
        createdAt: new Date(),
        createdBy: 'test',
      })) as any,
      getLatestBuild: vi.fn() as any,
      updateBuild: updateBuildMock as any,
      updateBuildCoverage: vi.fn(async () => undefined) as any,
      archiveBuild: vi.fn() as any,
      deleteBuild: vi.fn() as any,
    };

    const server = createTestServer({ storage, firestore });

    const payload = {
      git: {
        commitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        branch: 'main',
        baseBranch: 'main',
        baseCommitSha: 'ffffffff',
      },
      summary: {
        componentCoverage: 0.9,
        propCoverage: 0.8,
        variantCoverage: 0.7,
        passRate: 0.95,
        totalComponents: 10,
        componentsWithStories: 9,
        failingStories: 1,
      },
      qualityGate: { passed: true, checks: [] },
      generatedAt: '2026-01-01T00:00:00.000Z',
    };

    const res = await server.request('/upload/my-project/v1.0.0/coverage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(201);
    expect(updateBuildMock).toHaveBeenCalledWith('my-project', 'build-1', {
      commitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      branch: 'main',
    });
  });

  // A report from a run with git analysis off carries empty strings, which mean
  // unknown. Writing them would put a commit nobody can look up on the build.
  it('POST /upload/:project/:version/coverage writes no provenance for a git-less report', async () => {
    const uploadMock = vi.fn(async (key: string) => ({ url: `https://storage.test/${key}`, path: key }));
    const storage: StorageService = {
      upload: uploadMock as any,
      getPresignedUploadUrl: vi.fn() as any,
      head: vi.fn() as any,
      getObjectStream: vi.fn() as any,
      getObjectRange: vi.fn() as any,      delete: vi.fn() as any,
      deleteByPrefix: vi.fn() as any,
    };

    const updateBuildMock = vi.fn(async () => undefined);
    const firestore: FirestoreService = {
      createBuild: vi.fn() as any,
      getBuild: vi.fn() as any,
      getProjectBuilds: vi.fn() as any,
      getBuildByVersion: vi.fn(async () => ({
        id: 'build-1',
        projectId: 'my-project',
        versionId: 'v1.0.0',
        buildNumber: 1,
        zipUrl: 'https://storage.test/my-project/v1.0.0/storybook.zip',
        status: 'active',
        createdAt: new Date(),
        createdBy: 'test',
      })) as any,
      getLatestBuild: vi.fn() as any,
      updateBuild: updateBuildMock as any,
      updateBuildCoverage: vi.fn(async () => undefined) as any,
      archiveBuild: vi.fn() as any,
      deleteBuild: vi.fn() as any,
    };

    const server = createTestServer({ storage, firestore });

    const res = await server.request('/upload/my-project/v1.0.0/coverage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        git: { commitSha: '', branch: '', baseBranch: null, baseCommitSha: null },
        summary: {
          componentCoverage: 0.9,
          propCoverage: 0.8,
          variantCoverage: 0.7,
          passRate: 0.95,
          totalComponents: 10,
          componentsWithStories: 9,
          failingStories: 1,
        },
        qualityGate: { passed: true, checks: [] },
        generatedAt: '2026-01-01T00:00:00.000Z',
      }),
    });

    expect(res.status).toBe(201);
    expect(updateBuildMock).not.toHaveBeenCalled();
  });
});
