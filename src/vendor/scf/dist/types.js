/** Types for the Scry Capture Format (SCF) 1.0. See ../../../spec/scf-1.0.md. */
/** True for a `{checked: true, size}` entry (ledger F60) — never for a plain `Uint8Array`, a
 *  `{head, size}` image entry, or a `{measured, ...}` image entry. */
export function isCheckedBundleFile(entry) {
    return entry !== undefined && !(entry instanceof Uint8Array) && 'checked' in entry && entry.checked === true;
}
/** True for a `{measured: true, family, width, height, size}` entry (ledger F69) — never for a
 *  plain `Uint8Array`, a `{head, size}` image entry, or a `{checked, size}` entry. */
export function isMeasuredBundleFile(entry) {
    return entry !== undefined && !(entry instanceof Uint8Array) && 'measured' in entry && entry.measured === true;
}
/** Normalizes a `BundleFiles` entry to bytes usable for magic-byte/header inspection: the full
 *  bytes for a plain entry, or just the head for a `{head, size}` image entry. `undefined` for a
 *  `{checked, size}` or `{measured, ...}` entry (no bytes were ever retained for either) — never the
 *  image's real full content when given a partial entry; use `bundleFileSize` for the true byte
 *  length. */
export function bundleFileHead(entry) {
    if (entry === undefined)
        return undefined;
    if (entry instanceof Uint8Array)
        return entry;
    return 'head' in entry ? entry.head : undefined;
}
/** The entry's full bytes, or `undefined` for a `{head, size}`, `{checked, size}` or `{measured,
 *  ...}` entry. Every non-image member (JSON, structure trees, source text) is read through this, so
 *  a partial entry can never be validated from its head alone (security review F50). */
export function bundleFileFull(entry) {
    return entry instanceof Uint8Array ? entry : undefined;
}
/** The entry's real total byte size: `byteLength` for a full entry, or the caller-reported `size`
 *  for a `{head, size}`, `{checked, size}` or `{measured, ...}` entry (its true size, never a
 *  head/partial length). */
export function bundleFileSize(entry) {
    if (entry === undefined)
        return undefined;
    return entry instanceof Uint8Array ? entry.byteLength : entry.size;
}
//# sourceMappingURL=types.js.map