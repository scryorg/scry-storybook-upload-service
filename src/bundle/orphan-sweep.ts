import type { OrphanBundleCandidate } from '../services/firestore/firestore.types.js';

export type { OrphanBundleCandidate };

/**
 * Ledger F80: a bundle build's presigned-url call (`app.ts`'s `presignedBundleUrlRoute`, contract
 * §9) creates the Firestore build document with `source` set and no `processingStatus` at all — the
 * status only arrives once the client's later `/upload/:project/:version/bundle/complete` call
 * runs. When that call never arrives — the upload never started, the process crashed mid-PUT, the
 * network dropped before `/complete` — the build document is left exactly as `createBuild` wrote
 * it, forever: nothing else ever touches it, and it reads as "just created" no matter how old it
 * gets (stage example EgQq0e6UYN7vXTkHsN1d).
 *
 * This sweep finds those and marks them `failed` with a `processingError`, so a build stuck this
 * way stops reading as perpetually in-flight. Detection AND resolution, unlike the sibling stall
 * detector in scry-build-processing-service (ISSUES.md #28): there is no in-flight work to leave
 * alone here, since nothing was ever enqueued for these builds in the first place.
 *
 * Ledger F91/F92 (cs-rev-39 security review of the original PR, sha 73df1db): the original shape
 * (`listProjectIds` + a per-project `createdAt`-only scan, then a blind unconditional PATCH) cost
 * reads proportional to project count and total build history rather than the orphan rate, could
 * silently starve later-listed projects once its run-wide cap was reached, and had a narrow but real
 * race window between its R2 HEAD check and its write during which a genuine, concurrent
 * `/bundle/complete` completion could be silently overwritten under `retryFetch`'s backoff. Fixed by
 * pushing both the "is this a bundle build with no processingStatus" filter AND a fresh re-check
 * immediately before the write into the store (`firestore.worker.ts`'s `findOrphanBundleCandidates`,
 * `getBuildOrphanState`, `markBuildFailedIfUnchanged`) — this module's own logic below just wires
 * the sequence together and stays agnostic to how the store implements either guarantee.
 */

const MS_PER_MINUTE = 60_000;

/** Minutes since creation before an un-uploaded bundle build counts as orphaned. */
export const DEFAULT_ORPHAN_AGE_MINUTES = 60;

/**
 * Upper bound on how many candidate build documents one run reads — not on how many it marks
 * failed (most candidates the store returns are still expected to resolve to "object exists" or a
 * lost race, not every one is a genuine orphan). A cap rather than pagination: a cron that quietly
 * does half the job across an ever-growing backlog is a regression on its own, so if this is ever
 * hit routinely it should be raised deliberately rather than silently degrade (mirrors
 * PROJECT_SCAN_LIMIT in the sibling stall-detector). Ledger F91: since the store's query now filters
 * server-side on `bundlePending` (only ever true for a build that has never had a processingStatus
 * written), this bound is reached only when the backlog of genuinely-still-pending bundle builds
 * itself exceeds it — not, as before, merely by total historical build volume.
 */
export const DEFAULT_MAX_DOCS_PER_RUN = 200;

/** The message written to `processingError` on a build this sweep marks failed. */
export const UPLOAD_NEVER_COMPLETED_MESSAGE = 'upload never completed';

/**
 * The R2 key a bundle upload's presigned URL pointed at (`app.ts`'s `presignedBundleUrlRoute`,
 * contract §9): `{project}/{version}/builds/{buildNumber}/bundle.zip`. Duplicated here rather than
 * imported — `app.ts` exports routes, not this key format — so a guarantee test pins today's
 * format; if it ever changes there, this must change with it.
 */
export function bundleZipKey(
  candidate: Pick<OrphanBundleCandidate, 'projectId' | 'versionId' | 'buildNumber'>
): string {
  return `${candidate.projectId}/${candidate.versionId}/builds/${candidate.buildNumber}/bundle.zip`;
}

/** A fresh, immediately-before-the-write re-read of one candidate's state (ledger F92). */
export interface OrphanFreshState {
  hasProcessingStatus: boolean;
  /** The Firestore `updateTime` this read observed; used as the write's precondition. */
  updateTime: string;
}

/**
 * The narrow surface the sweep needs: read pending bundle builds, HEAD the object each one's bundle
 * would have landed at, re-check right before writing, write a verdict conditionally. Kept separate
 * from `FirestoreService`/`StorageService` so the sweep's own logic is testable with a plain
 * in-memory fake (orphan-sweep.test.ts) — no Firestore REST plumbing or R2 binding required.
 */
export interface OrphanSweepStore {
  /** Bundle builds not yet resolved by `/bundle/complete`, created before `cutoff` (ledger F91: one
   *  query across every project, not a per-project scan). */
  findCandidates(cutoff: Date, limit: number): Promise<OrphanBundleCandidate[]>;
  /** True if the bundle ZIP this candidate's presigned URL pointed at exists in R2. */
  bundleObjectExists(candidate: OrphanBundleCandidate): Promise<boolean>;
  /** Ledger F92: re-read immediately before writing. `null` means the document is gone since the
   *  candidate query ran (e.g. the build/project was deleted) — never a genuine orphan at that point. */
  getFreshState(candidate: OrphanBundleCandidate): Promise<OrphanFreshState | null>;
  /** Conditional write guarded by the `updateTime` `getFreshState` returned. `'precondition-failed'`
   *  means the document changed between the fresh read and this write — treated as skipped, never
   *  retried with the same fields. */
  markUploadNeverCompletedIfUnchanged(
    candidate: OrphanBundleCandidate,
    expectedUpdateTime: string
  ): Promise<'marked' | 'precondition-failed'>;
}

export interface OrphanSweepOptions {
  ageMinutes?: number;
  maxDocsPerRun?: number;
  /** Injectable clock, so tests do not have to wait an hour. */
  now?: Date;
}

export interface OrphanSweepResult {
  /** Total candidate build documents the store's query returned this run — the quantity
   *  `maxDocsPerRun` bounds. */
  docsScanned: number;
  markedFailed: Array<{ projectId: string; buildId: string }>;
  /** A candidate this run deliberately left alone because it was no longer a genuine orphan by the
   *  time of the fresh re-check or the write — resolved elsewhere, or raced (ledger F92). Never an
   *  error: this is the sweep working as designed. */
  skipped: Array<{ projectId: string; buildId: string; reason: 'resolved-before-write' | 'deleted-before-write' | 'precondition-failed' }>;
  /** Builds (or the candidate query itself) whose read/write threw. Scanned/marked/skipped counts
   *  exclude these. */
  errors: Array<{ projectId?: string; buildId?: string; error: string }>;
}

/**
 * Find bundle builds whose upload never completed and mark them `failed`.
 *
 * The store's own query (`findCandidates`) already filters to bundle builds with no
 * `processingStatus` (ledger F91: server-side, via `bundlePending`) — `hasSource`/
 * `hasProcessingStatus` on each returned candidate are kept as a cheap client-side sanity check
 * against that invariant, using data already in hand, not a re-implementation of the filter.
 *
 * A candidate is left alone unless ALL hold:
 *   - it has `source` set and no `processingStatus` at query time (see above)
 *   - its bundle.zip object does not exist in R2 — one that exists but whose `/complete` call is
 *     merely late, or failed client-side after a successful PUT, is a related-but-different problem
 *     (ledger followup F89), not this sweep's job to resolve
 *   - a FRESH re-read immediately before the write (ledger F92) still shows no `processingStatus`
 *   - the write itself still applies against that fresh read's `updateTime` — Firestore's own
 *     precondition catches a `/bundle/complete` call that lands in the narrow window between the
 *     fresh read and the write landing (e.g. during `retryFetch` backoff on a transient error)
 */
export async function sweepOrphanBundleBuilds(
  store: OrphanSweepStore,
  options: OrphanSweepOptions = {}
): Promise<OrphanSweepResult> {
  const now = options.now ?? new Date();
  const ageMinutes = options.ageMinutes ?? DEFAULT_ORPHAN_AGE_MINUTES;
  const maxDocsPerRun = options.maxDocsPerRun ?? DEFAULT_MAX_DOCS_PER_RUN;
  const cutoff = new Date(now.getTime() - ageMinutes * MS_PER_MINUTE);

  const result: OrphanSweepResult = {
    docsScanned: 0,
    markedFailed: [],
    skipped: [],
    errors: [],
  };

  let candidates: OrphanBundleCandidate[];
  try {
    candidates = await store.findCandidates(cutoff, maxDocsPerRun);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ORPHAN] Could not query orphan-bundle candidates:', message);
    result.errors.push({ error: message });
    return result;
  }

  result.docsScanned = candidates.length;
  console.log(
    `[ORPHAN] Scanning ${candidates.length} bundle-pending build(s) created before ${cutoff.toISOString()}`
  );

  for (const candidate of candidates) {
    // See the doc comment above — the store's query already enforces this; kept as a guard.
    if (!candidate.hasSource || candidate.hasProcessingStatus) continue;

    try {
      const exists = await store.bundleObjectExists(candidate);
      if (exists) continue;

      // Ledger F92: re-check immediately before writing, not just at query time — the HEAD call
      // above (and any retries either call made) can take long enough for a genuine, concurrent
      // `/bundle/complete` to land in between.
      const fresh = await store.getFreshState(candidate);
      if (!fresh) {
        result.skipped.push({
          projectId: candidate.projectId,
          buildId: candidate.buildId,
          reason: 'deleted-before-write',
        });
        continue;
      }
      if (fresh.hasProcessingStatus) {
        result.skipped.push({
          projectId: candidate.projectId,
          buildId: candidate.buildId,
          reason: 'resolved-before-write',
        });
        continue;
      }

      const outcome = await store.markUploadNeverCompletedIfUnchanged(candidate, fresh.updateTime);
      if (outcome === 'precondition-failed') {
        result.skipped.push({
          projectId: candidate.projectId,
          buildId: candidate.buildId,
          reason: 'precondition-failed',
        });
        continue;
      }

      result.markedFailed.push({ projectId: candidate.projectId, buildId: candidate.buildId });
      console.log(
        `[ORPHAN] ${candidate.projectId}/${candidate.buildId}: marked failed ` +
          `(${UPLOAD_NEVER_COMPLETED_MESSAGE}, created ${candidate.createdAt.toISOString()})`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ORPHAN] Could not resolve ${candidate.projectId}/${candidate.buildId}:`, message);
      result.errors.push({ projectId: candidate.projectId, buildId: candidate.buildId, error: message });
    }
  }

  console.log(
    `[ORPHAN] Scanned ${result.docsScanned} doc(s): ${result.markedFailed.length} marked failed, ` +
      `${result.skipped.length} skipped, ${result.errors.length} error(s)`
  );

  return result;
}
