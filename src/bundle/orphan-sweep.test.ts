import { describe, it, expect, vi } from 'vitest';
import {
  sweepOrphanBundleBuilds,
  bundleZipKey,
  UPLOAD_NEVER_COMPLETED_MESSAGE,
  type OrphanSweepStore,
  type OrphanBundleCandidate,
  type OrphanFreshState,
} from './orphan-sweep.js';

/**
 * Ledger F80: stage build EgQq0e6UYN7vXTkHsN1d — a bundle build's presigned-url call created its
 * Firestore document, and the client's `/bundle/complete` call never arrived (the e2e harness
 * crashed between presign and PUT). Nothing else in this service ever revisits that document, so it
 * reads as "just created" forever.
 *
 * Ledger F91/F92 (cs-rev-39 security review): these tests were rewritten alongside the fix. F91
 * replaced the per-project scan (`listProjectIds` + one query per project) with a single
 * `findCandidates(cutoff, limit)` call across every project, so there is no more per-project loop
 * to test here — the store's own query shape is pinned separately in
 * `firestore.worker.orphan-sweep.test.ts`. F92 added a fresh re-check (`getFreshState`) and a
 * conditional write (`markUploadNeverCompletedIfUnchanged`) immediately before marking a build
 * failed, closing the race a genuine concurrent `/bundle/complete` completion could otherwise hit
 * during `retryFetch`'s backoff.
 */
describe('sweepOrphanBundleBuilds', () => {
  const NOW = new Date('2026-09-29T02:00:00Z');

  function minutesAgo(m: number): Date {
    return new Date(NOW.getTime() - m * 60_000);
  }

  function candidate(overrides: Partial<OrphanBundleCandidate> = {}): OrphanBundleCandidate {
    return {
      buildId: 'build-1',
      projectId: 'proj-a',
      versionId: 'v1',
      buildNumber: 3,
      createdAt: minutesAgo(90),
      hasSource: true,
      hasProcessingStatus: false,
      ...overrides,
    };
  }

  /**
   * A Firestore-and-R2 stand-in. `findCandidates` applies the same `createdAt < cutoff` filter the
   * real query does — a build not yet old enough is never even offered to the sweep. `getFreshState`
   * defaults to mirroring the candidate's own `hasProcessingStatus`/an ever-incrementing updateTime,
   * unless a test overrides it to simulate a race.
   */
  function makeStore(
    candidates: OrphanBundleCandidate[],
    objectsInR2: Set<string> = new Set()
  ) {
    const marked: Array<{ projectId: string; buildId: string }> = [];
    let updateTimeCounter = 0;
    const updateTimes = new Map<string, string>();
    const resolved = new Set<string>(); // buildIds that now have a processingStatus

    const key = (c: Pick<OrphanBundleCandidate, 'projectId' | 'buildId'>) => `${c.projectId}/${c.buildId}`;

    for (const c of candidates) {
      updateTimes.set(key(c), `2026-09-29T00:00:0${updateTimeCounter++}.000000000Z`);
      if (c.hasProcessingStatus) resolved.add(key(c));
    }

    const findCandidates = vi.fn(async (cutoff: Date, limit: number) =>
      candidates.filter((c) => c.createdAt.getTime() < cutoff.getTime()).slice(0, limit)
    );

    const store: OrphanSweepStore = {
      findCandidates,
      bundleObjectExists: vi.fn(async (c) => objectsInR2.has(bundleZipKey(c))),
      getFreshState: vi.fn(async (c): Promise<OrphanFreshState | null> => {
        if (!updateTimes.has(key(c))) return null; // deleted
        return { hasProcessingStatus: resolved.has(key(c)), updateTime: updateTimes.get(key(c))! };
      }),
      markUploadNeverCompletedIfUnchanged: vi.fn(async (c, expectedUpdateTime) => {
        if (updateTimes.get(key(c)) !== expectedUpdateTime) return 'precondition-failed';
        marked.push({ projectId: c.projectId, buildId: c.buildId });
        resolved.add(key(c));
        updateTimes.set(key(c), `resolved-${key(c)}`);
        return 'marked';
      }),
    };
    return { store, marked, findCandidates, updateTimes, resolved, key };
  }

  it('marks a genuine orphan: bundle build, no processingStatus, old enough, no object in R2', async () => {
    const { store, marked } = makeStore([candidate()]);

    const result = await sweepOrphanBundleBuilds(store, { now: NOW });

    expect(marked).toEqual([{ projectId: 'proj-a', buildId: 'build-1' }]);
    expect(result.markedFailed).toEqual([{ projectId: 'proj-a', buildId: 'build-1' }]);
    expect(result.docsScanned).toBe(1);
    expect(result.skipped).toEqual([]);
  });

  it('leaves a legacy storybook.zip build untouched (no `source`)', async () => {
    const { store, marked } = makeStore([candidate({ buildId: 'legacy-1', hasSource: false })]);

    const result = await sweepOrphanBundleBuilds(store, { now: NOW });

    expect(marked).toEqual([]);
    expect(result.markedFailed).toEqual([]);
    // Still counted as scanned — the sweep read the doc, just decided not to touch it.
    expect(result.docsScanned).toBe(1);
  });

  it('leaves a completed bundle build untouched (any processingStatus at all, at query time)', async () => {
    const { store, marked } = makeStore([candidate({ buildId: 'done-1', hasProcessingStatus: true })]);

    const result = await sweepOrphanBundleBuilds(store, { now: NOW });

    expect(marked).toEqual([]);
    expect(result.markedFailed).toEqual([]);
  });

  it('leaves a build whose bundle.zip actually exists in R2 untouched', async () => {
    const c = candidate({ buildId: 'uploaded-1' });
    const { store, marked } = makeStore([c], new Set([bundleZipKey(c)]));

    const result = await sweepOrphanBundleBuilds(store, { now: NOW });

    expect(marked).toEqual([]);
    expect(result.markedFailed).toEqual([]);
  });

  it('leaves a bundle build alone until it crosses the age threshold', async () => {
    const { store, marked } = makeStore([candidate({ buildId: 'fresh-1', createdAt: minutesAgo(10) })]);

    const result = await sweepOrphanBundleBuilds(store, { now: NOW, ageMinutes: 60 });

    expect(marked).toEqual([]);
    expect(result.docsScanned).toBe(0);
  });

  it('is idempotent: a second run never re-marks a build the first run already resolved', async () => {
    const c = candidate();
    const { store, marked, findCandidates } = makeStore([c]);
    // The second run's own query would, in reality, no longer return this build (it now has
    // processingStatus) — simulate that by having findCandidates consult the same `resolved` set.
    findCandidates.mockImplementation(async (cutoff: Date) =>
      c.createdAt.getTime() < cutoff.getTime() && marked.length === 0 ? [c] : []
    );

    await sweepOrphanBundleBuilds(store, { now: NOW });
    const second = await sweepOrphanBundleBuilds(store, { now: NOW });

    expect(marked).toHaveLength(1);
    expect(second.markedFailed).toEqual([]);
    expect(second.docsScanned).toBe(0);
  });

  it('a genuine concurrent /bundle/complete landing between the query and the fresh re-check is left alone (ledger F92)', async () => {
    const c = candidate();
    const { store, marked } = makeStore([c]);
    // The query's own snapshot still shows no processingStatus (candidate.hasProcessingStatus is
    // false), but a real /bundle/complete call resolved it in Firestore before the fresh re-check
    // runs -- simulate exactly that gap.
    (store.getFreshState as any).mockResolvedValueOnce({ hasProcessingStatus: true, updateTime: 'irrelevant' });

    const result = await sweepOrphanBundleBuilds(store, { now: NOW });

    expect(marked).toEqual([]);
    expect(result.markedFailed).toEqual([]);
    expect(result.skipped).toEqual([
      { projectId: 'proj-a', buildId: 'build-1', reason: 'resolved-before-write' },
    ]);
    expect(result.errors).toEqual([]);
  });

  it('a genuine concurrent /bundle/complete landing between the fresh re-check and the write is left alone (ledger F92)', async () => {
    // The fresh re-check itself still shows no processingStatus, but the document's updateTime has
    // since moved on (a real completion landed in between, e.g. during retryFetch backoff on a
    // transient error) -- the conditional write's own precondition must catch this even when the
    // fresh re-check couldn't.
    const c = candidate();
    const { store, marked } = makeStore([c]);
    (store.markUploadNeverCompletedIfUnchanged as any).mockResolvedValueOnce('precondition-failed');

    const result = await sweepOrphanBundleBuilds(store, { now: NOW });

    expect(marked).toEqual([]);
    expect(result.markedFailed).toEqual([]);
    expect(result.skipped).toEqual([
      { projectId: 'proj-a', buildId: 'build-1', reason: 'precondition-failed' },
    ]);
    expect(result.errors).toEqual([]);
  });

  it('a build deleted between the query and the fresh re-check is left alone, not errored', async () => {
    const c = candidate();
    const { store, marked } = makeStore([c]);
    (store.getFreshState as any).mockResolvedValueOnce(null);

    const result = await sweepOrphanBundleBuilds(store, { now: NOW });

    expect(marked).toEqual([]);
    expect(result.skipped).toEqual([
      { projectId: 'proj-a', buildId: 'build-1', reason: 'deleted-before-write' },
    ]);
    expect(result.errors).toEqual([]);
  });

  it('the candidate query itself throwing is recorded as an error, not fatal to the caller', async () => {
    const { store } = makeStore([]);
    (store.findCandidates as any).mockRejectedValueOnce(new Error('FAILED_PRECONDITION: index missing'));

    const result = await sweepOrphanBundleBuilds(store, { now: NOW });

    expect(result.docsScanned).toBe(0);
    expect(result.markedFailed).toEqual([]);
    expect(result.errors).toEqual([{ error: expect.stringContaining('FAILED_PRECONDITION') }]);
  });

  it('a build whose HEAD check itself throws is recorded as an error, not marked failed', async () => {
    const { store, marked } = makeStore([candidate()]);
    store.bundleObjectExists = vi.fn(async () => {
      throw new Error('R2 unavailable');
    });

    const result = await sweepOrphanBundleBuilds(store, { now: NOW });

    expect(marked).toEqual([]);
    expect(result.errors).toEqual([
      { projectId: 'proj-a', buildId: 'build-1', error: expect.stringContaining('R2 unavailable') },
    ]);
  });

  it('one candidate throwing does not cost the others their turn', async () => {
    const ok = candidate({ buildId: 'ok-1' });
    const broken = candidate({ buildId: 'broken-1' });
    const { store, marked } = makeStore([broken, ok]);
    (store.bundleObjectExists as any).mockImplementation(async (c: OrphanBundleCandidate) => {
      if (c.buildId === 'broken-1') throw new Error('R2 unavailable');
      return false;
    });

    const result = await sweepOrphanBundleBuilds(store, { now: NOW });

    expect(marked).toEqual([{ projectId: 'proj-a', buildId: 'ok-1' }]);
    expect(result.errors).toEqual([
      { projectId: 'proj-a', buildId: 'broken-1', error: expect.stringContaining('R2 unavailable') },
    ]);
  });

  it('bounds the total documents read in one run by asking the store for at most maxDocsPerRun', async () => {
    const { store, findCandidates } = makeStore([candidate({ buildId: 'a-1' }), candidate({ buildId: 'a-2' })]);

    await sweepOrphanBundleBuilds(store, { now: NOW, maxDocsPerRun: 2 });

    expect(findCandidates).toHaveBeenCalledWith(expect.any(Date), 2);
  });

  it('bundleZipKey() matches the upload route\'s key format (app.ts presignedBundleUrlRoute)', () => {
    expect(bundleZipKey({ projectId: 'my-project', versionId: 'v7', buildNumber: 42 })).toBe(
      'my-project/v7/builds/42/bundle.zip'
    );
  });

  it('writes the exact message the brief specifies', () => {
    expect(UPLOAD_NEVER_COMPLETED_MESSAGE).toBe('upload never completed');
  });
});
