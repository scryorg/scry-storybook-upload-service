/** Types for the Scry Capture Format (SCF) 1.0. See ../../../spec/scf-1.0.md. */
/** Normalizes a `BundleFiles` entry to bytes usable for magic-byte/header inspection: the full
 *  bytes for a plain entry, or just the head for a `{head, size}` image entry. Never the image's
 *  real full content when given a partial entry — use `bundleFileSize` for the true byte length. */
export function bundleFileHead(entry) {
    if (entry === undefined)
        return undefined;
    return entry instanceof Uint8Array ? entry : entry.head;
}
/** The entry's real total byte size: `byteLength` for a full entry, or the caller-reported `size`
 *  for a `{head, size}` image entry (its true size, not the head's length). */
export function bundleFileSize(entry) {
    if (entry === undefined)
        return undefined;
    return entry instanceof Uint8Array ? entry.byteLength : entry.size;
}
//# sourceMappingURL=types.js.map