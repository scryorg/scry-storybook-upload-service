function pngDimensions(bytes) {
    // Signature (8) + chunk length (4) + "IHDR" (4) + width (4) + height (4) = 24 bytes minimum.
    if (bytes.length < 24)
        return null;
    if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52)
        return null; // "IHDR"
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}
const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const JPEG_NO_PAYLOAD_MARKERS = new Set([0x01, 0xd8, 0xd9, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);
function jpegDimensions(bytes) {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
        return null; // SOI
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 2;
    while (offset + 4 <= bytes.length) {
        if (bytes[offset] !== 0xff) {
            offset++; // resync on stray fill bytes (0xFF 0xFF ...), rare but legal
            continue;
        }
        const marker = bytes[offset + 1];
        if (marker === 0xd9)
            return null; // EOI reached with no SOF: not a valid JPEG we can size
        if (JPEG_NO_PAYLOAD_MARKERS.has(marker)) {
            offset += 2;
            continue;
        }
        const segmentLength = view.getUint16(offset + 2, false); // includes these 2 length bytes
        if (JPEG_SOF_MARKERS.has(marker)) {
            if (offset + 9 > bytes.length)
                return null;
            const height = view.getUint16(offset + 5, false);
            const width = view.getUint16(offset + 7, false);
            return { width, height };
        }
        offset += 2 + segmentLength;
    }
    return null;
}
function riffChunkFourCC(bytes, offset) {
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}
function webpDimensions(bytes) {
    if (bytes.length < 30)
        return null;
    if (riffChunkFourCC(bytes, 0) !== 'RIFF' || riffChunkFourCC(bytes, 8) !== 'WEBP')
        return null;
    const chunkType = riffChunkFourCC(bytes, 12);
    const data = bytes.subarray(20);
    if (chunkType === 'VP8X' && data.length >= 10) {
        // Extended header: flags(1) + reserved(3) + canvasWidthMinusOne(3, LE) + canvasHeightMinusOne(3, LE).
        const width = (data[4] | (data[5] << 8) | (data[6] << 16)) + 1;
        const height = (data[7] | (data[8] << 8) | (data[9] << 16)) + 1;
        return { width, height };
    }
    if (chunkType === 'VP8L' && data.length >= 5) {
        if (data[0] !== 0x2f)
            return null; // VP8L signature byte
        const width = 1 + (((data[2] & 0x3f) << 8) | data[1]);
        const height = 1 + (((data[4] & 0xf) << 10) | (data[3] << 2) | (data[2] >> 6));
        return { width, height };
    }
    if (chunkType === 'VP8 ' && data.length >= 10) {
        // Lossy key frame: 3-byte frame tag, then the 0x9d 0x01 0x2a start code, then width/height as
        // 14-bit fields (top 2 bits are an upscale factor, masked off) in 2 little-endian bytes each.
        if (data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a)
            return null;
        const width = (data[6] | (data[7] << 8)) & 0x3fff;
        const height = (data[8] | (data[9] << 8)) & 0x3fff;
        return { width, height };
    }
    return null; // an animated (ANIM/ANMF) or otherwise-shaped WebP this parser doesn't cover
}
/** Best-effort header-only dimension read for the three formats SCF allows. */
export function readImageDimensions(bytes, family) {
    if (family === 'png')
        return pngDimensions(bytes);
    if (family === 'jpeg')
        return jpegDimensions(bytes);
    return webpDimensions(bytes);
}
/** Sniffs the magic bytes to tell which of the three SCF-allowed image formats `bytes` is, so a
 *  `.png` with the wrong content (or vice versa) is still caught. Moved here (from `validate.ts`)
 *  so `measureImage` below can use it without a circular import; re-exported from `validate.ts` for
 *  callers that only need family detection (e.g. a `{head, size}` image entry's magic-byte check). */
export function detectImageFamily(bytes) {
    if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
        return 'png';
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return 'jpeg';
    }
    if (bytes.length >= 12 &&
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50) {
        return 'webp';
    }
    return null;
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
export const MEASURE_IMAGE_MAX_PREFIX_BYTES = 64 * 1024;
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
export function measureImage(prefixBytes) {
    const family = detectImageFamily(prefixBytes);
    if (!family)
        return null;
    const dims = readImageDimensions(prefixBytes, family);
    if (!dims)
        return null;
    return { family, width: dims.width, height: dims.height };
}
/**
 * Ledger F126 (G7): builds the `{measured: true, ...}` record a streaming caller hands `validateBundle`
 * from a bounded prefix. Unlike `measureImage` (which collapses "wrong format" and "right format,
 * header unreadable" into `null`), this KEEPS the detected family when the dimensions cannot be read
 * (`width`/`height` 0), so `validateBundle` reports IMAGE_HEADER_UNREADABLE for a truncated header,
 * exactly like the directory/CLI path, instead of IMAGE_FORMAT_INVALID. Use this, not `measureImage`,
 * in any streaming reader (upload route, build processing).
 */
export function measureImageRecord(prefixBytes, size) {
    const family = detectImageFamily(prefixBytes);
    const dims = family ? readImageDimensions(prefixBytes, family) : null;
    return { measured: true, family, width: dims?.width ?? 0, height: dims?.height ?? 0, size };
}
//# sourceMappingURL=image-dimensions.js.map