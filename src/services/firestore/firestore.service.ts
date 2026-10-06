import type {
  Build,
  BuildCoverage,
  BuildProcessingStatus,
  BuildStatus,
  CreateBuildData,
  UpdateBuildData,
  Upload,
  CreateUploadData,
  OrphanBundleCandidate,
  Capture,
  CreateCaptureData,
} from './firestore.types.js';
import type { StepSummaryUpdate } from '../../lib/build-steps.js';

/**
 * Defines the contract for all Firestore operations within the application.
 * Any class implementing this interface can be used as the Firestore backend.
 */
export interface FirestoreService {
  /**
   * Creates a new build record with auto-incrementing build number
   * @param projectId The project identifier
   * @param data The build data including versionId and zipUrl
   * @returns A promise that resolves to the created Build record
   */
  /**
   * Record a product event (playbook §5.5). Optional so the Node implementation
   * is not forced to grow one; the deployed Worker provides it.
   */
  trackEvent?(name: string, props?: Record<string, string | number | boolean | undefined>): Promise<void>;

  /**
   * Bundle builds still awaiting their `/bundle/complete` call, created before `cutoff`, for the
   * orphan-bundle sweep (ledger F80, cost/coverage fix F91). ONE collection-group query across every
   * project, filtered on `bundlePending == true` (see `firestore.worker.ts` for the full field
   * lifecycle) — replaces the original `listProjectIds` + per-project scan, which cost reads
   * proportional to project count and total build history rather than the orphan rate. Optional so
   * the Node implementation is not forced to grow one; only the deployed Worker runs the cron that
   * needs it (same reasoning as `trackEvent` above).
   */
  findOrphanBundleCandidates?(cutoff: Date, limit?: number): Promise<OrphanBundleCandidate[]>;

  /**
   * Fresh re-read of one candidate's `processingStatus` presence + `updateTime`, immediately before
   * the orphan sweep would mark it failed (ledger F92). `null` means the document no longer exists.
   * Optional for the same reason as `findOrphanBundleCandidates` above.
   */
  getBuildOrphanState?(
    projectId: string,
    buildId: string
  ): Promise<{ hasProcessingStatus: boolean; updateTime: string } | null>;

  /**
   * Mark a bundle build's upload as never completed (ledger F80), guarded by the `updateTime`
   * `getBuildOrphanState` returned (ledger F92) — a Firestore `currentDocument.updateTime`
   * precondition that makes the write atomic with that read. `'precondition-failed'` means the
   * document changed since (a genuine, concurrent `/bundle/complete` most likely); the caller must
   * treat that as skipped, never retry it with the same fields. Optional for the same reason as
   * `findOrphanBundleCandidates` above.
   */
  markBuildFailedIfUnchanged?(
    projectId: string,
    buildId: string,
    processingError: string,
    expectedUpdateTime: string
  ): Promise<'marked' | 'precondition-failed'>;

  createBuild(
    projectId: string,
    data: CreateBuildData
  ): Promise<Build>;

  /**
   * Retrieves a build by its ID
   * @param projectId The project identifier
   * @param buildId The build identifier
   * @returns A promise that resolves to the Build record or null if not found
   */
  getBuild(
    projectId: string,
    buildId: string
  ): Promise<Build | null>;

  /**
   * Gets all builds for a project with optional filtering
   * @param projectId The project identifier
   * @param statusFilter Optional status filter ('active' or 'archived')
   * @param limitCount Optional limit on number of results (default: 50)
   * @returns A promise that resolves to an array of Build records
   */
  getProjectBuilds(
    projectId: string,
    statusFilter?: BuildStatus,
    limitCount?: number
  ): Promise<Build[]>;

  /**
   * Finds a build by its version ID
   * @param projectId The project identifier
   * @param versionId The version identifier
   * @returns A promise that resolves to the Build record or null if not found
   */
  getBuildByVersion(
    projectId: string,
    versionId: string
  ): Promise<Build | null>;

  /**
   * Gets the latest active build for a project
   * @param projectId The project identifier
   * @returns A promise that resolves to the latest Build record or null if none found
   */
  getLatestBuild(
    projectId: string,
    versionId?: string
  ): Promise<Build | null>;

  /**
   * Updates a build record
   * @param projectId The project identifier
   * @param buildId The build identifier
   * @param updates The fields to update
   * @returns A promise that resolves when the update is complete
   */
  updateBuild(
    projectId: string,
    buildId: string,
    updates: UpdateBuildData
  ): Promise<void>;

  /**
   * Archives a build
   * @param projectId The project identifier
   * @param buildId The build identifier
   * @param userId The user ID performing the archive operation
   * @returns A promise that resolves when the archive is complete
   */
  archiveBuild(
    projectId: string,
    buildId: string,
    userId: string
  ): Promise<void>;

  /**
   * Updates coverage data for a build.
   *
   * This should store the normalized coverage object on the build document.
   * The raw JSON payload is expected to be stored separately in object storage.
   *
   * @param projectId The project identifier
   * @param buildId The build identifier
   * @param coverage The coverage data to add
   * @returns A promise that resolves when the update is complete
   */
  updateBuildCoverage(
    projectId: string,
    buildId: string,
    coverage: BuildCoverage
  ): Promise<void>;

  /**
   * Updates the metadata processing state for a build.
   * @param projectId The project identifier
   * @param buildId The build identifier
   * @param status The processing status value
   */
  updateProcessingStatus?(
    projectId: string,
    buildId: string,
    status: BuildProcessingStatus,
    stepSummary?: StepSummaryUpdate
  ): Promise<void>;

  /**
   * Deletes a build record
   * @param projectId The project identifier
   * @param buildId The build identifier
   * @returns A promise that resolves when deletion is complete
   */
  deleteBuild(
    projectId: string,
    buildId: string
  ): Promise<void>;

  // ============= UPLOAD OPERATIONS =============

  /**
   * Creates a new upload record with auto-incrementing upload number
   */
  createUpload(
    projectId: string,
    data: CreateUploadData
  ): Promise<Upload>;

  /**
   * Retrieves an upload by its ID
   */
  getUpload(
    projectId: string,
    uploadId: string
  ): Promise<Upload | null>;

  /**
   * Gets all uploads for a project
   */
  getProjectUploads(
    projectId: string,
    limitCount?: number
  ): Promise<Upload[]>;

  /**
   * Updates the processing status of an upload
   */
  updateUploadProcessingStatus(
    projectId: string,
    uploadId: string,
    status: BuildProcessingStatus
  ): Promise<void>;

  /**
   * Deletes an upload record
   */
  deleteUpload(
    projectId: string,
    uploadId: string
  ): Promise<void>;

  // ============= SNIP CAPTURES (feature snip-capture) =============

  /**
   * Creates `projects/{p}/captures/{captureId}` as `pending` only if it does not exist yet.
   * `created: false` returns the document that is already there (a retried presign), never a second
   * one and never an overwrite.
   */
  createCaptureIfAbsent(
    projectId: string,
    data: CreateCaptureData
  ): Promise<{ capture: Capture; created: boolean }>;

  /** One capture, or null. */
  getCapture(projectId: string, captureId: string): Promise<Capture | null>;

  /**
   * Marks a capture `ready` and stamps `receivedAt` with the server's clock. Returns the updated capture,
   * or null when the document is gone (it is never recreated).
   */
  markCaptureReady(projectId: string, captureId: string): Promise<Capture | null>;

  /**
   * Atomically adds 1 to a counter document and returns the new count (`projects/{p}/captureLimits/{id}`).
   * `expireAt` rides on the document so a Firestore TTL policy on the field can remove old windows.
   */
  incrementCaptureCounter(projectId: string, counterId: string, expireAt: Date): Promise<number>;
}
