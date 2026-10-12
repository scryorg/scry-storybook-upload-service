import { z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { log, reportError, reqFields } from './log.js';
import type { AppEnv } from '../app.js';
import type { FirestoreService } from '../services/firestore/firestore.service.js';

/**
 * Best-effort write of commitSha/branch onto the build document, with a visible failure marker
 * (upload-provenance-updatemask D2, ISSUES.md #61).
 *
 * The write itself must never fail an upload that has already succeeded -- a build that indexes
 * without a SHA reports its freshness as unknown, which beats not indexing. But a best-effort write
 * that fails 100% of the time (the exact shape of this incident) is indistinguishable from a working
 * one from every operator-facing signal except a `console.warn` nobody watches. So a rejected write
 * here also records a small `provenanceError` field on the build document -- the one place a human
 * or a future healthcheck would already be looking -- via a SEPARATE single-field `updateBuild()`
 * call, so it has its own chance to succeed even when the commitSha/branch write itself failed.
 * Cleared (the field removed, never stored as null) the next time a provenance write for this build
 * succeeds. The marking/clearing calls are themselves best-effort and never throw further.
 */
export async function recordBuildProvenance(
  firestore: FirestoreService,
  project: string,
  build: { id: string; provenanceError?: unknown },
  route: 'coverage' | 'metadata' | 'delta',
  gitContext: { commitSha?: string; branch?: string },
  c?: Context<AppEnv>
): Promise<void> {
  const fields = reqFields(c, { route: `/${route}`, project, build_id: build.id });
  try {
    await firestore.updateBuild(project, build.id, gitContext);
    log.info('build provenance recorded', fields);
    if (build.provenanceError) {
      try {
        await firestore.updateBuild(project, build.id, { provenanceError: null });
      } catch (clearError) {
        reportError(c, clearError, 'could not clear provenance marker', 'provenance_clear_failed', fields);
      }
    }
  } catch (e) {
    // Only a short, already-bounded message goes on the build document (never a token, header or
    // raw response body); the log line carries a fixed code and the exception goes to Sentry.
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    reportError(c, e, 'could not record provenance', 'provenance_write_failed', fields);
    try {
      await firestore.updateBuild(project, build.id, {
        provenanceError: { at: new Date().toISOString(), message, route },
      });
    } catch (markerError) {
      reportError(c, markerError, 'could not record provenance marker', 'provenance_marker_failed', fields);
    }
  }
}


/**
 * Where a build came from, sent by the CLI alongside the metadata ZIP.
 *
 * Query parameters rather than a body field because the body is the ZIP. Both
 * are optional: a deploy from a machine with no git context sends neither, and
 * the build keeps no commit rather than an invented one (P13a).
 */
export const BuildProvenanceQuerySchema = z.object({
  commitSha: z
    .string()
    .regex(/^[0-9a-fA-F]{7,40}$/, 'commitSha must be a hex git object name')
    .optional()
    .openapi({ example: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' }),
  branch: z.string().min(1).max(255).optional().openapi({ example: 'main' }),
});

