import type { BundleFiles, ScfCapture } from './types.js';
/**
 * Builds capture objects for "sidecar mode": one entry per image path, with an optional
 * `<stem>.json` sidecar merged in. Shared by the native `"captures": "sidecars"` expansion in
 * validate.ts and the standalone `fromSidecars()` converter for Sentry-style folders.
 */
export declare function sidecarCapturesFromImages(files: BundleFiles, imagePaths: string[]): ScfCapture[];
//# sourceMappingURL=sidecars-internal.d.ts.map