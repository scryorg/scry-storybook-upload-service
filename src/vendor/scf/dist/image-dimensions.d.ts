/**
 * Reads pixel width/height straight from an image's header — never decodes pixels — so the
 * validator can enforce the spec's "at most 16384 px on the longest side" without pulling in an
 * image-decoding dependency (which would also break "zero runtime deps"). A tiny file can still
 * declare an enormous canvas (PNG/JPEG/WebP all compress a large solid-colour image well under the
 * 20 MB byte cap), which is a resource-exhaustion risk for whatever decodes it later (thumbnailing,
 * pixel diff) — see ledger F25.
 *
 * Returns null when the format can't be determined (truncated/corrupt file, or a WebP variant this
 * parser doesn't recognise) rather than guessing; callers should not error on null, only on a
 * confirmed over-limit size.
 */
export interface ImageDimensions {
    width: number;
    height: number;
}
/** Best-effort header-only dimension read for the three formats SCF allows. */
export declare function readImageDimensions(bytes: Uint8Array, family: 'png' | 'jpeg' | 'webp'): ImageDimensions | null;
//# sourceMappingURL=image-dimensions.d.ts.map