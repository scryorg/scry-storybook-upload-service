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
 */

const MS_PER_MINUTE = 60_000;

/** Minutes since creation before an un-uploaded bundle build counts as orphaned. */
export const DEFAULT_ORPHAN_AGE_MINUTES = 60;

/**
 * Upper bound on how many build documents one run reads across every project combined — not on how
 * many it marks failed (most read docs are not orphans at all). A cap rather than pagination: a
 * cron that quietly does half the job across an ever-growing estate is a regression on its own, so
 * if this is ever hit routinely it should be raised deliberately rather than silently degrade
 * (mirrors PROJECT_SCAN_LIMIT in the sibling stall-detector).
 */
export const DEFAULT_MAX_DOCS_PER_RUN = 200;

/** How many projects one run walks looking for orphans. */
export const DEFAULT_PROJECT_SCAN_LIMIT = 500;

/** How many candidate builds one project's query returns, before the run-wide cap is applied. */
export const DEFAULT_PER_PROJECT_LIMIT = 50;

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

/**
 * The narrow surface the sweep needs: read projects, read their old builds, HEAD the object each
 * one's bundle would have landed at, write a verdict. Kept separate from `FirestoreService`/
 * `StorageService` so the sweep's own logic is testable with a plain in-memory fake
 * (orphan-sweep.test.ts) — no Firestore REST plumbing or R2 binding required.
 */
export interface OrphanSweepStore {
  listProjectIds(limit?: number): Promise<string[]>;
  findCandidates(projectId: string, cutoff: Date, limit: number): Promise<OrphanBundleCandidate[]>;
  /** True if the bundle ZIP this candidate's presigned URL pointed at exists in R2. */
  bundleObjectExists(candidate: OrphanBundleCandidate): Promise<boolean>;
  markUploadNeverCompleted(candidate: OrphanBundleCandidate): Promise<void>;
}

export interface OrphanSweepOptions {
  ageMinutes?: number;
  maxDocsPerRun?: number;
  projectLimit?: number;
  perProjectLimit?: number;
  /** Injectable clock, so tests do not have to wait an hour. */
  now?: Date;
}

export interface OrphanSweepResult {
  projectsScanned: number;
  /** Total build documents read from Firestore this run — the quantity `maxDocsPerRun` bounds. */
  docsScanned: number;
  markedFailed: Array<{ projectId: string; buildId: string }>;
  /** Projects or builds whose query/update threw. Scanned/marked counts exclude them. */
  errors: Array<{ projectId: string; buildId?: string; error: string }>;
}

/**
 * Find bundle builds whose upload never completed and mark them `failed`.
 *
 * A candidate is left alone unless all three hold:
 *   - it has `source` set (a bundle build; a legacy storybook.zip build never gets one, contract
 *     §4/G1 — this sweep never touches those)
 *   - it has NO `processingStatus` at all — any value (queued/processing/completed/partial/failed)
 *     means `/bundle/complete` already ran, successfully or not, and this sweep must never reopen
 *     that verdict. This also makes the sweep idempotent: a build it already marked failed now has
 *     `processingStatus: 'failed'` and will not match again on the next run.
 *   - its bundle.zip object does not exist in R2 — one that exists but whose `/complete` call is
 *     merely late, or failed client-side after a successful PUT, is a related-but-different problem
 *     (ledger followup), not this sweep's job to resolve.
 */
export async function sweepOrphanBundleBuilds(
  store: OrphanSweepStore,
  options: OrphanSweepOptions = {}
): Promise<OrphanSweepResult> {
  const now = options.now ?? new Date();
  const ageMinutes = options.ageMinutes ?? DEFAULT_ORPHAN_AGE_MINUTES;
  const maxDocsPerRun = options.maxDocsPerRun ?? DEFAULT_MAX_DOCS_PER_RUN;
  const projectLimit = options.projectLimit ?? DEFAULT_PROJECT_SCAN_LIMIT;
  const perProjectLimit = options.perProjectLimit ?? DEFAULT_PER_PROJECT_LIMIT;
  const cutoff = new Date(now.getTime() - ageMinutes * MS_PER_MINUTE);

  const result: OrphanSweepResult = {
    projectsScanned: 0,
    docsScanned: 0,
    markedFailed: [],
    errors: [],
  };

  const projectIds = await store.listProjectIds(projectLimit);
  console.log(
    `[ORPHAN] Scanning ${projectIds.length} project(s) for bundle builds created before ${cutoff.toISOString()}`
  );

  for (const projectId of projectIds) {
    if (result.docsScanned >= maxDocsPerRun) break;

    try {
      const limit = Math.min(perProjectLimit, maxDocsPerRun - result.docsScanned);
      const candidates = await store.findCandidates(projectId, cutoff, limit);
      result.projectsScanned++;
      result.docsScanned += candidates.length;

      for (const candidate of candidates) {
        // Never touches a legacy storybook.zip build (no `source`) or one `/bundle/complete`
        // already resolved (any processingStatus at all) — see the doc comment above.
        if (!candidate.hasSource || candidate.hasProcessingStatus) continue;

        try {
          const exists = await store.bundleObjectExists(candidate);
          if (exists) continue;

          await store.markUploadNeverCompleted(candidate);
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
    } catch (error) {
      // One project's query failing must not cost the others their scan (mirrors the sibling
      // stall-detector's same rule).
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ORPHAN] Could not scan project ${projectId}:`, message);
      result.errors.push({ projectId, error: message });
    }
  }

  console.log(
    `[ORPHAN] Scanned ${result.projectsScanned} project(s), ${result.docsScanned} doc(s): ` +
      `${result.markedFailed.length} marked failed, ${result.errors.length} error(s)`
  );

  return result;
}
