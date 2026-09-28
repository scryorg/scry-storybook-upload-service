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
//# sourceMappingURL=image-dimensions.js.map