import admin from 'firebase-admin';
import type { Firestore, DocumentData } from 'firebase-admin/firestore';
import type { FirestoreService } from './firestore.service.js';
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
import type { StepSummaryUpdate } from '../../lib/build-steps.js';

/** staff-builds-view: dotted paths so `firstStepAt` and `requestId` inside `stepSummary` are never overwritten. */
function nodeStepSummary(s: StepSummaryUpdate | undefined): Record<string, unknown> {
  if (!s) return {};
  return {
    'stepSummary.lastStep': s.lastStep,
    'stepSummary.lastStepAt': s.at ?? new Date(),
    'stepSummary.outcome': s.outcome,
  };
}

/** staff-builds-view: requestId and the first step of `stepSummary`, written in the create write itself. */
function nodeStepSummarySeed(data: CreateBuildData): Record<string, unknown> {
  const requestId = data.requestId ? { requestId: data.requestId } : {};
  if (!data.firstStep) return requestId;
  return {
    ...requestId,
    stepSummary: {
      firstStepAt: admin.firestore.FieldValue.serverTimestamp(),
      lastStep: data.firstStep,
      lastStepAt: admin.firestore.FieldValue.serverTimestamp(),
      outcome: 'ok',
      ...requestId,
    },
  };
}

/**
 * Node.js implementation of FirestoreService using Firebase Admin SDK
 */
export class FirestoreServiceNode implements FirestoreService {
  private db: Firestore;
  private serviceAccountId: string;

  constructor(serviceAccountId: string = 'upload-service') {
    this.db = admin.firestore();
    this.serviceAccountId = serviceAccountId;
  }

  /**
   * Creates a new build record with auto-incrementing build number
   * Uses Firestore transaction to ensure atomicity
   */
  async createBuild(
    projectId: string,
    data: CreateBuildData
  ): Promise<Build> {
    return this.db.runTransaction(async (transaction) => {
      // Reference to counter document
      const counterRef = this.db.doc(`projects/${projectId}/counters/builds`);
      const counterSnap = await transaction.get(counterRef);

      // Initialize counter if it doesn't exist
      let buildNumber = 1;
      if (!counterSnap.exists) {
        transaction.set(counterRef, { currentBuildNumber: 1 });
      } else {
        buildNumber = counterSnap.data()!.currentBuildNumber + 1;
        transaction.update(counterRef, {
          currentBuildNumber: admin.firestore.FieldValue.increment(1)
        });
      }

      // Create build document
      const buildRef = this.db.collection(`projects/${projectId}/builds`).doc();
      const buildData = {
        projectId,
        versionId: data.versionId,
        buildNumber,
        zipUrl: data.zipUrl,
        status: 'active' as const,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        createdBy: this.serviceAccountId,
        ...(data.coverage ? { coverage: data.coverage } : {}),
        // Build provenance (P13a); see CreateBuildData.
        ...(data.commitSha ? { commitSha: data.commitSha } : {}),
        ...(data.branch ? { branch: data.branch } : {}),
        ...(data.uploadedByKeyId ? { uploadedByKeyId: data.uploadedByKeyId } : {}),
        ...(data.uploadedByKeyProject ? { uploadedByKeyProject: data.uploadedByKeyProject } : {}),
        ...(data.channel ? { channel: data.channel } : {}),
        ...(data.uploadedByUid ? { uploadedByUid: data.uploadedByUid } : {}),
        // CI timings (storybook-preview-ci-runtime); absent when not sent.
        ...(data.ciTimings ? { ciTimings: data.ciTimings } : {}),
        // Where this build's captures came from (capture-sources); absent = legacy Storybook web.
        ...(data.source ? { source: data.source } : {}),
        // staff-builds-view: the creating request and the first step, in the create write itself.
        ...nodeStepSummarySeed(data),
      };

      transaction.set(buildRef, buildData);

      // Return the created build (with current timestamp estimate)
      return {
        id: buildRef.id,
        projectId,
        ...(data.commitSha ? { commitSha: data.commitSha } : {}),
        ...(data.branch ? { branch: data.branch } : {}),
        versionId: data.versionId,
        buildNumber,
        zipUrl: data.zipUrl,
        status: 'active' as const,
        createdAt: new Date(),
        createdBy: this.serviceAccountId,
        coverage: data.coverage,
        ...(data.ciTimings ? { ciTimings: data.ciTimings } : {}),
        ...(data.source ? { source: data.source } : {}),
      };
    });
  }

  /**
   * Retrieves a build by its ID
   */
  async getBuild(
    projectId: string,
    buildId: string
  ): Promise<Build | null> {
    const buildRef = this.db.doc(`projects/${projectId}/builds/${buildId}`);
    const buildSnap = await buildRef.get();

    if (!buildSnap.exists) {
      return null;
    }

    return this.convertDocToBuild(buildSnap.id, buildSnap.data()!);
  }

  /**
   * Gets all builds for a project with optional filtering
   */
  async getProjectBuilds(
    projectId: string,
    statusFilter?: BuildStatus,
    limitCount: number = 50
  ): Promise<Build[]> {
    let query = this.db.collection(`projects/${projectId}/builds`)
      .orderBy('buildNumber', 'desc')
      .limit(limitCount);

    if (statusFilter) {
      query = this.db.collection(`projects/${projectId}/builds`)
        .where('status', '==', statusFilter)
        .orderBy('createdAt', 'desc')
        .limit(limitCount);
    }

    const snapshot = await query.get();
    return snapshot.docs.map(doc => this.convertDocToBuild(doc.id, doc.data()));
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
    const snapshot = await this.db
      .collection(`projects/${projectId}/builds`)
      .where('versionId', '==', versionId)
      .get();

    if (snapshot.empty) {
      return null;
    }

    // Choose the latest build by buildNumber
    let bestDoc = snapshot.docs[0];
    for (const doc of snapshot.docs) {
      const current = doc.data();
      const best = bestDoc.data();
      if ((current?.buildNumber ?? 0) > (best?.buildNumber ?? 0)) {
        bestDoc = doc;
      }
    }

    return this.convertDocToBuild(bestDoc.id, bestDoc.data());
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

    const snapshot = await this.db.collection(`projects/${projectId}/builds`)
      .where('status', '==', 'active')
      .orderBy('buildNumber', 'desc')
      .limit(1)
      .get();

    if (snapshot.empty) {
      return null;
    }

    const doc = snapshot.docs[0];
    return this.convertDocToBuild(doc.id, doc.data());
  }

  /**
   * Updates a build record
   */
  async updateBuild(
    projectId: string,
    buildId: string,
    updates: UpdateBuildData
  ): Promise<void> {
    const buildRef = this.db.doc(`projects/${projectId}/builds/${buildId}`);
    // `provenanceError: null` means "clear it" (upload-provenance-updatemask D2); the Admin SDK
    // writes a literal null for a plain `null` value, so it needs FieldValue.delete() to actually
    // remove the field the way the Worker implementation's mask-without-body trick does.
    const { stepSummary, ...rest } = updates;
    const payload: Record<string, unknown> = { ...rest, ...nodeStepSummary(stepSummary) };
    if (updates.provenanceError === null) {
      payload.provenanceError = admin.firestore.FieldValue.delete();
    }
    await buildRef.update(payload);
  }

  /**
   * Updates coverage data for a build
   */
  async updateBuildCoverage(
    projectId: string,
    buildId: string,
    coverage: BuildCoverage
  ): Promise<void> {
    const buildRef = this.db.doc(`projects/${projectId}/builds/${buildId}`);
    await buildRef.update({ coverage });
  }

  /**
   * Updates metadata processing status for a build.
   */
  async updateProcessingStatus(
    projectId: string,
    buildId: string,
    status: BuildProcessingStatus,
    stepSummary?: StepSummaryUpdate
  ): Promise<void> {
    const buildRef = this.db.doc(`projects/${projectId}/builds/${buildId}`);
    await buildRef.update({ processingStatus: status, ...nodeStepSummary(stepSummary) });
  }

  /**
   * Archives a build
   */
  async archiveBuild(
    projectId: string,
    buildId: string,
    userId: string
  ): Promise<void> {
    const buildRef = this.db.doc(`projects/${projectId}/builds/${buildId}`);
    await buildRef.update({
      status: 'archived',
      archivedAt: admin.firestore.FieldValue.serverTimestamp(),
      archivedBy: userId,
    });
  }

  /**
   * Deletes a build record
   */
  async deleteBuild(
    projectId: string,
    buildId: string
  ): Promise<void> {
    const buildRef = this.db.doc(`projects/${projectId}/builds/${buildId}`);
    await buildRef.delete();
  }

  // ============= UPLOAD OPERATIONS =============

  async createUpload(
    projectId: string,
    data: CreateUploadData
  ): Promise<Upload> {
    return this.db.runTransaction(async (transaction) => {
      const counterRef = this.db.doc(`projects/${projectId}/counters/uploads`);
      const counterSnap = await transaction.get(counterRef);

      let uploadNumber = 1;
      if (!counterSnap.exists) {
        transaction.set(counterRef, { currentUploadNumber: 1 });
      } else {
        uploadNumber = counterSnap.data()!.currentUploadNumber + 1;
        transaction.update(counterRef, {
          currentUploadNumber: admin.firestore.FieldValue.increment(1),
        });
      }

      const uploadRef = this.db.collection(`projects/${projectId}/uploads`).doc();
      const uploadData = {
        projectId,
        uploadNumber,
        imageCount: data.imageCount,
        zipUrl: data.zipUrl,
        status: 'active' as const,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        createdBy: this.serviceAccountId,
      };

      transaction.set(uploadRef, uploadData);

      return {
        id: uploadRef.id,
        projectId,
        uploadNumber,
        imageCount: data.imageCount,
        zipUrl: data.zipUrl,
        status: 'active' as const,
        createdAt: new Date(),
        createdBy: this.serviceAccountId,
      };
    });
  }

  async getUpload(
    projectId: string,
    uploadId: string
  ): Promise<Upload | null> {
    const ref = this.db.doc(`projects/${projectId}/uploads/${uploadId}`);
    const snap = await ref.get();

    if (!snap.exists) return null;
    return this.convertDocToUpload(snap.id, snap.data()!);
  }

  async getProjectUploads(
    projectId: string,
    limitCount: number = 50
  ): Promise<Upload[]> {
    const snapshot = await this.db.collection(`projects/${projectId}/uploads`)
      .orderBy('uploadNumber', 'desc')
      .limit(limitCount)
      .get();

    return snapshot.docs.map(doc => this.convertDocToUpload(doc.id, doc.data()));
  }

  async updateUploadProcessingStatus(
    projectId: string,
    uploadId: string,
    status: BuildProcessingStatus
  ): Promise<void> {
    const ref = this.db.doc(`projects/${projectId}/uploads/${uploadId}`);
    await ref.update({ processingStatus: status });
  }

  async deleteUpload(
    projectId: string,
    uploadId: string
  ): Promise<void> {
    const ref = this.db.doc(`projects/${projectId}/uploads/${uploadId}`);
    await ref.delete();
  }

  private convertDocToUpload(id: string, data: DocumentData): Upload {
    return {
      id,
      projectId: data.projectId,
      uploadNumber: data.uploadNumber,
      imageCount: data.imageCount,
      zipUrl: data.zipUrl,
      status: data.status,
      processingStatus: data.processingStatus,
      createdAt: data.createdAt?.toDate?.() || new Date(),
      createdBy: data.createdBy,
    };
  }

  /**
   * Helper method to convert Firestore document to Build object
   */
  private convertDocToBuild(id: string, data: DocumentData): Build {
    return {
      id,
      projectId: data.projectId,
      versionId: data.versionId,
      buildNumber: data.buildNumber,
      zipUrl: data.zipUrl,
      status: data.status,
      createdAt: data.createdAt?.toDate?.() || new Date(),
      createdBy: data.createdBy,
      archivedAt: data.archivedAt?.toDate?.(),
      archivedBy: data.archivedBy,
      coverage: data.coverage,
      processingStatus: data.processingStatus,
      // Same sibling gap as firestore.worker.ts: #25 wrote commitSha/branch but never read them
      // back here (upload-provenance-updatemask, ISSUES.md #61).
      ...(data.commitSha ? { commitSha: data.commitSha } : {}),
      ...(data.branch ? { branch: data.branch } : {}),
      ...(data.provenanceError ? { provenanceError: data.provenanceError } : {}),
      ...(data.uploadedByKeyId ? { uploadedByKeyId: data.uploadedByKeyId } : {}),
      ...(data.uploadedByKeyProject ? { uploadedByKeyProject: data.uploadedByKeyProject } : {}),
      ...(data.channel === 'dashboard' ? { channel: data.channel } : {}),
      ...(data.uploadedByUid ? { uploadedByUid: data.uploadedByUid } : {}),
      ...(data.ciTimings ? { ciTimings: data.ciTimings } : {}),
      ...(data.source ? { source: data.source } : {}),
      ...(data.validationErrors ? { validationErrors: data.validationErrors } : {}),
    };
  }
}
