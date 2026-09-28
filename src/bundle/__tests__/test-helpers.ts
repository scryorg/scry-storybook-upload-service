/**
 * Test-only ZIP writer and directory zipper for the capture-sources bundle route tests. A hand
 * rolled writer (not the `zip` CLI, and not `archiver` — see `archiver-helpers.ts` for that) so a
 * test can also craft adversarial entries no real tool would ever produce: a fabricated symlink's
 * external attributes, a central directory that lies about an entry's real content, a local header
 * whose name disagrees with the central directory's, or a data descriptor that disagrees with both —
 * which is exactly what `bounded-zip.test.ts` and `central-directory.test.ts` need.
 *
 * Ledger F49: `bounded-zip.ts`'s reader now treats the CENTRAL DIRECTORY as the sole source of truth
 * for an entry's size/CRC (never the local header, which a real streaming writer like `archiver`
 * zeroes out via general-purpose flag bit 3 — see module docs on `bounded-zip.ts`). This writer
 * mirrors that: `declaredUncompressedSize`/`crc32` control what the CENTRAL DIRECTORY says, `flags`
 * controls whether bit 3 is set (and, if so, a real trailing data descriptor is written), and
 * `localNameOverride`/`dataDescriptorOverride` let a test deliberately desynchronize the local header
 * or descriptor from the central directory to prove the reader catches it.
 */
import { deflateRawSync } from 'node:zlib';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { crc32Final, crc32Update, CRC32_SEED } from '../crc32.js';
import { readCentralDirectory } from '../central-directory.js';
import { readBoundedZipEntries, type BoundedZipLimits, type BoundedZipResult } from '../bounded-zip.js';

function realCrc32(bytes: Buffer): number {
  return crc32Final(crc32Update(CRC32_SEED, bytes));
}

export interface DataDescriptorOverride {
  compressedSize?: number;
  uncompressedSize?: number;
  crc32?: number;
}

export interface ZipEntryInput {
  name: string;
  /** The entry's real on-disk (possibly compressed) bytes: raw content for STORED, already-deflated
   *  bytes for DEFLATE. */
  data: Buffer;
  /** The entry's real, honest decompressed content — used to compute a correct default CRC-32 and
   *  default declared size. Defaults to `data` (correct for STORED); `deflateEntry()` below sets this
   *  for DEFLATE entries. */
  rawContent?: Buffer;
  /** 0 = STORED (default), 8 = DEFLATE. */
  compressionMethod?: 0 | 8;
  /** Unix `st_mode` bits for the central directory's external attributes (default: a regular file,
   *  0o100644). Set to `0o120777` (S_IFLNK | 0777) to fabricate a symlink entry. */
  unixMode?: number;
  /** The CENTRAL DIRECTORY's declared uncompressed size (authoritative under the current reader —
   *  ledger F49). Defaults to `rawContent.length` (honest); pass this explicitly to craft a
   *  lying/mismatched entry. */
  declaredUncompressedSize?: number;
  /** The CENTRAL DIRECTORY's declared CRC-32. Defaults to the real CRC-32 of `rawContent` (honest);
   *  pass this explicitly to craft a CRC mismatch. */
  declaredCrc32?: number;
  /** General-purpose flags for both the local header and central directory (default 0). Set bit 3
   *  (0x0008) to emit a genuine streamed entry: the LOCAL header's own size/CRC fields are zeroed
   *  (matching real `archiver` output — ledger F49) and a real data descriptor is written after the
   *  entry's data. */
  flags?: number;
  /** Only meaningful with flags bit 3 set: makes the DATA DESCRIPTOR itself disagree with the central
   *  directory (defaults to agreeing, like a real writer) — for testing that disagreement is caught. */
  dataDescriptorOverride?: DataDescriptorOverride;
  /** The LOCAL header's own name, when it should differ from the central directory's `name` — crafts
   *  the "parser confusion" / name-mismatch case. Defaults to `name`. */
  localNameOverride?: string;
}

const S_IFREG = 0o100644;
const STREAMING_DATA_DESCRIPTOR_FLAG = 0x0008;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;

/** Builds a real DEFLATE entry: `rawContent` is genuinely compressed with `zlib.deflateRawSync`
 *  (not hand-faked), so a test exercising the actual decompression path — including a real zip-bomb
 *  ratio — gets real bytes in, real bytes out. */
export function deflateEntry(
  name: string,
  rawContent: Buffer,
  options: { declaredUncompressedSize?: number; declaredCrc32?: number; flags?: number } = {}
): ZipEntryInput {
  return {
    name,
    data: deflateRawSync(rawContent),
    rawContent,
    compressionMethod: 8,
    declaredUncompressedSize: options.declaredUncompressedSize ?? rawContent.length,
    declaredCrc32: options.declaredCrc32,
    flags: options.flags ?? 0,
  };
}

export function buildZip(entries: ZipEntryInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const rawContent = entry.rawContent ?? entry.data;
    const data = entry.data;
    const compressionMethod = entry.compressionMethod ?? 0;
    const uncompressedSize = entry.declaredUncompressedSize ?? rawContent.length;
    const crc32 = entry.declaredCrc32 ?? realCrc32(rawContent);
    const flags = entry.flags ?? 0;
    const streamed = (flags & STREAMING_DATA_DESCRIPTOR_FLAG) !== 0;
    const localName = entry.localNameOverride ?? entry.name;
    const localNameBuf = Buffer.from(localName, 'utf8');
    const centralNameBuf = Buffer.from(entry.name, 'utf8');

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    // A streamed (bit 3) entry's local header has its size/CRC fields zeroed, exactly like real
    // `archiver` output (ledger F49) — the reader must get these from the central directory instead.
    localHeader.writeUInt32LE(streamed ? 0 : crc32, 14);
    localHeader.writeUInt32LE(streamed ? 0 : data.length, 18);
    localHeader.writeUInt32LE(streamed ? 0 : uncompressedSize, 22);
    localHeader.writeUInt16LE(localNameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra len

    const parts = [localHeader, localNameBuf, data];
    if (streamed) {
      const dd = entry.dataDescriptorOverride ?? {};
      const ddCompressedSize = dd.compressedSize ?? data.length;
      const ddUncompressedSize = dd.uncompressedSize ?? uncompressedSize;
      const ddCrc32 = dd.crc32 ?? crc32;
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(DATA_DESCRIPTOR_SIGNATURE, 0);
      descriptor.writeUInt32LE(ddCrc32, 4);
      descriptor.writeUInt32LE(ddCompressedSize, 8);
      descriptor.writeUInt32LE(ddUncompressedSize, 12);
      parts.push(descriptor);
    }
    const localEntry = Buffer.concat(parts);
    localParts.push(localEntry);

    const versionMadeBy = (3 << 8) | 20; // high byte 3 = UNIX host, low byte 20 = spec version 2.0
    // `<<` operates on signed 32-bit ints in JS, and a regular-file/symlink mode shifted into the
    // top 16 bits sets the sign bit — `>>> 0` coerces back to the unsigned value writeUInt32LE needs.
    const externalAttrs = ((entry.unixMode ?? S_IFREG) << 16) >>> 0;

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(versionMadeBy, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(compressionMethod, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc32, 16);
    centralHeader.writeUInt32LE(data.length, 20); // compressed size (always real — never zeroed)
    centralHeader.writeUInt32LE(uncompressedSize, 24); // the reader's authoritative declared size
    centralHeader.writeUInt16LE(centralNameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(externalAttrs, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(Buffer.concat([centralHeader, centralNameBuf]));
    offset += localEntry.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const centralDirOffset = offset;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(centralDirOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

/** Wraps a `Buffer` in a single-chunk `ReadableStream`, the shape the local-entries streaming pass
 *  consumes. */
export function streamOf(buf: Buffer | Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buf));
      controller.close();
    },
  });
}

/** Wraps a `Buffer` in a `ReadableStream` that yields it in `chunkSize`-byte pieces, so a test can
 *  exercise the cursor's multi-chunk buffering/backpressure path instead of always handing it one
 *  giant chunk (which a real R2/S3 stream never does for a large object). */
export function chunkedStreamOf(buf: Buffer | Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  const bytes = new Uint8Array(buf);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
}

/**
 * Composes `readCentralDirectory` + `readBoundedZipEntries` against an in-memory ZIP buffer and a
 * (possibly separately-chunked) stream over the same bytes — exactly how `readBoundedZip` composes
 * them against real storage, but without needing a `StorageService` double for tests that only care
 * about the ZIP-parsing logic itself.
 */
export async function readFullZipFromStream(
  zip: Buffer,
  stream: ReadableStream<Uint8Array>,
  limits: BoundedZipLimits
): Promise<BoundedZipResult> {
  const readRange = async (range: { offset: number; length: number }): Promise<Uint8Array | null> => {
    const end = Math.min(zip.length, range.offset + range.length);
    if (range.offset >= zip.length) return new Uint8Array(0);
    return zip.subarray(range.offset, end);
  };
  const centralDirectory = await readCentralDirectory(readRange, zip.length, limits);
  if (!centralDirectory.ok) return { ok: false, issues: centralDirectory.issues };
  return readBoundedZipEntries(stream, centralDirectory.entries, centralDirectory.centralDirectoryOffset, limits, centralDirectory.issues);
}

/** Convenience form of `readFullZipFromStream` for tests that don't need a specific chunking shape. */
export async function readFullZip(zip: Buffer, limits: BoundedZipLimits): Promise<BoundedZipResult> {
  return readFullZipFromStream(zip, streamOf(zip), limits);
}

/** Recursively reads `dir` into ZIP entries (POSIX-relative paths) and zips them, STORED. */
export async function zipDirectory(dir: string): Promise<Buffer> {
  const entries: ZipEntryInput[] = [];

  async function walk(current: string, rel: string): Promise<void> {
    const dirEntries = await readdir(current, { withFileTypes: true });
    for (const entry of dirEntries) {
      const abs = path.join(current, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, relPath);
      } else if (entry.isFile()) {
        entries.push({ name: relPath.split(path.sep).join('/'), data: await readFile(abs) });
      }
    }
  }

  await walk(dir, '');
  return buildZip(entries);
}
