import { log } from '../../lib/log.js';
import { scrubString } from '../../lib/scry-log/index.js';
import type { FirestoreService } from './firestore.service.js';
import type {
  Build,
  BuildCoverage,
  BuildProcessingStatus,
  BuildProvenanceError,
  BuildSource,
  BuildStatus,
  BuildValidationIssue,
  CiTimings,
  CreateBuildData,
  UpdateBuildData,
  Upload,
  CreateUploadData,
  OrphanBundleCandidate,
} from './firestore.types.js';
import { retryFetch } from '../../utils/firestore-retry.js';

/**
 * True when a Firestore REST error response is specifically a `currentDocument` precondition
 * mismatch (ledger F92) — the document changed since the `updateTime` the caller sent, not some
 * other 400/409. Firestore's REST API always shapes an error body as
 * `{ error: { code, message, status } }`; `status` is the canonical gRPC status name
 * (FAILED_PRECONDITION for an updateTime mismatch; ABORTED can also carry contention-style
 * failures under load, treated the same way here since both mean "the write did not apply, and
 * retrying the same stale fields would not help"). A 400/409 for any other reason (malformed
 * field path, auth, a genuinely missing document with `currentDocument.exists=false` — not used by
 * this client) reports a status other than these two and is NOT treated as a precondition failure,
 * so it still surfaces as a thrown error.
 */
export function isPreconditionFailure(status: number, bodyText: string): boolean {
  if (status !== 400 && status !== 409) return false;
  try {
    const parsed = JSON.parse(bodyText);
    const rpcStatus = parsed?.error?.status;
    return rpcStatus === 'FAILED_PRECONDITION' || rpcStatus === 'ABORTED';
  } catch {
    return false;
  }
}

/**
 * A collection-group query's results (`findOrphanBundleCandidates`, ledger F91) come back with the
 * FULL document path, not scoped under a single project like every other query in this file:
 * `projects/{firestoreProjectId}/databases/(default)/documents/projects/{appProjectId}/builds/{buildId}`.
 * `null` for a shape this never expects (defensive; a build doc always lives at exactly this depth
 * under a project).
 */
export function parseProjectAndBuildFromDocName(name: string): { projectId: string; buildId: string } | null {
  const match = name.match(/\/documents\/projects\/([^/]+)\/builds\/([^/]+)$/);
  if (!match) return null;
  return { projectId: match[1], buildId: match[2] };
}

interface FirestoreConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  serviceAccountId: string;
}

/**
 * A Firestore REST API "Value" wire object (recursive) — narrowed to the variants
 * `toFirestoreValue`/`fromFirestoreValue` actually produce or consume in this file.
 */
interface FirestoreValue {
  nullValue?: null;
  booleanValue?: boolean;
  integerValue?: string;
  doubleValue?: number;
  stringValue?: string;
  timestampValue?: string;
  arrayValue?: { values?: FirestoreValue[] };
  mapValue?: { fields?: FirestoreFields };
}

/** A Firestore REST document's `fields` map — also the shape every write body sends. */
type FirestoreFields = Record<string, FirestoreValue>;

/** A Firestore REST document, as returned by get/runQuery. */
interface FirestoreDocument {
  name: string;
  fields: FirestoreFields;
  updateTime: string;
}

/** A Firestore REST `StructuredQuery`, narrowed to the shapes this file builds. */
interface FirestoreStructuredQuery {
  from: Array<{ collectionId: string; allDescendants?: boolean }>;
  where?: {
    fieldFilter?: { field: { fieldPath: string }; op: string; value: FirestoreValue };
    compositeFilter?: {
      op: string;
      filters: Array<{ fieldFilter: { field: { fieldPath: string }; op: string; value: FirestoreValue } }>;
    };
  };
  orderBy?: Array<{ field: { fieldPath: string }; direction: 'ASCENDING' | 'DESCENDING' }>;
  limit?: number;
}

/** One element of a Firestore REST `runQuery` response body. */
interface FirestoreRunQueryResponseItem {
  document?: FirestoreDocument;
}

/**
 * Cloudflare Worker implementation of FirestoreService using Firestore REST API
 * This implementation uses service account authentication via JWT tokens
 */
/**
 * Reduce a Firestore REST error body to what diagnoses a rejected write without carrying data:
 * Google's `error.status` (e.g. INVALID_ARGUMENT) and the names of the fields it complains about
 * (`error.details[].fieldViolations[].field`), capped at 200 chars, plus the scrubbed first 500 chars
 * of the body for Sentry `extra`. Field NAMES only, never values; names are stripped to a safe alphabet.
 */
export function describeFirestoreError(errorBody: string): { detail: string; body: string } {
  // Whole-string scrub, then per-token (`_` and `.` are word characters that hide `sk-...` from boundary-anchored rules).
  const body = scrubString(errorBody.slice(0, 500))
    .replace(/[^\s._"'[\]{},:]+/g, (token) => scrubString(token))
    .slice(0, 500);
  let detail = '';
  try {
    const parsed = JSON.parse(errorBody) as {
      error?: { status?: unknown; details?: Array<{ fieldViolations?: Array<{ field?: unknown }> }> };
    };
    const status = typeof parsed.error?.status === 'string' ? parsed.error.status.replace(/[^A-Z_]/g, '').slice(0, 40) : '';
    const fields: string[] = [];
    for (const d of parsed.error?.details ?? []) {
      for (const v of d?.fieldViolations ?? []) {
        if (typeof v?.field === 'string') {
          // Scrub each path segment on its own: `_` is a word character, so a key such as
          // `branch_sk-live-abc123...` would otherwise hide the secret from the boundary-anchored rules.
          const name = v.field.replace(/[^A-Za-z0-9_.[\]-]/g, '').slice(0, 80);
          fields.push(name.replace(/[^._[\]]+/g, (segment) => scrubString(segment)));
        }
      }
    }
    // Field names can embed customer strings (nested coverage keys), so the detail is scrubbed too.
    detail = scrubString([status, fields.filter(Boolean).join(', ')].filter(Boolean).join(': ').slice(0, 200));
  } catch {
    // not JSON: no detail, the scrubbed body prefix still goes to Sentry
  }
  return { detail, body };
}

export class FirestoreServiceWorker implements FirestoreService {
  private config: FirestoreConfig;
  private baseUrl: string;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;

  constructor(config: FirestoreConfig) {
    this.config = config;
    this.baseUrl = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents`;
  }

  /**
   * Creates a new build record with auto-incrementing build number
   * Note: REST API doesn't support true transactions, so we use a simplified approach
   */
  /**
   * Record a product event, reusing this service's existing credentials.
   *
   * Never throws. An upload that succeeded must not be reported as failed
   * because an analytics write did not land — the same rule the queue send
   * already follows, for the same reason.
   */
  async trackEvent(name: string, props: Record<string, string | number | boolean | undefined> = {}): Promise<void> {
    try {
      const token = await this.getAccessToken();
      const fields: Record<string, unknown> = {
        name: { stringValue: name },
        at: { timestampValue: new Date().toISOString() },
      };
      for (const [key, value] of Object.entries(props)) {
        if (value === undefined) continue;
        if (typeof value === 'number') fields[key] = { integerValue: String(Math.round(value)) };
        else if (typeof value === 'boolean') fields[key] = { booleanValue: value };
        else fields[key] = { stringValue: String(value) };
      }
      await fetch(`${this.baseUrl}/events`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields }),
      });
    } catch (e) {
      log.warn('could not record event', { err_code: 'event_record_failed' });
    }
  }

  async createBuild(
    projectId: string,
    data: CreateBuildData
  ): Promise<Build> {
    log.debug('create build step');
    const token = await this.getAccessToken();
    
    // Get current build number
    const counterPath = `projects/${projectId}/counters/builds`;
    let buildNumber = 1;
    log.debug('create build step');
    
    try {
      const counterDoc = await this.getDocument(counterPath, token);
      if (counterDoc && counterDoc.fields?.currentBuildNumber?.integerValue) {
        buildNumber = parseInt(counterDoc.fields.currentBuildNumber.integerValue) + 1;
      }
    } catch {
      // Counter doesn't exist, will create it
    }

    // Update counter
    log.debug('create build step');
    await this.setDocument(counterPath, {
      currentBuildNumber: { integerValue: buildNumber.toString() }
    }, token);

    // Create build document
    const buildId = this.generateId();
    const buildPath = `projects/${projectId}/builds/${buildId}`;
    const now = new Date();
    log.debug('create build step');
    
    const buildDoc = {
      projectId: { stringValue: projectId },
      versionId: { stringValue: data.versionId },
      buildNumber: { integerValue: buildNumber.toString() },
      zipUrl: { stringValue: data.zipUrl },
      status: { stringValue: 'active' },
      createdAt: { timestampValue: now.toISOString() },
      createdBy: { stringValue: this.config.serviceAccountId },
      ...(data.coverage ? { coverage: this.toFirestoreValue(data.coverage) } : {}),
      // Build provenance (P13a). versionId identifies a deploy; this identifies
      // the code. Written only when the uploader knew it.
      ...(data.commitSha ? { commitSha: { stringValue: data.commitSha } } : {}),
      ...(data.branch ? { branch: { stringValue: data.branch } } : {}),
      // Which key created the build (upload-project-key-scope): doc id + project, never the key.
      ...(data.uploadedByKeyId ? { uploadedByKeyId: { stringValue: data.uploadedByKeyId } } : {}),
      ...(data.uploadedByKeyProject ? { uploadedByKeyProject: { stringValue: data.uploadedByKeyProject } } : {}),
      // CI timings (storybook-preview-ci-runtime). Written only when the
      // deployer sent them; absent is never stored as zeros.
      ...(data.ciTimings ? { ciTimings: this.toFirestoreValue(data.ciTimings) } : {}),
      // Where this build's captures came from (capture-sources); absent = legacy Storybook web.
      ...(data.source ? { source: this.toFirestoreValue(data.source) } : {}),
      // Ledger F91/F80: set only alongside `source` (only the bundle presign route passes one) —
      // marks a bundle build as awaiting its `/bundle/complete` call. Cleared by `updateBuild`/
      // `updateProcessingStatus` the instant any processingStatus is written for this build,
      // whichever writer does it first. The orphan-bundle sweep's sole query filters on this field
      // (`findOrphanBundleCandidates`) instead of scanning every project's builds looking for one
      // with `source` set and no `processingStatus` — see that method's doc comment.
      ...(data.source ? { bundlePending: { booleanValue: true } } : {}),
    };

    log.debug('create build step');
    await this.setDocument(buildPath, buildDoc, token);
    log.debug('create build step');

    return {
      id: buildId,
      projectId,
      ...(data.commitSha ? { commitSha: data.commitSha } : {}),
      ...(data.branch ? { branch: data.branch } : {}),
      versionId: data.versionId,
      buildNumber,
      zipUrl: data.zipUrl,
      status: 'active',
      createdAt: now,
      createdBy: this.config.serviceAccountId,
      ...(data.ciTimings ? { ciTimings: data.ciTimings } : {}),
      ...(data.source ? { source: data.source } : {}),
    };
  }

  /**
   * Retrieves a build by its ID
   */
  async getBuild(
    projectId: string,
    buildId: string
  ): Promise<Build | null> {
    const token = await this.getAccessToken();
    const buildPath = `projects/${projectId}/builds/${buildId}`;
    
    try {
      const doc = await this.getDocument(buildPath, token);
      if (!doc) return null;
      return this.convertDocToBuild(buildId, doc.fields);
    } catch {
      // Any read/parse failure here is treated the same as "not found" — callers
      // of getBuild already handle a null return exactly like a missing document.
      return null;
    }
  }

  /**
   * Gets all builds for a project with optional filtering
   */
  async getProjectBuilds(
    projectId: string,
    statusFilter?: BuildStatus,
    limitCount: number = 50
  ): Promise<Build[]> {
    const token = await this.getAccessToken();

    // Build query
    const structuredQuery: FirestoreStructuredQuery = {
      from: [{ collectionId: 'builds' }],
      orderBy: [{ field: { fieldPath: 'buildNumber' }, direction: 'DESCENDING' }],
      limit: limitCount
    };

    if (statusFilter) {
      structuredQuery.where = {
        fieldFilter: {
          field: { fieldPath: 'status' },
          op: 'EQUAL',
          value: { stringValue: statusFilter }
        }
      };
    }

    const docs = await this.queryDocuments(`projects/${projectId}`, structuredQuery, token);
    return docs.map(doc => {
      const id = doc.name.split('/').pop()!;
      return this.convertDocToBuild(id, doc.fields);
    });
  }

  /**
   * Bundle builds still awaiting their `/bundle/complete` call, created before `cutoff`, for the
   * orphan-bundle sweep (ledger F80, cost/coverage fix F91).
   *
   * ONE `collectionGroup('builds')` query across every project, filtered on `bundlePending == true`
   * (set only by `createBuild` for a bundle build, cleared by `updateBuild`/`updateProcessingStatus`
   * the instant any processingStatus is written — see those methods) AND `createdAt < cutoff`,
   * ordered by `createdAt` ascending so the longest-stuck builds surface first. This replaces the
   * original `listProjectIds` + per-project `createdAt`-only scan: that shape cost ~(project count) +
   * up to `maxDocsPerRun` reads every run regardless of orphan rate (re-reading the same resolved
   * builds indefinitely) and could silently starve later-listed projects once the run-wide cap was
   * reached. Filtering server-side on `bundlePending` instead means the read cost is bounded by the
   * number of builds ACTUALLY still pending, not by total build history or project count, and
   * `listProjectIds` is no longer needed at all.
   *
   * Requires one manually-created composite index (collection-group indexes for a multi-field
   * filter are never automatic): collectionGroup `builds`, queryScope COLLECTION_GROUP, fields
   * `bundlePending` ASC then `createdAt` ASC — see `docs/ORPHAN_SWEEP_FIRESTORE_INDEX.md`. Without
   * it this query throws FAILED_PRECONDITION on every run (caught by the sweep's own per-run error
   * handling, logged, not thrown to the caller — but the sweep does nothing until the index exists).
   */
  async findOrphanBundleCandidates(cutoff: Date, limit = 200): Promise<OrphanBundleCandidate[]> {
    const token = await this.getAccessToken();
    const structuredQuery: FirestoreStructuredQuery = {
      from: [{ collectionId: 'builds', allDescendants: true }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: [
            {
              fieldFilter: {
                field: { fieldPath: 'bundlePending' },
                op: 'EQUAL',
                value: { booleanValue: true },
              },
            },
            {
              fieldFilter: {
                field: { fieldPath: 'createdAt' },
                op: 'LESS_THAN',
                value: { timestampValue: cutoff.toISOString() },
              },
            },
          ],
        },
      },
      orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'ASCENDING' }],
      limit,
    };

    // Empty parent = query rooted at the documents collection (same pattern the removed
    // `listProjectIds` used) — required for a true collection-group query (`allDescendants: true`)
    // that is not scoped under any single project.
    const docs = await this.queryDocuments('', structuredQuery, token);
    return docs
      .map((doc) => {
        const parsed = parseProjectAndBuildFromDocName(String(doc.name));
        if (!parsed) return null;
        const fields = doc.fields ?? {};
        return {
          buildId: parsed.buildId,
          projectId: parsed.projectId,
          versionId: fields.versionId?.stringValue || '',
          buildNumber: parseInt(fields.buildNumber?.integerValue || '0', 10),
          createdAt: new Date(fields.createdAt?.timestampValue || new Date().toISOString()),
          hasSource: fields.source !== undefined,
          hasProcessingStatus: fields.processingStatus !== undefined,
        };
      })
      .filter((c): c is OrphanBundleCandidate => c !== null);
  }

  /**
   * Fresh re-read of one candidate's `processingStatus` presence + Firestore `updateTime`,
   * immediately before the orphan sweep would mark it failed (ledger F92). The candidate's own
   * query snapshot (`findOrphanBundleCandidates`, above) can be stale by however long the R2 HEAD
   * check — and any retries either call made — took, so this must happen right before the write,
   * never reuse the original query's snapshot. `null` means the document no longer exists (the
   * build or project was deleted since the query ran); the sweep treats that as "no longer a
   * candidate", never as an error.
   */
  async getBuildOrphanState(
    projectId: string,
    buildId: string
  ): Promise<{ hasProcessingStatus: boolean; updateTime: string } | null> {
    const token = await this.getAccessToken();
    const doc = await this.getDocument(`projects/${projectId}/builds/${buildId}`, token);
    if (!doc) return null;
    return {
      hasProcessingStatus: doc.fields?.processingStatus !== undefined,
      updateTime: doc.updateTime,
    };
  }

  /**
   * Mark a bundle build's upload as never completed (ledger F80), guarded by the document's
   * `updateTime` at the moment `getBuildOrphanState` read it (ledger F92). Firestore's
   * `currentDocument.updateTime` precondition makes this atomic with that read: if a genuine,
   * concurrent `/bundle/complete` call has landed (and so changed `updateTime`) since, Firestore
   * rejects the whole PATCH with FAILED_PRECONDITION instead of applying it — `patchDocument`
   * reports that back as `preconditionFailed` rather than throwing, and it is never retried with
   * the same stale fields (400/409 are outside `retryFetch`'s retryable set).
   */
  async markBuildFailedIfUnchanged(
    projectId: string,
    buildId: string,
    processingError: string,
    expectedUpdateTime: string
  ): Promise<'marked' | 'precondition-failed'> {
    const token = await this.getAccessToken();
    const buildPath = `projects/${projectId}/builds/${buildId}`;
    const result = await this.patchDocument(
      buildPath,
      {
        processingStatus: { stringValue: 'failed' },
        processingError: { stringValue: processingError },
      },
      token,
      // Clears bundlePending too — see the matching comment on updateBuild.
      ['processingStatus', 'processingError', 'bundlePending'],
      { ifUpdateTime: expectedUpdateTime }
    );
    return result.preconditionFailed ? 'precondition-failed' : 'marked';
  }

  /**
   * Finds a build by its version ID.
   *
   * Note: We intentionally avoid `orderBy(buildNumber)` here to prevent requiring
   * a composite index (Firestore will throw FAILED_PRECONDITION without one).
   *
   * If multiple builds exist for the same version (should be rare), we select
   * the build with the highest `buildNumber` client-side.
   *
   * Concurrency caveat: if you run multiple deployments simultaneously for the
   * same (projectId, versionId), this selection may attach coverage to the
   * newest build for that version. If you need strict run-level association,
   * prefer passing/using an explicit buildId when attaching coverage.
   */
  async getBuildByVersion(
    projectId: string,
    versionId: string
  ): Promise<Build | null> {
    log.debug('get build by version step');

    log.debug('get build by version step');
    const token = await this.getAccessToken();
    log.debug('get build by version step');

    const structuredQuery: FirestoreStructuredQuery = {
      from: [{ collectionId: 'builds' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'versionId' },
          op: 'EQUAL',
          value: { stringValue: versionId },
        },
      },
      // No orderBy here to avoid composite index requirement
      limit: 50,
    };

    log.debug('get build by version step');

    const parentPath = `projects/${projectId}`;
    log.debug('get build by version step');
    const docs = await this.queryDocuments(parentPath, structuredQuery, token);
    log.debug('get build by version step');
    if (docs.length === 0) {
      const fallbackQuery = {
        from: [{ collectionId: 'builds' }],
        limit: 5,
      };
      log.debug('get build by version step');
      const fallbackDocs = await this.queryDocuments(parentPath, fallbackQuery, token);
      log.debug('get build by version step');
      return null;
    }

    // Choose the latest build by buildNumber
    let bestDoc = docs[0];
    for (const doc of docs) {
      const current = this.convertDocToBuild(doc.name.split('/').pop()!, doc.fields);
      const best = this.convertDocToBuild(bestDoc.name.split('/').pop()!, bestDoc.fields);
      log.debug('get build by version step');
      if ((current.buildNumber ?? 0) > (best.buildNumber ?? 0)) {
        bestDoc = doc;
      }
    }

    const id = bestDoc.name.split('/').pop()!;
    return this.convertDocToBuild(id, bestDoc.fields);
  }

  /**
   * Gets the latest active build for a project
   */
  async getLatestBuild(
    projectId: string,
    versionId?: string
  ): Promise<Build | null> {
    if (versionId) {
      return this.getBuildByVersion(projectId, versionId);
    }

    const token = await this.getAccessToken();
    
    const structuredQuery: FirestoreStructuredQuery = {
      from: [{ collectionId: 'builds' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'status' },
          op: 'EQUAL',
          value: { stringValue: 'active' }
        }
      },
      orderBy: [{ field: { fieldPath: 'buildNumber' }, direction: 'DESCENDING' }],
      limit: 1
    };

    const docs = await this.queryDocuments(`projects/${projectId}`, structuredQuery, token);
    if (docs.length === 0) return null;
    
    const id = docs[0].name.split('/').pop()!;
    return this.convertDocToBuild(id, docs[0].fields);
  }

  /**
   * Updates a build record
   */
  async updateBuild(
    projectId: string,
    buildId: string,
    updates: UpdateBuildData
  ): Promise<void> {
    const token = await this.getAccessToken();
    const buildPath = `projects/${projectId}/builds/${buildId}`;
    
    const fields: FirestoreFields = {};
    if (updates.status) fields.status = { stringValue: updates.status };
    if (updates.zipUrl) fields.zipUrl = { stringValue: updates.zipUrl };
    if (updates.archivedAt) fields.archivedAt = { timestampValue: updates.archivedAt.toISOString() };
    if (updates.archivedBy) fields.archivedBy = { stringValue: updates.archivedBy };
    if (updates.coverage) fields.coverage = this.toFirestoreValue(updates.coverage);
    if (updates.processingStatus) fields.processingStatus = { stringValue: updates.processingStatus };
    if (updates.commitSha) fields.commitSha = { stringValue: updates.commitSha };
    if (updates.branch) fields.branch = { stringValue: updates.branch };
    if (updates.ciTimings) fields.ciTimings = this.toFirestoreValue(updates.ciTimings);
    if (updates.validationErrors) fields.validationErrors = this.toFirestoreValue(updates.validationErrors);
    if (updates.processingError) fields.processingError = { stringValue: updates.processingError };

    const maskFieldPaths = Object.keys(fields);
    if (updates.provenanceError !== undefined) {
      maskFieldPaths.push('provenanceError');
      // `null` means "clear it": leave it out of `fields` but keep it in the mask, so Firestore's
      // documented PATCH semantics remove the field instead of storing a literal null (D2).
      if (updates.provenanceError !== null) {
        fields.provenanceError = this.toFirestoreValue(updates.provenanceError);
      }
    }
    // Ledger F91: `bundlePending` is set only by createBuild, only for a bundle build (alongside
    // `source`), and exists solely so the orphan-bundle sweep's collection-group query can find
    // bundle builds whose upload never completed without scanning every project. ANY write of
    // processingStatus here — success (`queued`, via /bundle/complete), rejection (`failed` with
    // validationErrors), or the sweep's own verdict — means that question is now resolved, so it is
    // cleared in the same PATCH regardless of which caller set processingStatus. Absent on every
    // legacy/non-bundle build; Firestore's masked-absent-field semantics make this a harmless no-op
    // for those (D2/F9).
    if (updates.processingStatus) {
      maskFieldPaths.push('bundlePending');
    }

    await this.patchDocument(buildPath, fields, token, maskFieldPaths);
  }

  /**
   * Archives a build
   */
  async archiveBuild(
    projectId: string,
    buildId: string,
    userId: string
  ): Promise<void> {
    const token = await this.getAccessToken();
    const buildPath = `projects/${projectId}/builds/${buildId}`;
    
    const fields = {
      status: { stringValue: 'archived' },
      archivedAt: { timestampValue: new Date().toISOString() },
      archivedBy: { stringValue: userId }
    };

    await this.patchDocument(buildPath, fields, token);
  }

  /**
   * Updates coverage data for a build
   */
  async updateBuildCoverage(
    projectId: string,
    buildId: string,
    coverage: BuildCoverage
  ): Promise<void> {
    const token = await this.getAccessToken();
    const buildPath = `projects/${projectId}/builds/${buildId}`;

    await this.patchDocument(buildPath, { coverage: this.toFirestoreValue(coverage) }, token);
  }

  /**
   * Updates metadata processing status for a build.
   */
  async updateProcessingStatus(
    projectId: string,
    buildId: string,
    status: BuildProcessingStatus
  ): Promise<void> {
    const token = await this.getAccessToken();
    const buildPath = `projects/${projectId}/builds/${buildId}`;
    // Ledger F91: this is the route's own success path (`/bundle/complete` sets `queued` here after
    // validation) — see the matching comment on `updateBuild` above for why `bundlePending` is
    // cleared alongside processingStatus in every writer, not only there.
    await this.patchDocument(
      buildPath,
      { processingStatus: { stringValue: status } },
      token,
      ['processingStatus', 'bundlePending']
    );
  }

  /**
   * Deletes a build record
   */
  async deleteBuild(
    projectId: string,
    buildId: string
  ): Promise<void> {
    const token = await this.getAccessToken();
    const buildPath = `projects/${projectId}/builds/${buildId}`;
    
    const url = `${this.baseUrl}/${buildPath}`;
    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`,
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to delete build: ${response.statusText}`);
    }
  }

  // ============= UPLOAD OPERATIONS =============

  /**
   * Creates a new upload record with auto-incrementing upload number.
   * Note: REST API doesn't support true transactions, so we use a simplified approach
   * (same as createBuild). The Node.js implementation uses Firestore transactions
   * for atomicity.
   */
  async createUpload(
    projectId: string,
    data: CreateUploadData
  ): Promise<Upload> {
    const token = await this.getAccessToken();

    // Get current upload number
    const counterPath = `projects/${projectId}/counters/uploads`;
    let uploadNumber = 1;

    try {
      const counterDoc = await this.getDocument(counterPath, token);
      if (counterDoc && counterDoc.fields?.currentUploadNumber?.integerValue) {
        uploadNumber = parseInt(counterDoc.fields.currentUploadNumber.integerValue) + 1;
      }
    } catch (error) {
      log.warn('could not read upload counter', { err_code: 'upload_counter_read_failed' });
    }

    // Update counter
    await this.setDocument(counterPath, {
      currentUploadNumber: { integerValue: uploadNumber.toString() }
    }, token);

    // Create upload document
    const uploadId = this.generateId();
    const uploadPath = `projects/${projectId}/uploads/${uploadId}`;
    const now = new Date();

    const uploadDoc = {
      projectId: { stringValue: projectId },
      uploadNumber: { integerValue: uploadNumber.toString() },
      imageCount: { integerValue: data.imageCount.toString() },
      zipUrl: { stringValue: data.zipUrl },
      status: { stringValue: 'active' },
      createdAt: { timestampValue: now.toISOString() },
      createdBy: { stringValue: this.config.serviceAccountId },
    };

    await this.setDocument(uploadPath, uploadDoc, token);

    return {
      id: uploadId,
      projectId,
      uploadNumber,
      imageCount: data.imageCount,
      zipUrl: data.zipUrl,
      status: 'active',
      createdAt: now,
      createdBy: this.config.serviceAccountId,
    };
  }

  async getUpload(
    projectId: string,
    uploadId: string
  ): Promise<Upload | null> {
    const token = await this.getAccessToken();
    const uploadPath = `projects/${projectId}/uploads/${uploadId}`;

    try {
      const doc = await this.getDocument(uploadPath, token);
      if (!doc) return null;
      return this.convertDocToUpload(uploadId, doc.fields);
    } catch (error) {
      log.warn('could not get upload', { err_code: 'upload_get_failed' });
      return null;
    }
  }

  async getProjectUploads(
    projectId: string,
    limitCount: number = 50
  ): Promise<Upload[]> {
    const token = await this.getAccessToken();

    const structuredQuery: FirestoreStructuredQuery = {
      from: [{ collectionId: 'uploads' }],
      orderBy: [{ field: { fieldPath: 'uploadNumber' }, direction: 'DESCENDING' }],
      limit: limitCount
    };

    const docs = await this.queryDocuments(`projects/${projectId}`, structuredQuery, token);
    return docs.map(doc => {
      const id = doc.name.split('/').pop()!;
      return this.convertDocToUpload(id, doc.fields);
    });
  }

  async updateUploadProcessingStatus(
    projectId: string,
    uploadId: string,
    status: BuildProcessingStatus
  ): Promise<void> {
    const token = await this.getAccessToken();
    const uploadPath = `projects/${projectId}/uploads/${uploadId}`;
    await this.patchDocument(uploadPath, { processingStatus: { stringValue: status } }, token);
  }

  async deleteUpload(
    projectId: string,
    uploadId: string
  ): Promise<void> {
    const token = await this.getAccessToken();
    const uploadPath = `projects/${projectId}/uploads/${uploadId}`;

    const url = `${this.baseUrl}/${uploadPath}`;
    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`,
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to delete upload: ${response.statusText}`);
    }
  }

  private convertDocToUpload(id: string, fields: FirestoreFields): Upload {
    const projectId = fields.projectId?.stringValue;
    const uploadNumber = fields.uploadNumber?.integerValue;
    if (!projectId || uploadNumber === undefined) {
      throw new Error(`Upload document ${id} is missing required fields (projectId, uploadNumber)`);
    }

    return {
      id,
      projectId,
      uploadNumber: parseInt(uploadNumber),
      imageCount: parseInt(fields.imageCount?.integerValue || '0'),
      zipUrl: fields.zipUrl?.stringValue || '',
      status: (fields.status?.stringValue || 'active') as Upload['status'],
      processingStatus: fields.processingStatus?.stringValue as BuildProcessingStatus | undefined,
      createdAt: new Date(fields.createdAt?.timestampValue || new Date()),
      createdBy: fields.createdBy?.stringValue || '',
    };
  }

  /**
   * Helper methods for Firestore REST API operations
   */

  /**
   * Convert a JavaScript value into a Firestore REST "Value" object.
   *
   * This is used for nested objects (coverage payload) to keep the Worker
   * implementation feature-parity with the Node Admin SDK version.
   */
  private toFirestoreValue(value: unknown): FirestoreValue {
    if (value === null) return { nullValue: null };
    if (value === undefined) return { nullValue: null };

    if (value instanceof Date) return { timestampValue: value.toISOString() };

    const t = typeof value;
    if (t === 'string') return { stringValue: value as string };
    if (t === 'boolean') return { booleanValue: value as boolean };
    if (t === 'number') {
      const n = value as number;
      if (Number.isInteger(n)) return { integerValue: n.toString() };
      return { doubleValue: n };
    }

    if (Array.isArray(value)) {
      return {
        arrayValue: {
          values: value.map((v) => this.toFirestoreValue(v)),
        },
      };
    }

    if (t === 'object') {
      const fields: FirestoreFields = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v === undefined) continue;
        fields[k] = this.toFirestoreValue(v);
      }
      return { mapValue: { fields } };
    }

    // Fallback: coerce unknowns to string
    return { stringValue: String(value) };
  }

  /**
   * Convert a Firestore REST "Value" object back into JavaScript.
   *
   * This is only used for returning typed data from read operations.
   */
  private fromFirestoreValue(value: FirestoreValue | undefined): unknown {
    if (!value || typeof value !== 'object') return value;

    if ('nullValue' in value) return null;
    if ('booleanValue' in value) return value.booleanValue;
    if ('integerValue' in value) return parseInt(value.integerValue!, 10);
    if ('doubleValue' in value) return value.doubleValue;
    if ('stringValue' in value) return value.stringValue;
    if ('timestampValue' in value) return value.timestampValue;

    if ('mapValue' in value) {
      const fields = value.mapValue?.fields || {};
      const obj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        obj[k] = this.fromFirestoreValue(v);
      }
      return obj;
    }

    if ('arrayValue' in value) {
      const values = value.arrayValue?.values || [];
      return values.map((v) => this.fromFirestoreValue(v));
    }

    return value;
  }

  // Idempotent read: retried on 429/503/500/network (F85/F86).
  private async getDocument(path: string, token: string): Promise<FirestoreDocument | null> {
    const url = `${this.baseUrl}/${path}`;
    const response = await retryFetch(() => fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
      }
    }), { op: 'getDocument' });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Failed to get document: ${response.statusText}`);
    }

    return response.json() as Promise<FirestoreDocument>;
  }

  // Idempotent write: every field here is a fixed value the caller already
  // computed (never a Firestore increment transform — the build/upload
  // counters are read-then-written as an absolute number), so resending the
  // same PATCH on a transient failure is safe. Retried on 429/503/500/network (F85).
  private async setDocument(path: string, fields: FirestoreFields, token: string): Promise<void> {
    const url = `${this.baseUrl}/${path}`;
    const response = await retryFetch(() => fetch(url, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields })
    }), { op: 'setDocument' });

    if (!response.ok) {
      throw new Error(`Failed to set document: ${response.statusText}`);
    }
  }

  /**
   * `maskFieldPaths` defaults to `Object.keys(fields)` (every existing caller). Pass it explicitly
   * to clear a field: Firestore's documented PATCH semantics are that a field named in the mask but
   * absent from the body is removed from the document, so `patchDocument(path, {}, token,
   * ['provenanceError'])` deletes `provenanceError` rather than writing it as `null`
   * (upload-provenance-updatemask D2).
   */
  /**
   * `opts.ifUpdateTime` (ledger F92) adds Firestore's own `currentDocument.updateTime` precondition
   * to the PATCH: the write only applies if the document's `updateTime` still matches what the
   * caller most recently read. A mismatch means the document changed since — Firestore rejects the
   * whole PATCH with FAILED_PRECONDITION (never partially applied), which `isPreconditionFailure`
   * below recognizes so the caller gets `{ preconditionFailed: true }` back instead of a thrown
   * error. That status is outside `retryFetch`'s retryable set (429/500/503 only), so a precondition
   * mismatch is never blindly retried with the same stale fields.
   */
  private async patchDocument(
    path: string,
    fields: FirestoreFields,
    token: string,
    maskFieldPaths?: string[],
    opts?: { ifUpdateTime?: string }
  ): Promise<{ preconditionFailed: boolean }> {
    const url = `${this.baseUrl}/${path}`;

    // Firestore's REST API takes one `updateMask.fieldPaths` query param PER field, not a single
    // comma-joined value (that is parsed as one field path containing a literal comma, which
    // Firestore rejects with "Invalid property path"). A bare field name (our case: top-level
    // build-doc fields like `status`, `zipUrl`, `commitSha`) never needs quoting, but a path
    // segment containing anything other than [A-Za-z0-9_] — or one starting with a digit — must be
    // wrapped in backticks per Firestore's field-path syntax, so this stays correct if a future
    // field name ever needs it.
    const needsBackticks = (segment: string) => !/^[A-Za-z_]\w*$/.test(segment);
    const quoteFieldPath = (fieldPath: string) =>
      needsBackticks(fieldPath) ? `\`${fieldPath.replace(/`/g, '\\`')}\`` : fieldPath;

    const resolvedMaskFields = maskFieldPaths ?? Object.keys(fields);
    // F9 (upload-provenance-updatemask security review): a PATCH sent with NO
    // updateMask.fieldPaths param at all is a full-document replace per Firestore's
    // documented REST contract, not a no-op -- an empty mask here would silently wipe
    // every other field on the document. Every current caller always resolves at least
    // one field; fail closed (throw, never fetch) instead of ever sending that request.
    if (resolvedMaskFields.length === 0) {
      throw new Error(
        `patchDocument() called with an empty update mask for "${path}" -- refusing to send a ` +
        'mask-less Firestore PATCH, which Firestore treats as a full-document replace (F9)'
      );
    }

    const params = new URLSearchParams();
    for (const key of resolvedMaskFields) {
      params.append('updateMask.fieldPaths', quoteFieldPath(key));
    }
    if (opts?.ifUpdateTime) {
      params.append('currentDocument.updateTime', opts.ifUpdateTime);
    }

    // Idempotent write: every field here is a fixed value the caller already
    // computed (never a Firestore increment transform), so resending the same
    // PATCH on a transient failure is safe. Retried on 429/503/500/network (F85).
    const response = await retryFetch(() => fetch(`${url}?${params.toString()}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields })
    }), { op: 'patchDocument' });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      if (opts?.ifUpdateTime && isPreconditionFailure(response.status, errorBody)) {
        // Not a failure to surface as an error (F92): the document changed since the caller's read,
        // which is exactly the condition `ifUpdateTime` exists to catch. The caller decides what a
        // stale write means for it (the orphan sweep counts this as skipped, never retried).
        log.warn('patch precondition failed', { err_code: 'firestore_precondition_failed' });
        return { preconditionFailed: true };
      }
      // Surface the failure so a rejected multi-field update (e.g. marking a build failed with
      // validationErrors, or recording commitSha+branch provenance) shows up in logs instead of
      // only reaching the caller's best-effort .catch() as a swallowed warning (ledger F73 /
      // upload-provenance-updatemask). Never logs the token or the request body, which may carry
      // validationErrors/coverage content but never secrets.
      //
      // log-standardization M2: the 400 body is what named the bad field path in the updateMask
      // incident, so Google's `error.status` and the field-violation NAMES (never values) go on the
      // thrown message (which reaches Sentry and `provenanceError`), and the scrubbed body[:500] rides
      // on the error for Sentry `extra`. The log line keeps a status-bearing code.
      const { detail, body } = describeFirestoreError(errorBody);
      log.error('patch failed', { err_code: `firestore_${response.status}`, status: response.status });
      const failure = new Error(
        `Failed to patch document: ${response.status} ${response.statusText}${detail ? ` (${detail})` : ''}`
      ) as Error & { firestoreBody?: string };
      // Only a 4xx body (a rejected request: bad field path) is worth sending to Sentry; a 5xx body is upstream noise.
      if (response.status >= 400 && response.status < 500) failure.firestoreBody = body;
      throw failure;
    }
    return { preconditionFailed: false };
  }

  private async queryDocuments(parent: string, structuredQuery: FirestoreStructuredQuery, token: string): Promise<FirestoreDocument[]> {
    const parentName = `projects/${this.config.projectId}/databases/(default)/documents/${parent}`;
    log.debug('query documents step');
    // Use the parent path in the URL for subcollection queries. An empty parent means a query
    // rooted at the documents collection itself — a top-level collection query, or a true
    // collection-group query (`allDescendants: true`, e.g. `findOrphanBundleCandidates`, ledger
    // F80/F91) that spans every project — the runQuery call then targets the documents root itself,
    // not `.../documents/:runQuery` (a trailing slash Firestore rejects).
    const url = parent ? `${this.baseUrl}/${parent}:runQuery` : `${this.baseUrl}:runQuery`;
    // Idempotent read: retried on 429/503/500/network (F85/F86).
    const response = await retryFetch(() => fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        structuredQuery
      })
    }), { op: 'runQuery' });

    if (!response.ok) {
      throw new Error(`Failed to query documents: ${response.statusText}`);
    }

    const results = await response.json() as FirestoreRunQueryResponseItem[];
    log.debug('query documents step');
    return results.flatMap((r) => (r.document ? [r.document] : []));
  }

  private convertDocToBuild(id: string, fields: FirestoreFields): Build {
    return {
      id,
      projectId: fields.projectId?.stringValue || '',
      versionId: fields.versionId?.stringValue || '',
      buildNumber: parseInt(fields.buildNumber?.integerValue || '0'),
      zipUrl: fields.zipUrl?.stringValue || '',
      status: (fields.status?.stringValue || 'active') as BuildStatus,
      createdAt: new Date(fields.createdAt?.timestampValue || new Date()),
      createdBy: fields.createdBy?.stringValue || '',
      archivedAt: fields.archivedAt?.timestampValue ? new Date(fields.archivedAt.timestampValue) : undefined,
      archivedBy: fields.archivedBy?.stringValue,
      coverage: fields.coverage ? (this.fromFirestoreValue(fields.coverage) as BuildCoverage) : undefined,
      processingStatus: fields.processingStatus?.stringValue as BuildProcessingStatus | undefined,
      // commitSha/branch (P13a) were added to the write side by #25 but never read back here —
      // every read (getBuild, getBuildByVersion, getProjectBuilds, getLatestBuild) silently dropped
      // them even once the document had them, independent of the updateMask bug this hotfix fixes
      // (upload-provenance-updatemask, ISSUES.md #61; sibling found during Stage 3, fixed alongside).
      ...(fields.commitSha?.stringValue ? { commitSha: fields.commitSha.stringValue } : {}),
      ...(fields.branch?.stringValue ? { branch: fields.branch.stringValue } : {}),
      ...(fields.uploadedByKeyId?.stringValue ? { uploadedByKeyId: fields.uploadedByKeyId.stringValue } : {}),
      ...(fields.uploadedByKeyProject?.stringValue ? { uploadedByKeyProject: fields.uploadedByKeyProject.stringValue } : {}),
      ...(fields.ciTimings ? { ciTimings: this.fromFirestoreValue(fields.ciTimings) as CiTimings } : {}),
      ...(fields.source ? { source: this.fromFirestoreValue(fields.source) as BuildSource } : {}),
      ...(fields.validationErrors ? { validationErrors: this.fromFirestoreValue(fields.validationErrors) as BuildValidationIssue[] } : {}),
      ...(fields.provenanceError ? { provenanceError: this.fromFirestoreValue(fields.provenanceError) as BuildProvenanceError } : {}),
      ...(fields.processingError?.stringValue ? { processingError: fields.processingError.stringValue } : {}),
    };
  }

  /**
   * Generate access token using service account credentials
   */
  private async getAccessToken(): Promise<string> {
    log.debug('access token step');
    // Check if we have a valid cached token
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      log.debug('access token step');
      return this.accessToken;
    }

    // Create JWT
    const jwt = await this.createJWT();

    // Exchange JWT for access token
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to get access token: ${response.status} ${response.statusText} ${errorText}`
      );
    }

    const data = await response.json() as { access_token: string; expires_in: number };
    log.debug('access token step');
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000; // Refresh 1 minute before expiry

    return this.accessToken!;
  }

  /**
   * Create JWT token for service account authentication
   */
  private async createJWT(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      iss: this.config.clientEmail,
      sub: this.config.clientEmail,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
      scope: 'https://www.googleapis.com/auth/datastore',
    };

    const encodedHeader = this.base64UrlEncode(JSON.stringify(header));
    const encodedPayload = this.base64UrlEncode(JSON.stringify(payload));
    const unsignedToken = `${encodedHeader}.${encodedPayload}`;

    // Sign with private key
    const signature = await this.signJWT(unsignedToken, this.config.privateKey);
    return `${unsignedToken}.${signature}`;
  }

  /**
   * Sign JWT using RSA-SHA256
   */
  private async signJWT(data: string, privateKey: string): Promise<string> {
    // Import private key
    // Handle both literal \n and actual newlines in the private key
    const trimmedKey = privateKey.trim();
    const unquotedKey = trimmedKey
      .replace(/^"(.*)"$/, '$1')
      .replace(/^'(.*)'$/, '$1');
    const cleanedKey = unquotedKey.replace(/\\n/g, '\n');
    
    const pemHeader = '-----BEGIN PRIVATE KEY-----';
    const pemFooter = '-----END PRIVATE KEY-----';
    
    // Extract the content between the header and footer
    const pemContents = cleanedKey
      .replace(pemHeader, '')
      .replace(pemFooter, '')
      .replace(/\s/g, ''); // Remove all whitespace including newlines
    
    const binaryKey = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
    
    const cryptoKey = await crypto.subtle.importKey(
      'pkcs8',
      binaryKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );

    // Sign the data
    const encoder = new TextEncoder();
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      encoder.encode(data)
    );

    return this.base64UrlEncode(signature);
  }

  /**
   * Base64 URL encode
   */
  private base64UrlEncode(data: string | ArrayBuffer): string {
    let base64: string;
    
    if (typeof data === 'string') {
      base64 = btoa(data);
    } else {
      const bytes = new Uint8Array(data);
      const binary = String.fromCharCode(...bytes);
      base64 = btoa(binary);
    }
    
    const unpadded = base64.replace(/\+/g, '-').replace(/\//g, '_');
    // Strip trailing '=' padding without a `=+$`-shaped regex (sonarjs/super-linear-regex):
    // a hand-rolled scan is O(n) with no backtracking, unlike a trailing-quantifier regex.
    let end = unpadded.length;
    while (end > 0 && unpadded[end - 1] === '=') end--;
    return unpadded.slice(0, end);
  }

  /**
   * Generate a random document ID
   */
  private generateId(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    // crypto.getRandomValues (not Math.random, sonarjs/pseudo-random) — same 20-char,
    // 62-symbol alphabet and length as before, just a non-pseudorandom byte source.
    const randomBytes = new Uint8Array(20);
    crypto.getRandomValues(randomBytes);
    let id = '';
    for (let i = 0; i < 20; i++) {
      id += chars.charAt(randomBytes[i] % chars.length);
    }
    return id;
  }
}
