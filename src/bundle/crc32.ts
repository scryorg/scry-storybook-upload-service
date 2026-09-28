/**
 * A small, dependency-free CRC-32 (the ZIP/PNG/gzip polynomial), used by `bounded-zip.ts` to verify
 * each entry's real decompressed content against the central directory's declared `crc-32` field as
 * it streams (ledger F49: "verify the data descriptor/CRC if cheap"). A single table lookup per byte,
 * no extra memory beyond the running 32-bit accumulator — cheap enough to run unconditionally on
 * every entry, image or not, alongside the existing real-byte-counter checks (ledger F31).
 *
 * Kept as plain JS (no `node:zlib`) so it works identically in the Cloudflare Worker deployment and
 * in Node — the same reason `bounded-zip.ts` uses the Web `DecompressionStream` API instead of
 * `zlib.inflateRawSync`.
 */

function buildTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = buildTable();

/** The running state to start a fresh CRC-32 computation with (before any bytes have been fed in). */
export const CRC32_SEED = 0xffffffff;

/** Feeds `chunk` into a running CRC-32 computation. `state` is the previous call's return value (or
 *  `CRC32_SEED` for the first chunk of a new entry) — this is the raw, not-yet-finalized internal
 *  state, not a real CRC-32 value; call `crc32Final` once all of an entry's bytes have been fed in
 *  to get the value that appears in a ZIP's central directory. */
export function crc32Update(state: number, chunk: Uint8Array): number {
  let c = state;
  for (let i = 0; i < chunk.length; i++) {
    c = CRC_TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8);
  }
  return c >>> 0;
}

/** Finalizes a running CRC-32 state (from `CRC32_SEED` and zero or more `crc32Update` calls) into the
 *  real CRC-32 value — matches what a ZIP's local data descriptor / central directory record stores. */
export function crc32Final(state: number): number {
  return (state ^ 0xffffffff) >>> 0;
}
