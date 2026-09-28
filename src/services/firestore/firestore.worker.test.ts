import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FirestoreServiceWorker } from './firestore.worker.js';

function createSvc() {
  const svc = new FirestoreServiceWorker({
    projectId: 'firebase-proj',
    clientEmail: 'test@example.com',
    privateKey: '-----BEGIN PRIVATE KEY-----\\nZm9v\\n-----END PRIVATE KEY-----',
    serviceAccountId: 'upload-service',
  });

  // Bypass token generation logic.
  (svc as any).accessToken = 'test-token';
  (svc as any).tokenExpiry = Date.now() + 60_000;

  return svc;
}

describe('FirestoreServiceWorker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('createBuild() increments counter when it exists and writes the build doc', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase();

      if (method === 'GET' && url.includes('/documents/projects/my-project/counters/builds')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            fields: { currentBuildNumber: { integerValue: '7' } },
          }),
        } as any;
      }

      if (method === 'PATCH' && url.includes('/documents/projects/my-project/counters/builds')) {
        const body = JSON.parse(String(init?.body));
        expect(body.fields.currentBuildNumber.integerValue).toBe('8');
        return { ok: true, status: 200, json: async () => ({}) } as any;
      }

      if (method === 'PATCH' && url.includes('/documents/projects/my-project/builds/')) {
        const body = JSON.parse(String(init?.body));
        expect(body.fields.projectId.stringValue).toBe('my-project');
        expect(body.fields.versionId.stringValue).toBe('v1');
        expect(body.fields.buildNumber.integerValue).toBe('8');
        expect(body.fields.zipUrl.stringValue).toContain('storybook.zip');
        return { ok: true, status: 200, json: async () => ({}) } as any;
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    // @ts-expect-error - test override
    globalThis.fetch = fetchMock;

    const svc = createSvc();
    const build = await svc.createBuild('my-project', {
      versionId: 'v1',
      zipUrl: 'https://r2.example/my-project/v1/storybook.zip',
      coverage: {
        reportUrl: 'https://r2.example/my-project/v1/coverage-report.json',
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
      },
    });

    expect(build.projectId).toBe('my-project');
    expect(build.versionId).toBe('v1');
    expect(build.buildNumber).toBe(8);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('createBuild() falls back to buildNumber=1 when counter fetch fails', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase();

      if (method === 'GET' && url.includes('/documents/projects/my-project/counters/builds')) {
        return { ok: false, status: 500, statusText: 'boom' } as any;
      }

      if (method === 'PATCH' && url.includes('/documents/projects/my-project/counters/builds')) {
        const body = JSON.parse(String(init?.body));
        expect(body.fields.currentBuildNumber.integerValue).toBe('1');
        return { ok: true, status: 200, json: async () => ({}) } as any;
      }

      if (method === 'PATCH' && url.includes('/documents/projects/my-project/builds/')) {
        const body = JSON.parse(String(init?.body));
        expect(body.fields.buildNumber.integerValue).toBe('1');
        return { ok: true, status: 200, json: async () => ({}) } as any;
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    // @ts-expect-error - test override
    globalThis.fetch = fetchMock;

    const svc = createSvc();
    const build = await svc.createBuild('my-project', {
      versionId: 'v1',
      zipUrl: 'https://r2.example/my-project/v1/storybook.zip',
    });

    expect(build.buildNumber).toBe(1);
  });

  it('getBuild() returns null on 404', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.method || 'GET').toUpperCase()).toBe('GET');
      return { ok: false, status: 404 } as any;
    });

    // @ts-expect-error - test override
    globalThis.fetch = fetchMock;

    const svc = createSvc();
    await expect(svc.getBuild('my-project', 'missing')).resolves.toBeNull();
  });

  it('getProjectBuilds() maps runQuery documents', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase();
      if (method !== 'POST' || !url.includes(':runQuery')) {
        throw new Error(`Unexpected request: ${method} ${url}`);
      }
      const body = JSON.parse(String(init?.body));
      expect(body.structuredQuery.orderBy[0].field.fieldPath).toBe('buildNumber');
      expect(body.structuredQuery.limit).toBe(2);

      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            document: {
              name: 'projects/firebase-proj/databases/(default)/documents/projects/my-project/builds/build-a',
              fields: {
                projectId: { stringValue: 'my-project' },
                versionId: { stringValue: 'v2' },
                buildNumber: { integerValue: '2' },
                zipUrl: { stringValue: 'https://r2/x.zip' },
                status: { stringValue: 'active' },
                createdAt: { timestampValue: '2026-01-01T00:00:00.000Z' },
                createdBy: { stringValue: 'svc' },
              },
            },
          },
          {
            document: {
              name: 'projects/firebase-proj/databases/(default)/documents/projects/my-project/builds/build-b',
              fields: {
                projectId: { stringValue: 'my-project' },
                versionId: { stringValue: 'v1' },
                buildNumber: { integerValue: '1' },
                zipUrl: { stringValue: 'https://r2/y.zip' },
                status: { stringValue: 'archived' },
                createdAt: { timestampValue: '2026-01-01T00:00:00.000Z' },
                createdBy: { stringValue: 'svc' },
              },
            },
          },
        ],
      } as any;
    });

    // @ts-expect-error - test override
    globalThis.fetch = fetchMock;

    const svc = createSvc();
    const builds = await svc.getProjectBuilds('my-project', undefined, 2);
    expect(builds).toHaveLength(2);
    expect(builds[0].id).toBe('build-a');
    expect(builds[0].buildNumber).toBe(2);
  });

  it('getProjectBuilds() applies statusFilter', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase();
      if (method !== 'POST' || !url.includes(':runQuery')) {
        throw new Error(`Unexpected request: ${method} ${url}`);
      }
      const body = JSON.parse(String(init?.body));
      expect(body.structuredQuery.where.fieldFilter.field.fieldPath).toBe('status');
      expect(body.structuredQuery.where.fieldFilter.value.stringValue).toBe('archived');
      return { ok: true, status: 200, json: async () => [] } as any;
    });

    // @ts-expect-error - test override
    globalThis.fetch = fetchMock;

    const svc = createSvc();
    const builds = await svc.getProjectBuilds('my-project', 'archived', 50);
    expect(builds).toEqual([]);
  });

  it('getBuildByVersion() selects the highest buildNumber client-side', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase();
      if (method !== 'POST' || !url.includes(':runQuery')) {
        throw new Error(`Unexpected request: ${method} ${url}`);
      }
      const body = JSON.parse(String(init?.body));
      expect(body.structuredQuery.where.fieldFilter.field.fieldPath).toBe('versionId');
      expect(body.structuredQuery.where.fieldFilter.value.stringValue).toBe('v1');

      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            document: {
              name: '.../builds/build-3',
              fields: {
                projectId: { stringValue: 'my-project' },
                versionId: { stringValue: 'v1' },
                buildNumber: { integerValue: '3' },
                zipUrl: { stringValue: 'https://r2/3.zip' },
                status: { stringValue: 'active' },
                createdAt: { timestampValue: '2026-01-01T00:00:00.000Z' },
                createdBy: { stringValue: 'svc' },
              },
            },
          },
          {
            document: {
              name: '.../builds/build-5',
              fields: {
                projectId: { stringValue: 'my-project' },
                versionId: { stringValue: 'v1' },
                buildNumber: { integerValue: '5' },
                zipUrl: { stringValue: 'https://r2/5.zip' },
                status: { stringValue: 'active' },
                createdAt: { timestampValue: '2026-01-01T00:00:00.000Z' },
                createdBy: { stringValue: 'svc' },
              },
            },
          },
        ],
      } as any;
    });

    // @ts-expect-error - test override
    globalThis.fetch = fetchMock;

    const svc = createSvc();
    const build = await svc.getBuildByVersion('my-project', 'v1');
    expect(build?.id).toBe('build-5');
    expect(build?.buildNumber).toBe(5);
  });

  it('getLatestBuild() returns the first result from query', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase();
      if (method !== 'POST' || !url.includes(':runQuery')) {
        throw new Error(`Unexpected request: ${method} ${url}`);
      }
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            document: {
              name: '.../builds/build-latest',
              fields: {
                projectId: { stringValue: 'my-project' },
                versionId: { stringValue: 'v9' },
                buildNumber: { integerValue: '9' },
                zipUrl: { stringValue: 'https://r2/9.zip' },
                status: { stringValue: 'active' },
                createdAt: { timestampValue: '2026-01-01T00:00:00.000Z' },
                createdBy: { stringValue: 'svc' },
              },
            },
          },
        ],
      } as any;
    });

    // @ts-expect-error - test override
    globalThis.fetch = fetchMock;

    const svc = createSvc();
    const build = await svc.getLatestBuild('my-project');
    expect(build?.id).toBe('build-latest');
  });

  it('guarantee-2-single-field-unchanged: every existing single-field patchDocument() caller is byte-identical after the fix (processingStatus, coverage)', async () => {
    // A mask of one field, repeated once, is identical to the pre-fix comma-join for n=1 -- there is
    // no comma to mis-parse. Proves updateProcessingStatus() and updateBuildCoverage() (the two
    // single-field callers that existed before commitSha/branch) are unaffected by the fix.
    const calls: Array<{ url: string; body: any }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
      return { ok: true, status: 200, json: async () => ({}) } as any;
    });

    // @ts-expect-error - test override
    globalThis.fetch = fetchMock;

    const svc = createSvc();
    await svc.updateProcessingStatus('my-project', 'build-123', 'queued');
    await svc.updateBuildCoverage('my-project', 'build-123', {
      reportUrl: 'https://r2/c.json',
      summary: {
        componentCoverage: 0.9,
        propCoverage: 0.8,
        variantCoverage: 0.7,
        passRate: 0.95,
        totalComponents: 1,
        componentsWithStories: 1,
        failingStories: 0,
      },
      qualityGate: { passed: true, checks: [] },
      generatedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(calls).toHaveLength(2);
    const processingStatusParams = new URL(calls[0].url).searchParams.getAll('updateMask.fieldPaths');
    expect(processingStatusParams).toEqual(['processingStatus']);
    expect(calls[0].url).not.toContain(',');
    expect(calls[0].body.fields.processingStatus.stringValue).toBe('queued');

    const coverageParams = new URL(calls[1].url).searchParams.getAll('updateMask.fieldPaths');
    expect(coverageParams).toEqual(['coverage']);
    expect(calls[1].url).not.toContain(',');
  });

  it('guarantee-1-repeated-mask-params: updateBuild() PATCHes only provided fields with one updateMask.fieldPaths per field (including coverage conversion)', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase();
      expect(method).toBe('PATCH');
      expect(url).toContain('/documents/projects/my-project/builds/build-123');
      // Firestore REST requires one updateMask.fieldPaths param PER field (F73): a single
      // comma-joined value is parsed as one field path containing a literal comma and rejected.
      const params = new URL(url).searchParams.getAll('updateMask.fieldPaths');
      expect(params).toEqual(['status', 'zipUrl', 'archivedAt', 'archivedBy', 'coverage']);
      expect(url).not.toContain('updateMask.fieldPaths=status%2CzipUrl');
      expect(url).not.toContain('updateMask.fieldPaths=status,zipUrl');

      const body = JSON.parse(String(init?.body));
      expect(body.fields.status.stringValue).toBe('archived');
      expect(body.fields.zipUrl.stringValue).toBe('https://r2/new.zip');
      expect(body.fields.archivedBy.stringValue).toBe('u1');

      // Ensure nested conversion exists
      expect(body.fields.coverage.mapValue.fields.summary.mapValue.fields.totalComponents.integerValue).toBe('1');
      // bigint should fall back to string
      expect(body.fields.coverage.mapValue.fields.extra.stringValue).toBe('1');

      return { ok: true, status: 200, json: async () => ({}) } as any;
    });

    // @ts-expect-error - test override
    globalThis.fetch = fetchMock;

    const svc = createSvc();
    await svc.updateBuild('my-project', 'build-123', {
      status: 'archived',
      zipUrl: 'https://r2/new.zip',
      archivedAt: new Date('2026-01-01T00:00:00.000Z'),
      archivedBy: 'u1',
      coverage: {
        reportUrl: 'https://r2/c.json',
        summary: {
          componentCoverage: 0.9,
          propCoverage: 0.8,
          variantCoverage: 0.7,
          passRate: 0.95,
          totalComponents: 1,
          componentsWithStories: 1,
          failingStories: 0,
        },
        qualityGate: { passed: true, checks: [] },
        generatedAt: '2026-01-01T00:00:00.000Z',
        extra: 1n as any,
      } as any,
    });
  });

  it('guarantee-1-repeated-mask-params: updateBuild() sends the exact repeated-param query string for a provenance write (upload-provenance-updatemask, ISSUES.md #61)', async () => {
    // Reproduces the real production call sites (app.ts coverage + metadata routes, both added by
    // PR #25) that set commitSha+branch together. Before the fix, patchDocument() sent a single
    // `updateMask.fieldPaths=commitSha,branch` param; Firestore's REST API parses that as one field
    // path containing a literal comma and 400s with "Invalid property path", which both call sites'
    // best-effort .catch() swallowed as a warning — so the build document never gained either field
    // (108/108 production builds since 2026-09-11, per impact.md).
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      expect(parsed.pathname).toBe(
        '/v1/projects/firebase-proj/databases/(default)/documents/projects/my-project/builds/build-9'
      );
      expect(parsed.search).toBe(
        '?updateMask.fieldPaths=commitSha&updateMask.fieldPaths=branch'
      );
      expect((init?.method || 'GET').toUpperCase()).toBe('PATCH');

      const body = JSON.parse(String(init?.body));
      expect(Object.keys(body.fields)).toEqual(['commitSha', 'branch']);
      expect(body.fields.commitSha.stringValue).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
      expect(body.fields.branch.stringValue).toBe('main');

      return { ok: true, status: 200, json: async () => ({}) } as any;
    });

    // @ts-expect-error - test override
    globalThis.fetch = fetchMock;

    const svc = createSvc();
    await svc.updateBuild('my-project', 'build-9', {
      commitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      branch: 'main',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('regression-empty-updatemask: updateBuild() with no fields to update throws instead of sending a mask-less PATCH (F9)', async () => {
    // Firestore treats a PATCH with NO updateMask.fieldPaths param at all as a full-document
    // replace, not a no-op -- if this were ever allowed through, it would silently wipe the
    // entire build document (versionId, zipUrl, status, everything). updateBuild({}) resolves to
    // fields={} and maskFieldPaths=[] (no truthy field, no provenanceError key), so it must fail
    // closed before any fetch is attempted.
    const fetchMock = vi.fn();
    // @ts-expect-error - test override
    globalThis.fetch = fetchMock;

    const svc = createSvc();
    await expect(svc.updateBuild('my-project', 'build-9', {})).rejects.toThrow(
      /empty update mask/i
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('updateBuild() logs a non-2xx patchDocument response (no token/secrets) and still throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => '{"error":{"message":"Invalid property path \\"a,b\\""}}',
    })) as any;

    // @ts-expect-error - test override
    globalThis.fetch = fetchMock;

    const svc = createSvc();
    await expect(
      svc.updateBuild('my-project', 'build-9', { processingStatus: 'failed' })
    ).rejects.toThrow('Failed to patch document: 400 Bad Request');

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message, meta] = errorSpy.mock.calls[0];
    expect(message).toContain('patchDocument failed');
    const logged = JSON.stringify(meta);
    expect(logged).toContain('Invalid property path');
    expect(logged).not.toContain('test-token');
    expect(logged).not.toContain('Bearer');
  });

  it('archiveBuild() PATCHes archived status and audit fields', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect((init?.method || 'GET').toUpperCase()).toBe('PATCH');
      const params = new URL(url).searchParams.getAll('updateMask.fieldPaths');
      expect(params).toEqual(['status', 'archivedAt', 'archivedBy']);
      const body = JSON.parse(String(init?.body));
      expect(body.fields.status.stringValue).toBe('archived');
      expect(body.fields.archivedBy.stringValue).toBe('user-1');
      return { ok: true, status: 200, json: async () => ({}) } as any;
    });

    // @ts-expect-error - test override
    globalThis.fetch = fetchMock;

    const svc = createSvc();
    await svc.archiveBuild('my-project', 'build-1', 'user-1');
  });

  it('deleteBuild() issues DELETE and throws on non-ok response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200 } as any)
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'nope' } as any);

    // @ts-expect-error - test override
    globalThis.fetch = fetchMock;

    const svc = createSvc();
    await expect(svc.deleteBuild('my-project', 'build-ok')).resolves.toBeUndefined();
    await expect(svc.deleteBuild('my-project', 'build-bad')).rejects.toThrow('Failed to delete build');
  });

  it('getBuild() converts nested coverage values via fromFirestoreValue()', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect((init?.method || 'GET').toUpperCase()).toBe('GET');
      expect(url).toContain('/documents/projects/my-project/builds/build-123');

      return {
        ok: true,
        status: 200,
        json: async () => ({
          fields: {
            projectId: { stringValue: 'my-project' },
            versionId: { stringValue: 'v1' },
            buildNumber: { integerValue: '1' },
            zipUrl: { stringValue: 'https://r2/1.zip' },
            status: { stringValue: 'active' },
            createdAt: { timestampValue: '2026-01-01T00:00:00.000Z' },
            createdBy: { stringValue: 'svc' },
            coverage: {
              mapValue: {
                fields: {
                  reportUrl: { stringValue: 'https://r2/c.json' },
                  summary: {
                    mapValue: {
                      fields: {
                        totalComponents: { integerValue: '10' },
                      },
                    },
                  },
                  qualityGate: {
                    mapValue: {
                      fields: {
                        checks: {
                          arrayValue: {
                            values: [
                              {
                                mapValue: {
                                  fields: {
                                    name: { stringValue: 'passRate' },
                                  },
                                },
                              },
                            ],
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      } as any;
    });

    // @ts-expect-error - test override
    globalThis.fetch = fetchMock;

    const svc = createSvc();
    const build = await svc.getBuild('my-project', 'build-123');
    expect(build?.coverage?.reportUrl).toBe('https://r2/c.json');
    expect((build?.coverage as any)?.summary?.totalComponents).toBe(10);
    expect((build?.coverage as any)?.qualityGate?.checks?.[0]?.name).toBe('passRate');
  });

  it('guarantee-3: getBuild() reads commitSha/branch/provenanceError back from the document (upload-provenance-updatemask, ISSUES.md #61)', async () => {
    // Sibling to the updateMask fix, found in Stage 3: convertDocToBuild() never mapped
    // commitSha/branch back into the Build object at all, so even once patchDocument() correctly
    // wrote them, every read (getBuild, getBuildByVersion, getProjectBuilds, getLatestBuild) would
    // still silently drop them -- independent of the comma-join bug this hotfix fixes. #25 wrote
    // the write side but never touched this read side.
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        fields: {
          projectId: { stringValue: 'my-project' },
          versionId: { stringValue: 'v1' },
          buildNumber: { integerValue: '1' },
          zipUrl: { stringValue: 'https://r2/1.zip' },
          status: { stringValue: 'active' },
          createdAt: { timestampValue: '2026-01-01T00:00:00.000Z' },
          createdBy: { stringValue: 'svc' },
          commitSha: { stringValue: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' },
          branch: { stringValue: 'main' },
          provenanceError: {
            mapValue: {
              fields: {
                at: { stringValue: '2026-09-28T18:00:00.000Z' },
                message: { stringValue: 'Failed to patch document: 400 Bad Request' },
                route: { stringValue: 'coverage' },
              },
            },
          },
        },
      }),
    })) as any;

    // @ts-expect-error - test override
    globalThis.fetch = fetchMock;

    const svc = createSvc();
    const build = await svc.getBuild('my-project', 'build-123');
    expect(build?.commitSha).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
    expect(build?.branch).toBe('main');
    expect(build?.provenanceError).toEqual({
      at: '2026-09-28T18:00:00.000Z',
      message: 'Failed to patch document: 400 Bad Request',
      route: 'coverage',
    });
  });

  it('getBuild() omits commitSha/branch/provenanceError when the document has none (absent stays absent)', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        fields: {
          projectId: { stringValue: 'my-project' },
          versionId: { stringValue: 'v1' },
          buildNumber: { integerValue: '1' },
          zipUrl: { stringValue: 'https://r2/1.zip' },
          status: { stringValue: 'active' },
          createdAt: { timestampValue: '2026-01-01T00:00:00.000Z' },
          createdBy: { stringValue: 'svc' },
        },
      }),
    })) as any;

    // @ts-expect-error - test override
    globalThis.fetch = fetchMock;

    const svc = createSvc();
    const build = await svc.getBuild('my-project', 'build-123');
    expect(build?.commitSha).toBeUndefined();
    expect(build?.branch).toBeUndefined();
    expect(build?.provenanceError).toBeUndefined();
  });
});

