import { bundleFileHead } from './types.js';
/**
 * Builds capture objects for "sidecar mode": one entry per image path, with an optional
 * `<stem>.json` sidecar merged in. Shared by the native `"captures": "sidecars"` expansion in
 * validate.ts and the standalone `fromSidecars()` converter for Sentry-style folders.
 */
export function sidecarCapturesFromImages(files, imagePaths) {
    const captures = [];
    for (const imagePath of [...imagePaths].sort()) {
        const dot = imagePath.lastIndexOf('.');
        const stem = dot === -1 ? imagePath : imagePath.slice(0, dot);
        const sidecarBytes = bundleFileHead(files.get(`${stem}.json`));
        let sidecar = {};
        if (sidecarBytes) {
            try {
                sidecar = JSON.parse(new TextDecoder().decode(sidecarBytes));
            }
            catch {
                sidecar = {};
            }
        }
        captures.push({
            id: stem,
            image: imagePath,
            kind: 'component',
            ...sidecar,
        });
    }
    return captures;
}
//# sourceMappingURL=sidecars-internal.js.map