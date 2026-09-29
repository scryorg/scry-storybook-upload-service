import { describe, it, expect, vi } from 'vitest';
import {
  sweepOrphanBundleBuilds,
  bundleZipKey,
  UPLOAD_NEVER_COMPLETED_MESSAGE,
  type OrphanSweepStore,
  type OrphanBundleCandidate,
} from './orphan-sweep.js';

/**
 * Ledger F80: stage build EgQq0e6UYN7vXTkHsN1d — a bundle build's presigned-url call created its
 * Firestore document, and the client's `/bundle/complete` call never arrived (the e2e harness
 * crashed between presign and PUT). Nothing else in this service ever revisits that document, so it
 * reads as "just created" forever.
 *
 * These tests pin the sweep's three-way skip rule (legacy build, already-resolved build, and an
 * object that actually made it to R2), its idempotency, and its per-run bound — using a fake store,
 * no Firestore REST plumbing or R2 binding required.
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
   * real query does — a build not yet old enough is never even offered to the sweep, which is the
   * property worth pinning, same as the sibling stall-detector's fake store.
   */
  function makeStore(
    builds: Record<string, OrphanBundleCandidate[]>,
    objectsInR2: Set<string> = new Set()
  ) {
    const marked: Array<{ projectId: string; buildId: string }> = [];
    const findCandidates = vi.fn(async (projectId: string, cutoff: Date, limit: number) =>
      (builds[projectId] ?? []).filter((b) => b.createdAt.getTime() < cutoff.getTime()).slice(0, limit)
    );
    const store: OrphanSweepStore = {
      listProjectIds: vi.fn(async () => Object.keys(builds)),
      findCandidates,
      bundleObjectExists: vi.fn(async (c) => objectsInR2.has(bundleZipKey(c))),
      markUploadNeverCompleted: vi.fn(async (c) => {
        marked.push({ projectId: c.projectId, buildId: c.buildId });
        // Mirror the real effect: once marked, the build now has a processingStatus, so a second
        // scan of the same (mutable, in-memory) list must not offer it again.
        const list = builds[c.projectId] ?? [];
        const match = list.find((b) => b.buildId === c.buildId);
        if (match) match.hasProcessingStatus = true;
      }),
    };
    return { store, marked, findCandidates };
  }

  it('marks a genuine orphan: bundle build, no processingStatus, old enough, no object in R2', async () => {
    const { store, marked } = makeStore({ 'proj-a': [candidate()] });

    const result = await sweepOrphanBundleBuilds(store, { now: NOW });

    expect(marked).toEqual([{ projectId: 'proj-a', buildId: 'build-1' }]);
    expect(result.markedFailed).toEqual([{ projectId: 'proj-a', buildId: 'build-1' }]);
    expect(result.docsScanned).toBe(1);
  });

  it('leaves a legacy storybook.zip build untouched (no `source`)', async () => {
    const { store, marked } = makeStore({
      'proj-a': [candidate({ buildId: 'legacy-1', hasSource: false })],
    });

    const result = await sweepOrphanBundleBuilds(store, { now: NOW });

    expect(marked).toEqual([]);
    expect(result.markedFailed).toEqual([]);
    // Still counted as scanned — the sweep read the doc, just decided not to touch it.
    expect(result.docsScanned).toBe(1);
  });

  it('leaves a completed bundle build untouched (any processingStatus at all)', async () => {
    const { store, marked } = makeStore({
      'proj-a': [candidate({ buildId: 'done-1', hasProcessingStatus: true })],
    });

    const result = await sweepOrphanBundleBuilds(store, { now: NOW });

    expect(marked).toEqual([]);
    expect(result.markedFailed).toEqual([]);
  });

  it('leaves a build whose bundle.zip actually exists in R2 untouched', async () => {
    const c = candidate({ buildId: 'uploaded-1' });
    const { store, marked } = makeStore({ 'proj-a': [c] }, new Set([bundleZipKey(c)]));

    const result = await sweepOrphanBundleBuilds(store, { now: NOW });

    expect(marked).toEqual([]);
    expect(result.markedFailed).toEqual([]);
  });

  it('leaves a bundle build alone until it crosses the age threshold', async () => {
    const { store, marked } = makeStore({
      'proj-a': [candidate({ buildId: 'fresh-1', createdAt: minutesAgo(10) })],
    });

    const result = await sweepOrphanBundleBuilds(store, { now: NOW, ageMinutes: 60 });

    expect(marked).toEqual([]);
    expect(result.docsScanned).toBe(0);
  });

  it('is idempotent: a second run never re-marks a build the first run already resolved', async () => {
    const { store, marked } = makeStore({ 'proj-a': [candidate()] });

    await sweepOrphanBundleBuilds(store, { now: NOW });
    const second = await sweepOrphanBundleBuilds(store, { now: NOW });

    expect(marked).toHaveLength(1);
    expect(second.markedFailed).toEqual([]);
  });

  it('one project throwing does not cost the others their scan', async () => {
    const { store, marked } = makeStore({
      broken: [candidate({ projectId: 'broken', buildId: 'b-1' })],
      'proj-a': [candidate({ projectId: 'proj-a', buildId: 'build-1' })],
    });
    store.findCandidates = vi.fn(async (projectId: string, cutoff: Date, limit: number) => {
      if (projectId === 'broken') throw new Error('FAILED_PRECONDITION: index missing');
      return [candidate({ projectId: 'proj-a', buildId: 'build-1' })].filter(
        (b) => b.createdAt.getTime() < cutoff.getTime()
      );
    });

    const result = await sweepOrphanBundleBuilds(store, { now: NOW });

    expect(marked).toEqual([{ projectId: 'proj-a', buildId: 'build-1' }]);
    expect(result.errors).toEqual([{ projectId: 'broken', error: expect.stringContaining('FAILED_PRECONDITION') }]);
  });

  it('a build whose HEAD check itself throws is recorded as an error, not marked failed', async () => {
    const { store, marked } = makeStore({ 'proj-a': [candidate()] });
    store.bundleObjectExists = vi.fn(async () => {
      throw new Error('R2 unavailable');
    });

    const result = await sweepOrphanBundleBuilds(store, { now: NOW });

    expect(marked).toEqual([]);
    expect(result.errors).toEqual([
      { projectId: 'proj-a', buildId: 'build-1', error: expect.stringContaining('R2 unavailable') },
    ]);
  });

  it('bounds the total documents read in one run across every project combined', async () => {
    const builds: Record<string, OrphanBundleCandidate[]> = {
      'proj-a': [candidate({ projectId: 'proj-a', buildId: 'a-1' }), candidate({ projectId: 'proj-a', buildId: 'a-2' })],
      'proj-b': [candidate({ projectId: 'proj-b', buildId: 'b-1' })],
    };
    const { store, findCandidates } = makeStore(builds);

    const result = await sweepOrphanBundleBuilds(store, { now: NOW, maxDocsPerRun: 2 });

    expect(result.docsScanned).toBe(2);
    // The run-wide cap was already spent after proj-a; proj-b's query never happens.
    expect(findCandidates).toHaveBeenCalledTimes(1);
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
