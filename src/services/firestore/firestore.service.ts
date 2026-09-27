import type {
  Build,
  BuildCoverage,
  BuildProcessingStatus,
  BuildStatus,
  CreateBuildData,
  UpdateBuildData,
  Upload,
  CreateUploadData,
} from './firestore.types.js';

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
    status: BuildProcessingStatus
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
}
