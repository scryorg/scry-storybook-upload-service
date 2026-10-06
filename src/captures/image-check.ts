// Header checks for the three renditions of a Scry Snip capture (feature snip-capture).
// The Worker does no image processing: it reads the first bytes of each object and trusts nothing
// the client declared. PNG also carries its dimensions in the IHDR chunk, which is compared to the
// declared width and height.

export type ImageKind = 'png' | 'jpeg' | 'webp';

/** How many leading bytes `sniffImage` and `pngDimensions` need. */
export const HEADER_BYTES = 32;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, at: number, expected: ReadonlyArray<number>): boolean {
  if (bytes.byteLength < at + expected.length) return false;
  return expected.every((b, i) => bytes[at + i] === b);
}

/** The image type the leading bytes prove, or null. PNG 8-byte signature, JPEG FF D8 FF, WebP "RIFF"....."WEBP". */
export function sniffImage(bytes: Uint8Array): ImageKind | null {
  if (startsWith(bytes, 0, PNG_SIGNATURE)) return 'png';
  if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, 0, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, 8, [0x57, 0x45, 0x42, 0x50])) return 'webp';
  return null;
}

/** Width and height from a PNG's IHDR chunk, which must be the first chunk. Null if the header is not that. */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  // 8 signature + 4 length + 4 "IHDR" + 4 width + 4 height
  if (bytes.byteLength < 24 || !startsWith(bytes, 0, PNG_SIGNATURE)) return null;
  if (!startsWith(bytes, 12, [0x49, 0x48, 0x44, 0x52])) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
