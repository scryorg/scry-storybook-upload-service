import type { CiTimings } from '../../ci-timings/ci-timings.js';

export type { CiTimings };

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
   * How much CI time the deploy took, as the deployer measured it
   * (storybook-preview-ci-runtime). Absent when the deployer sent none.
   */
  ciTimings?: CiTimings;

  /**
   * Set when the best-effort `commitSha`/`branch` write most recently failed
   * for this build; absent otherwise (upload-provenance-updatemask).
   */
  provenanceError?: BuildProvenanceError;
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
   * How much CI time the deploy took, as the deployer measured it
   * (storybook-preview-ci-runtime). Absent when the deployer sent none.
   */
  ciTimings?: CiTimings;
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
   * Set this to record that the best-effort provenance write failed, or set
   * it explicitly to `null` to clear a previously-recorded one (the field is
   * removed from the document, not stored as null) once a later write
   * succeeds. Omitted entirely: this call does not touch the field either way.
   */
  provenanceError?: BuildProvenanceError | null;
}
