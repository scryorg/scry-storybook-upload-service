import type { ScfManifest } from './types.js';
/**
 * The R2 storage key for an SCF capture's image (contract §3):
 * `{projectId}/{buildId}/c/{sha256_hex(sourceKey + "\n" + id).slice(0,32)}.{ext}`.
 *
 * Ids are opaque and never sanitised: two ids that differ only in punctuation
 * (`Login/Default` vs `login-default`) hash to different keys.
 */
export declare function storageKey(projectId: string, buildId: string, sourceKey: string, id: string, ext: string): string;
/**
 * The companion key for a capture's structure tree (`{stem}.tree.json`) or source text
 * (`{stem}.src.txt`), sharing the same hash stem as its image (contract §3).
 */
export declare function companionKey(projectId: string, buildId: string, sourceKey: string, id: string, suffix: 'tree.json' | 'src.txt'): string;
/** `sourceKeyOf(manifest) = "<kind>:<platform|web>"` (contract §2). */
export declare function sourceKeyOf(manifest: Pick<ScfManifest, 'source'>): string;
//# sourceMappingURL=storage-key.d.ts.map