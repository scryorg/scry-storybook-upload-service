/**
 * @scrymore/scf — the Scry Capture Format 1.0 validator and converters.
 * Zero runtime dependencies; safe to vendor into a Worker or a Node service (see repo README).
 */
export { validateBundle, checkStructureMember, checkSourceTextMember } from './validate.js';
export { fromSbcov, toStorybookId } from './from-sbcov.js';
export { fromSidecars } from './from-sidecars.js';
export { storageKey, companionKey, sourceKeyOf } from './storage-key.js';
export { sha256Hex } from './sha256.js';
export { bundleFileFull, bundleFileHead, bundleFileSize, isCheckedBundleFile, isMeasuredBundleFile } from './types.js';
export { detectImageFamily, measureImage, readImageDimensions, MEASURE_IMAGE_MAX_PREFIX_BYTES } from './image-dimensions.js';
export type { ImageFamily, MeasuredImage } from './image-dimensions.js';
export type { BundleFileBytes, BundleFileChecked, BundleFileHeadAndSize, BundleFileMeasured, BundleFiles, CaptureBlock, CaptureCode, CaptureCrop, CaptureFlow, CaptureKind, CaptureLinks, CaptureMethod, CaptureSourceText, CaptureStructure, CaptureVariant, DeviceRef, ScfCapture, ScfCounts, ScfManifest, ScfRepository, ScfSource, ScfTree, ScfTreeNode, Severity, SkipReason, StructureOrigin, ValidationIssue, ValidationResult, } from './types.js';
//# sourceMappingURL=index.d.ts.map