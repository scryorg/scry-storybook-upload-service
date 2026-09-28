import type { BundleFiles, ScfManifest } from './types.js';
/**
 * Converts a folder of `<name>.png` + optional `<name>.json` sidecars (Sentry-style snapshot
 * folders, or any "one JSON per image" layout) into an SCF 1.0 manifest. Images may live at any
 * path; each becomes `id = path without extension` unless its sidecar sets one explicitly.
 */
export declare function fromSidecars(files: BundleFiles, sourceKind?: string): ScfManifest;
//# sourceMappingURL=from-sidecars.d.ts.map