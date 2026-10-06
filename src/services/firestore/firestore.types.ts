import type { CiTimings } from '../../ci-timings/ci-timings.js';
import type { BuildStep, StepSummaryUpdate } from '../../lib/build-steps.js';

export type { CiTimings };

/**
 * Where a build's captures came from (capture-sources, contract §4). Absent means legacy
 * Storybook web (the sole source before this feature) — every reader treats "no source field" the
 * same as `{kind: 'storybook', platform: 'web'}` (G1).
 *
 * The upload service only ever writes `kind`/`platform` (from the CLI's `?source=<sourceKey>`
 * query param, parsed and validated before the bundle exists — see `src/bundle/source-key.ts`).
 * `framework`, `tool` and `device` are read from the bundle's manifest, which only build
 * processing sees (contract §4: "written by upload service at create, completed by processing").
 */
export interface BuildSource {
  kind: string;
  platform?: string;
  framework?: string;
  tool?: { name?: string; version?: string };
  device?: { name?: string; os?: string };
}

/** One validator problem, on the same shape `@scrymore/scf`'s `ValidationIssue` uses, so the CLI and
 *  the build document report identical messages for the same bundle (G7). */
export interface BuildValidationIssue {
  code: string;
  id?: string;
  path?: string;
  message: string;
}

/**
 * Represents the status of a build in the system
 */
export type BuildStatus = 'active' | 'archived';
export type BuildProcessingStatus = 'queued' | 'processing' | 'completed' | 'partial' | 'failed';

/**
 * Summary metrics extracted from a coverage report.
 *
 * This is the normalized, stable shape we store on Build documents.
 */
export interface CoverageSummary {
  componentCoverage: number;
  propCoverage: number;
  variantCoverage: number;
  passRate: number;
  totalComponents: number;
  componentsWithStories: number;
  failingStories: number;
}

/**
 * A single quality gate check.
 */
export interface QualityGateCheck {
  name: string;
  threshold: number;
  actual: number;
  passed: boolean;
}

/**
 * Quality gate evaluation result.
 */
export interface QualityGateResult {
  passed: boolean;
  checks: QualityGateCheck[];
}

/**
 * Normalized coverage data stored on a build.
 */
export interface BuildCoverage {
  /**
   * Public URL to the full raw coverage JSON stored in R2.
   */
  reportUrl: string;

  /**
   * Normalized summary extracted from the raw report.
   */
  summary: CoverageSummary;

  /**
   * Quality gate result.
   */
  qualityGate: QualityGateResult;

  /**
   * ISO timestamp when the report was generated.
   */
  generatedAt: string;

  /**
   * sbcov's own execution summary (storybook-preview-ci-runtime). Absent when
   * the report had none; members sbcov did not send are absent, never 0.
   */
  execution?: CoverageExecution;
}

export interface CoverageExecution {
  durationMs?: number;
  total?: number;
  passed?: number;
  failed?: number;
  notIndexed?: number;
}

/**
 * Records that the best-effort `commitSha`/`branch` provenance write on this
 * build failed, so a 100%-silent failure mode (upload-provenance-updatemask,
 * ISSUES.md #61) is visible on the one document a human or a future
 * healthcheck would already be looking at. `message` is truncated to 300
 * chars and never carries a token or Authorization header. Cleared (removed
 * from the document) the next time a provenance write for this build
 * succeeds.
 */
export interface BuildProvenanceError {
  /** ISO timestamp of the failed write. */
  at: string;
  /** Short, secret-free error message (already truncated to <=300 chars). */
  message: string;
  /** Which route's provenance write failed. */
  route: 'coverage' | 'metadata';
}

/**
 * Represents a build record in Firestore
 */
export interface Build {
  /**
   * Unique identifier for the build
   */
  id: string;

  /**
   * Project identifier
   */
  projectId: string;

  /**
   * Version identifier (can be semver, commit SHA, etc.)
   */
  versionId: string;

  /**
   * Auto-incrementing build number per project
   */
  buildNumber: number;

  /**
   * URL to the build artifact ZIP file
   */
  zipUrl: string;

  /**
   * Current status of the build
   */
  status: BuildStatus;

  /**
   * Timestamp when the build was created
   */
  createdAt: Date;

  /**
   * User ID who created/triggered the build
   */
  createdBy: string;

  /**
   * Full commit SHA the build was produced from, when the CLI could determine
   * one.
   *
   * `versionId` above is a PR number, a branch name, a tag or a short SHA
   * depending on which CI event fired, so it identifies a deploy and never a
   * commit. Search reports this as a result's `build_sha`; absent means absent,
   * and the result reports its freshness as unknown rather than guessing
   * (P13a).
   */
  commitSha?: string;

  /**
   * Branch the build was produced from, on the same terms as `commitSha`.
   */
  branch?: string;

  /**
   * Timestamp when the build was archived (if applicable)
   */
  archivedAt?: Date;

  /**
   * User ID who archived the build (if applicable)
   */
  archivedBy?: string;

  /**
   * Normalized coverage data for the build (if uploaded).
   */
  coverage?: BuildCoverage;

  /**
   * Async processing state for screenshot metadata ingestion.
   */
  processingStatus?: BuildProcessingStatus;

  /**
   * Firestore doc id of the API key that created the build, and the project
   * that key belongs to (upload-project-key-scope). Never the key value or a
   * hash of it. Absent when the service runs without API-key auth.
   */
  uploadedByKeyId?: string;
  uploadedByKeyProject?: string;

  /**
   * Set only for a build created through the dashboard's signed door (dashboard-import): the channel
   * marker next to `source`, and the Firebase uid the assertion named. Complete through that door
   * requires both to match; the uid is never logged. Absent on every API-key build.
   */
  channel?: 'dashboard';
  uploadedByUid?: string;

  /**
   * How much CI time the deploy took, as the deployer measured it
   * (storybook-preview-ci-runtime). Absent when the deployer sent none.
   */
  ciTimings?: CiTimings;

  /**
   * Where this build's captures came from (capture-sources). Absent = legacy Storybook web.
   */
  source?: BuildSource;

  /**
   * The vendored `@scrymore/scf` validator's errors for this build's bundle, when the bundle
   * upload route (`/upload/:project/:version/bundle/complete`) rejected it (G7). Set alongside
   * `processingStatus: 'failed'`; absent otherwise.
   */
  validationErrors?: BuildValidationIssue[];

  /**
   * Set when the best-effort `commitSha`/`branch` write most recently failed
   * for this build; absent otherwise (upload-provenance-updatemask).
   */
  provenanceError?: BuildProvenanceError;

  /**
   * Set alongside `processingStatus: 'failed'` to explain why a build never finished, on the same
   * terms as the field of this name already written by scry-build-processing-service: a short,
   * human-readable diagnostic, never a stack trace. The orphan-bundle sweep (`bundle/orphan-
   * sweep.ts`, ledger F80) is this service's first writer of it, for a bundle build whose
   * `/bundle/complete` call never arrived.
   */
  processingError?: string;
}

/**
 * One build document read while scanning for bundle uploads whose `/bundle/complete` call never
 * arrived (`bundle/orphan-sweep.ts`, ledger F80). Deliberately narrow — just enough to decide
 * whether a build is a candidate (old enough, a bundle build, not already resolved) and to compute
 * the R2 key its bundle ZIP would have landed at.
 */
export interface OrphanBundleCandidate {
  buildId: string;
  projectId: string;
  versionId: string;
  buildNumber: number;
  createdAt: Date;
  /** `source` is present (contract §4): a bundle build, never a legacy storybook.zip build (G1). */
  hasSource: boolean;
  /** Any processingStatus at all — queued, processing, completed, partial or failed — means
   *  `/bundle/complete` already ran and resolved this build; never true for a genuine orphan. */
  hasProcessingStatus: boolean;
}

/**
 * Data required to create a new build record
 */
export interface CreateBuildData {
  /**
   * Version identifier for the build
   */
  versionId: string;

  /**
   * URL to the uploaded ZIP file
   */
  zipUrl: string;

  /**
   * Optional normalized coverage data to store alongside build creation.
   */
  coverage?: BuildCoverage;

  /**
   * Commit SHA the build was produced from, when known (P13a). Omitted, never
   * empty — an empty commit on a build document is indistinguishable from a
   * real one to everything downstream.
   */
  commitSha?: string;

  /** Branch the build was produced from, when known (P13a). */
  branch?: string;

  /**
   * Firestore doc id of the API key that created the build, and the project
   * that key belongs to (upload-project-key-scope). Never the key value or a
   * hash of it. Absent when the service runs without API-key auth.
   */
  uploadedByKeyId?: string;
  uploadedByKeyProject?: string;

  /**
   * Set only for a build created through the dashboard's signed door (dashboard-import): the channel
   * marker next to `source`, and the Firebase uid the assertion named. Complete through that door
   * requires both to match; the uid is never logged. Absent on every API-key build.
   */
  channel?: 'dashboard';
  uploadedByUid?: string;

  /**
   * How much CI time the deploy took, as the deployer measured it
   * (storybook-preview-ci-runtime). Absent when the deployer sent none.
   */
  ciTimings?: CiTimings;

  /**
   * Where this build's captures came from (capture-sources). Absent = legacy Storybook web.
   */
  source?: BuildSource;

  /**
   * staff-builds-view: the request that created the build (stored as `requestId`) and the first
   * pipeline step it took. Together they seed `stepSummary` {firstStepAt, lastStep, lastStepAt,
   * outcome, requestId} inside the same create write. Both omitted = no summary is written.
   */
  requestId?: string;
  firstStep?: BuildStep;
}

// ============= UPLOAD TYPES =============

export type UploadStatus = 'active' | 'archived';

export interface Upload {
  id: string;
  projectId: string;
  uploadNumber: number;
  imageCount: number;
  zipUrl: string;
  status: UploadStatus;
  processingStatus?: BuildProcessingStatus;
  createdAt: Date;
  createdBy: string;
}

export interface CreateUploadData {
  imageCount: number;
  zipUrl: string;
}

// ============= BUILD UPDATE TYPES =============

/**
 * Data that can be updated in a build record
 */
export interface UpdateBuildData {
  /**
   * New status for the build
   */
  status?: BuildStatus;

  /**
   * New ZIP URL (in case of re-upload)
   */
  zipUrl?: string;

  /**
   * Archive timestamp
   */
  archivedAt?: Date;

  /**
   * User who archived the build
   */
  archivedBy?: string;

  /**
   * Normalized coverage data for the build (if uploaded).
   */
  coverage?: BuildCoverage;

  /**
   * Async processing state for screenshot metadata ingestion.
   */
  processingStatus?: BuildProcessingStatus;

  /**
   * Commit SHA the build was produced from (P13a).
   *
   * Updatable rather than only settable at creation because the commit arrives
   * on whichever of the coverage upload and the metadata upload runs, and the
   * build document is created before either.
   */
  commitSha?: string;

  /** Branch the build was produced from (P13a). */
  branch?: string;

  /**
   * How much CI time the deploy took, as the deployer measured it
   * (storybook-preview-ci-runtime). Absent when the deployer sent none.
   */
  ciTimings?: CiTimings;

  /**
   * The vendored `@scrymore/scf` validator's errors for this build's bundle
   * (`/upload/:project/:version/bundle/complete`, G7). Set alongside
   * `processingStatus: 'failed'` when the bundle is rejected.
   */
  validationErrors?: BuildValidationIssue[];

  /**
   * Set this to record that the best-effort provenance write failed, or set
   * it explicitly to `null` to clear a previously-recorded one (the field is
   * removed from the document, not stored as null) once a later write
   * succeeds. Omitted entirely: this call does not touch the field either way.
   */
  provenanceError?: BuildProvenanceError | null;

  /** See `Build.processingError`. Set alongside `processingStatus: 'failed'`. */
  processingError?: string;

  /**
   * staff-builds-view: moves `stepSummary.lastStep/lastStepAt/outcome` inside this same write
   * (nested mask paths, so `firstStepAt` and `requestId` are never touched). No extra Firestore write.
   */
  stepSummary?: StepSummaryUpdate;
}

// ============= SNIP CAPTURES (feature snip-capture) =============

/** Lifecycle of a capture document: `pending` after presign, `ready` once `complete` verified the objects. */
export type CaptureStatus = 'pending' | 'ready';
export type CaptureOs = 'mac' | 'win';
export type CaptureMode = 'region' | 'window' | 'screen';
export type CaptureSendMode = 'review' | 'auto';

/**
 * `projects/{p}/captures/{captureId}`. A capture is NOT a build (guarantee G3): no build row, no
 * story, no Milvus entry. `appName` is never written by this service (the person's opt-in is a
 * later slice); `note` is stored and never logged (G6).
 */
export interface Capture {
  captureId: string;
  /** Owner of the device key that presigned it. Powers "my latest" and the owner-only rules. */
  capturedByUid: string;
  /** The key document id (never the key or its hash). */
  deviceId: string;
  status: CaptureStatus;
  width: number;
  height: number;
  bytes: number;
  /** Declared size of the preview / agent renditions (signed into their PUT URLs). Absent on documents written before the signed-length change. */
  previewBytes?: number;
  agentBytes?: number;
  sha256: string;
  scale: number;
  os: CaptureOs;
  mode: CaptureMode;
  sendMode: CaptureSendMode;
  note?: string;
  sharedWith: string[];
  sharedWithOrgIds: string[];
  sharedWithProject: boolean;
  /** Server time the pending doc was created. */
  createdAt: Date;
  /** Server time `complete` verified the objects; used for "latest". Absent while pending. */
  receivedAt?: Date;
  /** createdAt + 30 days. */
  expiresAt: Date;
}

/** What presign supplies; the service adds status, sharing defaults and the timestamps. */
export type CreateCaptureData = Pick<
  Capture,
  'captureId' | 'capturedByUid' | 'deviceId' | 'width' | 'height' | 'bytes' | 'sha256' | 'scale' | 'os' | 'mode' | 'sendMode'
> & { previewBytes: number; agentBytes: number; note?: string; expiresAt: Date };
