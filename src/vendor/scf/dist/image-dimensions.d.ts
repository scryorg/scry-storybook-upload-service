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
export type ImageFamily = 'png' | 'jpeg' | 'webp';
/** Sniffs the magic bytes to tell which of the three SCF-allowed image formats `bytes` is, so a
 *  `.png` with the wrong content (or vice versa) is still caught. Moved here (from `validate.ts`)
 *  so `measureImage` below can use it without a circular import; re-exported from `validate.ts` for
 *  callers that only need family detection (e.g. a `{head, size}` image entry's magic-byte check). */
export declare function detectImageFamily(bytes: Uint8Array): ImageFamily | null;
export interface MeasuredImage extends ImageDimensions {
    family: ImageFamily;
}
/**
 * The recommended cap on how large a `prefixBytes` a streaming caller should ever accumulate before
 * giving up on `measureImage` and treating the image as unmeasurable (ledger F69). PNG's IHDR is
 * always in the first 24 bytes and WebP's header in the first ~30, so this bound is really about
 * JPEG: a real photo's SOF0/SOF2 marker is essentially always within a few KiB, but a JPEG can
 * legally carry a large APPn/EXIF segment (an embedded thumbnail, ICC profile, XMP block) before its
 * first SOF marker. 64 KiB comfortably covers realistic EXIF payloads while keeping the *transient*
 * per-image buffer a streaming caller holds — never the persisted record — small and bounded.
 */
export declare const MEASURE_IMAGE_MAX_PREFIX_BYTES: number;
/**
 * Combines magic-byte family detection with a header-only dimension read into the one call a
 * memory-bounded streaming reader needs (ledger F69: F32/F60's fixes still left the IMAGE member
 * category exposed to the same "keep it all in memory" problem — an 8,000-entry bundle of honest,
 * individually-tiny images could still retain ~500 MB via the old `{head, size}` shape, since a
 * `{head, size}` entry whose real size is under the head cap retains the WHOLE image). A caller
 * streaming a large bundle should feed this whatever *prefix* of an image's real decompressed bytes
 * it has accumulated so far (never the whole file) — this function is a pure, stateless read of
 * whatever prefix you hand it, so calling it again as more bytes arrive (up to
 * `MEASURE_IMAGE_MAX_PREFIX_BYTES`, or once the entry finishes if it's smaller than that) is always
 * safe and cheap; there is no separate "streaming" API to construct or tear down.
 *
 * Once this returns a non-null result (or the caller has accumulated `MEASURE_IMAGE_MAX_PREFIX_BYTES`
 * and it's still null), the caller should discard the prefix buffer entirely and retain only the
 * small `{family, width, height}` record plus the image's real total size — never the bytes
 * themselves. That's the whole point: peak memory per image, beyond that small fixed record, is
 * bounded by this function's own bounded input, not by how many images (or how large any one of
 * them) the bundle contains.
 *
 * Returns null when the family can't be identified from the bytes present, OR when the family is
 * known but the dimensions can't be read from this prefix (truncated/corrupt content, a WebP variant
 * this parser doesn't cover, or — for JPEG — a real SOF marker that never showed up within the
 * prefix a caller was willing to buffer). Both failure modes collapse to the same `null` on purpose:
 * a caller holding only a bounded prefix has no bytes left over to tell "not a valid image" apart
 * from "couldn't read far enough into a valid one" once that prefix is discarded, and a `{measured}`
 * record built from a `null` result is rejected the same way either way (see `validate.ts`'s
 * `IMAGE_FORMAT_INVALID` handling for a `{measured}` entry).
 */
export declare function measureImage(prefixBytes: Uint8Array): MeasuredImage | null;
//# sourceMappingURL=image-dimensions.d.ts.map