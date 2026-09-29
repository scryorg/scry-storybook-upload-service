import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FirestoreServiceWorker } from './firestore.worker.js';

/**
 * Ledger F80. The orphan-bundle sweep is only as good as the two queries it walks: every project,
 * then every build in that project created before the cutoff. The query shape is asserted rather
 * than assumed because the failure mode is silent on both sides — a query needing an index nobody
 * created returns FAILED_PRECONDITION forever, and a scan that finds nothing looks exactly like a
 * scan with nothing to find (same rationale as the sibling stall-detector's own query tests in
 * scry-build-processing-service).
 */
describe('FirestoreServiceWorker orphan-bundle sweep queries', () => {
  function createSvc() {
    const svc = new FirestoreServiceWorker({
      projectId: 'firebase-proj',
      clientEmail: 'test@example.com',
      privateKey: '-----BEGIN PRIVATE KEY-----\\nZm9v\\n-----END PRIVATE KEY-----',
      serviceAccountId: 'upload-service',
    });
    (svc as any).accessToken = 'test-token';
    (svc as any).tokenExpiry = Date.now() + 60_000;
    return svc;
  }

  let fetchMock: ReturnType<typeof vi.fn>;

  function respondWith(results: unknown) {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => results });
    vi.stubGlobal('fetch', fetchMock);
  }

  function sentQuery() {
    return JSON.parse(fetchMock.mock.calls[0][1].body).structuredQuery;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    respondWith([]);
  });

  describe('listProjectIds', () => {
    it('queries the documents root and returns ids only', async () => {
      respondWith([
        { document: { name: 'projects/p/databases/(default)/documents/projects/proj-a' } },
        { document: { name: 'projects/p/databases/(default)/documents/projects/proj-b' } },
      ]);

      const ids = await createSvc().listProjectIds();

      // No trailing project-scoped path segment before `:runQuery` — a root-level collection query.
      expect(fetchMock.mock.calls[0][0]).toMatch(/\/documents:runQuery$/);
      expect(sentQuery().from[0].collectionId).toBe('projects');
      // Keys-only: the sweep needs ids, not every project document in the estate.
      expect(sentQuery().select.fields[0].fieldPath).toBe('__name__');
      expect(ids).toEqual(['proj-a', 'proj-b']);
    });

    it('returns nothing when there are no projects', async () => {
      // Firestore answers an empty query with a readTime-only entry, not [].
      respondWith([{ readTime: '2026-09-29T00:00:00Z' }]);
      expect(await createSvc().listProjectIds()).toEqual([]);
    });
  });

  describe('findOrphanBundleCandidates', () => {
    const cutoff = new Date('2026-09-29T01:00:00Z');

    it('filters on createdAt alone, ordered by the same field, under the project', async () => {
      await createSvc().findOrphanBundleCandidates('proj-a', cutoff);

      expect(fetchMock.mock.calls[0][0]).toContain('/documents/projects/proj-a:runQuery');
      const query = sentQuery();
      expect(query.from[0].collectionId).toBe('builds');
      expect(query.where.fieldFilter.field.fieldPath).toBe('createdAt');
      expect(query.where.fieldFilter.op).toBe('LESS_THAN');
      expect(query.where.fieldFilter.value.timestampValue).toBe(cutoff.toISOString());
      // A second filter on `source`/`processingStatus` presence would demand a composite index that
      // does not exist; orderBy is on the SAME field as the inequality, which Firestore serves from
      // its automatic single-field index alone.
      expect(query.orderBy).toEqual([{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }]);
    });

    it('reports whether `source` and `processingStatus` are present, not their values', async () => {
      respondWith([
        {
          document: {
            name: 'projects/p/databases/(default)/documents/projects/proj-a/builds/orphan-1',
            fields: {
              versionId: { stringValue: 'v3' },
              buildNumber: { integerValue: '5' },
              createdAt: { timestampValue: '2026-09-29T00:00:00Z' },
              source: { mapValue: { fields: { kind: { stringValue: 'storybook-rn' } } } },
              // No processingStatus field at all — this is the orphan case.
            },
          },
        },
      ]);

      const [candidate] = await createSvc().findOrphanBundleCandidates('proj-a', cutoff);

      expect(candidate.buildId).toBe('orphan-1');
      expect(candidate.versionId).toBe('v3');
      expect(candidate.buildNumber).toBe(5);
      expect(candidate.createdAt.toISOString()).toBe('2026-09-29T00:00:00.000Z');
      expect(candidate.hasSource).toBe(true);
      expect(candidate.hasProcessingStatus).toBe(false);
    });

    it('marks a resolved build as having a processingStatus regardless of its value', async () => {
      respondWith([
        {
          document: {
            name: 'projects/p/databases/(default)/documents/projects/proj-a/builds/done-1',
            fields: {
              versionId: { stringValue: 'v1' },
              buildNumber: { integerValue: '1' },
              createdAt: { timestampValue: '2026-09-29T00:00:00Z' },
              source: { mapValue: { fields: {} } },
              processingStatus: { stringValue: 'completed' },
            },
          },
        },
      ]);

      const [candidate] = await createSvc().findOrphanBundleCandidates('proj-a', cutoff);
      expect(candidate.hasProcessingStatus).toBe(true);
    });

    it('reports no `source` for a legacy storybook.zip build', async () => {
      respondWith([
        {
          document: {
            name: 'projects/p/databases/(default)/documents/projects/proj-a/builds/legacy-1',
            fields: {
              versionId: { stringValue: 'v1' },
              buildNumber: { integerValue: '1' },
              createdAt: { timestampValue: '2026-09-29T00:00:00Z' },
            },
          },
        },
      ]);

      const [candidate] = await createSvc().findOrphanBundleCandidates('proj-a', cutoff);
      expect(candidate.hasSource).toBe(false);
    });
  });

  it('updateBuild() writes processingError alongside processingStatus', async () => {
    await createSvc().updateBuild('proj-a', 'build-1', {
      processingStatus: 'failed',
      processingError: 'upload never completed',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.fields.processingStatus.stringValue).toBe('failed');
    expect(body.fields.processingError.stringValue).toBe('upload never completed');
  });
});
