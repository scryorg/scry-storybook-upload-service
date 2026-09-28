import { sidecarCapturesFromImages } from './sidecars-internal.js';
const ALLOWED_IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp']);
function extOf(path) {
    const m = /\.([a-zA-Z0-9]+)$/.exec(path);
    return m ? m[1].toLowerCase() : '';
}
/**
 * Converts a folder of `<name>.png` + optional `<name>.json` sidecars (Sentry-style snapshot
 * folders, or any "one JSON per image" layout) into an SCF 1.0 manifest. Images may live at any
 * path; each becomes `id = path without extension` unless its sidecar sets one explicitly.
 */
export function fromSidecars(files, sourceKind = 'upload') {
    const imagePaths = [...files.keys()].filter((p) => ALLOWED_IMAGE_EXT.has(extOf(p)));
    const captures = sidecarCapturesFromImages(files, imagePaths);
    return {
        scf: '1.0',
        source: { kind: sourceKind },
        counts: { declared: captures.length, captured: captures.length, skipped: [] },
        captures,
    };
}
//# sourceMappingURL=from-sidecars.js.map