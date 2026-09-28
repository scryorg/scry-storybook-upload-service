import { sha256Hex } from './sha256.js';
const encoder = new TextEncoder();
/**
 * The R2 storage key for an SCF capture's image (contract §3):
 * `{projectId}/{buildId}/c/{sha256_hex(sourceKey + "\n" + id).slice(0,32)}.{ext}`.
 *
 * Ids are opaque and never sanitised: two ids that differ only in punctuation
 * (`Login/Default` vs `login-default`) hash to different keys.
 */
export function storageKey(projectId, buildId, sourceKey, id, ext) {
    const hash = sha256Hex(encoder.encode(`${sourceKey}\n${id}`)).slice(0, 32);
    const cleanExt = ext.replace(/^\.+/, '');
    return `${projectId}/${buildId}/c/${hash}.${cleanExt}`;
}
/**
 * The companion key for a capture's structure tree (`{stem}.tree.json`) or source text
 * (`{stem}.src.txt`), sharing the same hash stem as its image (contract §3).
 */
export function companionKey(projectId, buildId, sourceKey, id, suffix) {
    const hash = sha256Hex(encoder.encode(`${sourceKey}\n${id}`)).slice(0, 32);
    return `${projectId}/${buildId}/c/${hash}.${suffix}`;
}
/** `sourceKeyOf(manifest) = "<kind>:<platform|web>"` (contract §2). */
export function sourceKeyOf(manifest) {
    const platform = manifest.source.platform ?? 'web';
    return `${manifest.source.kind}:${platform}`;
}
//# sourceMappingURL=storage-key.js.map