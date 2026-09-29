import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FirestoreServiceWorker, isPreconditionFailure, parseProjectAndBuildFromDocName } from './firestore.worker.js';

/**
 * Ledger F80. The orphan-bundle sweep is only as good as its query and its write. The query shape
 * is asserted rather than assumed because the failure mode is silent on both sides — a query
 * needing an index nobody created returns FAILED_PRECONDITION forever, and a scan that finds
 * nothing looks exactly like a scan with nothing to find (same rationale as the sibling
 * stall-detector's own query tests in scry-build-processing-service).
 *
 * Ledger F91: `findOrphanBundleCandidates` was rewritten from a per-project `createdAt`-only query
 * (walked via a separate `listProjectIds`, now removed) to ONE collection-group query filtered on
 * `bundlePending == true`. Ledger F92: the write is no longer a blind `updateBuild()` PATCH —
 * `getBuildOrphanState` (a fresh read) + `markBuildFailedIfUnchanged` (a `currentDocument.updateTime`
 * -guarded PATCH) replace it.
 */
describe('FirestoreServiceWorker orphan-bundle sweep', () => {
  function createSvc() {
    const svc = new FirestoreServiceWorker({
      projectId: 'firebase-proj',
      clientEmail: 'test@example.com',
      privateKey: '-----BEGIN PRIVATE KEY-----\\nZm9v\\n-----END PRIVATE KEY-----',
      serviceAccountId: 'upload-service',
    });
    (svc).accessToken = 'test-token';
    (svc).tokenExpiry = Date.now() + 60_000;
    return svc;
  }

  let fetchMock: ReturnType<typeof vi.fn>;

  function respondWith(results: unknown) {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => results });
    vi.stubGlobal('fetch', fetchMock);
  }

  function sentQuery() {
    return JSON.parse(fetchMock.mock.calls[0][1].body).structuredQuery;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    respondWith([]);
  });

  describe('parseProjectAndBuildFromDocName', () => {
    it('extracts projectId and buildId from a full collection-group document path', () => {
      expect(
        parseProjectAndBuildFromDocName(
          'projects/firebase-proj/databases/(default)/documents/projects/proj-a/builds/build-1'
        )
      ).toEqual({ projectId: 'proj-a', buildId: 'build-1' });
    });

    it('returns null for a path that is not a build document', () => {
      expect(
        parseProjectAndBuildFromDocName('projects/firebase-proj/databases/(default)/documents/projects/proj-a')
      ).toBeNull();
    });
  });

  describe('findOrphanBundleCandidates', () => {
    const cutoff = new Date('2026-09-29T01:00:00Z');

    it('runs ONE collection-group query at the documents root, not scoped to any project', async () => {
      await createSvc().findOrphanBundleCandidates(cutoff);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      // No trailing project-scoped path segment before `:runQuery` — a root-level query.
      expect(fetchMock.mock.calls[0][0]).toMatch(/\/documents:runQuery$/);
      const query = sentQuery();
      expect(query.from).toEqual([{ collectionId: 'builds', allDescendants: true }]);
    });

    it('filters on bundlePending == true AND createdAt < cutoff, ordered by createdAt ascending', async () => {
      await createSvc().findOrphanBundleCandidates(cutoff, 42);

      const query = sentQuery();
      expect(query.where.compositeFilter.op).toBe('AND');
      const filters = query.where.compositeFilter.filters.map((f) => f.fieldFilter);
      expect(filters).toEqual(
        expect.arrayContaining([
          { field: { fieldPath: 'bundlePending' }, op: 'EQUAL', value: { booleanValue: true } },
          { field: { fieldPath: 'createdAt' }, op: 'LESS_THAN', value: { timestampValue: cutoff.toISOString() } },
        ])
      );
      expect(query.orderBy).toEqual([{ field: { fieldPath: 'createdAt' }, direction: 'ASCENDING' }]);
      expect(query.limit).toBe(42);
    });

    it('defaults the limit to 200', async () => {
      await createSvc().findOrphanBundleCandidates(cutoff);
      expect(sentQuery().limit).toBe(200);
    });

    it('parses projectId/buildId from the collection-group result path, and reports source/processingStatus presence', async () => {
      respondWith([
        {
          document: {
            name: 'projects/firebase-proj/databases/(default)/documents/projects/proj-a/builds/orphan-1',
            fields: {
              versionId: { stringValue: 'v3' },
              buildNumber: { integerValue: '5' },
              createdAt: { timestampValue: '2026-09-29T00:00:00Z' },
              source: { mapValue: { fields: { kind: { stringValue: 'storybook-rn' } } } },
              bundlePending: { booleanValue: true },
              // No processingStatus field at all — this is the orphan case.
            },
          },
        },
      ]);

      const [candidate] = await createSvc().findOrphanBundleCandidates(cutoff);

      expect(candidate.projectId).toBe('proj-a');
      expect(candidate.buildId).toBe('orphan-1');
      expect(candidate.versionId).toBe('v3');
      expect(candidate.buildNumber).toBe(5);
      expect(candidate.createdAt.toISOString()).toBe('2026-09-29T00:00:00.000Z');
      expect(candidate.hasSource).toBe(true);
      expect(candidate.hasProcessingStatus).toBe(false);
    });

    it('returns nothing when there are no matching candidates', async () => {
      // Firestore answers an empty query with a readTime-only entry, not [].
      respondWith([{ readTime: '2026-09-29T00:00:00Z' }]);
      expect(await createSvc().findOrphanBundleCandidates(cutoff)).toEqual([]);
    });
  });

  describe('createBuild() sets bundlePending only for a bundle build', () => {
    function mockCreateBuildFetches() {
      const calls: Array<{ url: string; method: string; body: { fields: Record<string, unknown> } | undefined }> = [];
      fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method || 'GET').toUpperCase();
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (method === 'GET') return { ok: false, status: 404 }; // no counter doc yet
        return { ok: true, status: 200, json: async () => ({}) };
      });
      vi.stubGlobal('fetch', fetchMock);
      return calls;
    }

    it('writes bundlePending: true alongside source, for a bundle build', async () => {
      const calls = mockCreateBuildFetches();
      await createSvc().createBuild('my-project', {
        versionId: 'v1',
        zipUrl: '',
        source: { kind: 'storybook-rn', platform: 'ios' },
      });

      const buildWrite = calls.find((c) => c.method === 'PATCH' && c.url.includes('/builds/'));
      expect(buildWrite?.body.fields.source).toBeDefined();
      expect(buildWrite?.body.fields.bundlePending).toEqual({ booleanValue: true });
    });

    it('omits bundlePending entirely for a legacy (no-source) build', async () => {
      const calls = mockCreateBuildFetches();
      await createSvc().createBuild('my-project', { versionId: 'v1', zipUrl: 'https://r2/x.zip' });

      const buildWrite = calls.find((c) => c.method === 'PATCH' && c.url.includes('/builds/'));
      expect(buildWrite?.body.fields.source).toBeUndefined();
      expect(buildWrite?.body.fields.bundlePending).toBeUndefined();
    });
  });

  describe('getBuildOrphanState', () => {
    it('reads the build doc fresh and reports processingStatus presence + updateTime', async () => {
      fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          name: 'projects/firebase-proj/databases/(default)/documents/projects/proj-a/builds/build-1',
          updateTime: '2026-09-29T01:30:00.123456789Z',
          fields: { versionId: { stringValue: 'v1' } }, // no processingStatus
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const state = await createSvc().getBuildOrphanState('proj-a', 'build-1');

      expect(state).toEqual({ hasProcessingStatus: false, updateTime: '2026-09-29T01:30:00.123456789Z' });
    });

    it('returns null when the document no longer exists', async () => {
      fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
      vi.stubGlobal('fetch', fetchMock);

      expect(await createSvc().getBuildOrphanState('proj-a', 'gone')).toBeNull();
    });

    it('reports hasProcessingStatus true once any value is present', async () => {
      fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          name: 'x',
          updateTime: '2026-09-29T01:30:00Z',
          fields: { processingStatus: { stringValue: 'completed' } },
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const state = await createSvc().getBuildOrphanState('proj-a', 'build-1');
      expect(state?.hasProcessingStatus).toBe(true);
    });
  });

  describe('markBuildFailedIfUnchanged (ledger F92)', () => {
    it('sends the updateTime precondition and the processingStatus/processingError/bundlePending mask', async () => {
      fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
      vi.stubGlobal('fetch', fetchMock);

      const outcome = await createSvc().markBuildFailedIfUnchanged(
        'proj-a',
        'build-1',
        'upload never completed',
        '2026-09-29T01:30:00.123456789Z'
      );

      expect(outcome).toBe('marked');
      const url = fetchMock.mock.calls[0][0];
      const params = new URL(url).searchParams;
      expect(params.get('currentDocument.updateTime')).toBe('2026-09-29T01:30:00.123456789Z');
      expect(params.getAll('updateMask.fieldPaths')).toEqual(['processingStatus', 'processingError', 'bundlePending']);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.fields.processingStatus.stringValue).toBe('failed');
      expect(body.fields.processingError.stringValue).toBe('upload never completed');
      // bundlePending is mask-only (a clear), never sent as a value.
      expect(body.fields.bundlePending).toBeUndefined();
    });

    it('returns precondition-failed (never throws, never retries) when Firestore rejects a stale updateTime', async () => {
      fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () =>
          JSON.stringify({ error: { code: 400, message: 'the stored version does not match', status: 'FAILED_PRECONDITION' } }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const outcome = await createSvc().markBuildFailedIfUnchanged(
        'proj-a',
        'build-1',
        'upload never completed',
        'stale-update-time'
      );

      expect(outcome).toBe('precondition-failed');
      // Never retried: retryFetch only retries 429/500/503, and this test's fetch only returns 400.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('still throws for a non-precondition 400 (e.g. a malformed field path), never swallows it', async () => {
      fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => JSON.stringify({ error: { code: 400, message: 'Invalid property path', status: 'INVALID_ARGUMENT' } }),
      });
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        createSvc().markBuildFailedIfUnchanged('proj-a', 'build-1', 'upload never completed', 'x')
      ).rejects.toThrow('Failed to patch document: 400 Bad Request');
    });
  });

  describe('isPreconditionFailure', () => {
    it('is true for a 400 FAILED_PRECONDITION body', () => {
      expect(isPreconditionFailure(400, JSON.stringify({ error: { status: 'FAILED_PRECONDITION' } }))).toBe(true);
    });

    it('is true for a 409 ABORTED body', () => {
      expect(isPreconditionFailure(409, JSON.stringify({ error: { status: 'ABORTED' } }))).toBe(true);
    });

    it('is false for a 400 with a different rpc status', () => {
      expect(isPreconditionFailure(400, JSON.stringify({ error: { status: 'INVALID_ARGUMENT' } }))).toBe(false);
    });

    it('is false for a non-400/409 status', () => {
      expect(isPreconditionFailure(500, JSON.stringify({ error: { status: 'FAILED_PRECONDITION' } }))).toBe(false);
    });

    it('is false for an unparseable body', () => {
      expect(isPreconditionFailure(400, 'not json')).toBe(false);
    });
  });

  it('updateBuild() clears bundlePending alongside any processingStatus write', async () => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    await createSvc().updateBuild('proj-a', 'build-1', {
      processingStatus: 'failed',
      processingError: 'upload never completed',
    });

    const url = fetchMock.mock.calls[0][0];
    const params = new URL(url).searchParams.getAll('updateMask.fieldPaths');
    expect(params).toEqual(['processingStatus', 'processingError', 'bundlePending']);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.fields.processingStatus.stringValue).toBe('failed');
    expect(body.fields.processingError.stringValue).toBe('upload never completed');
    expect(body.fields.bundlePending).toBeUndefined();
  });
});
