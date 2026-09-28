/**
 * Test-only ZIP writer and directory zipper for the capture-sources bundle route tests. A hand
 * rolled writer (not the `zip` CLI) so a test can also craft adversarial entries the `zip` CLI can't
 * easily produce — a fabricated symlink's external attributes, or a declared uncompressed size that
 * lies about the entry's real content — which is exactly what `bounded-zip.test.ts` needs.
 *
 * `bounded-zip.ts`'s streaming reader reads each entry's declared sizes from its LOCAL file header
 * (never the central directory — trusting that was ledger F31's bug), so this writer puts whatever
 * `declaredUncompressedSize` a test asks for into the local header. The central directory still
 * carries a copy (real ZIP tools keep both in sync; a mismatch there isn't itself a vulnerability
 * under the new reader, since it never reads the central directory's size fields at all — only its
 * symlink bit).
 */
import { deflateRawSync } from 'node:zlib';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface ZipEntryInput {
  name: string;
  /** The entry's real on-disk bytes: raw content for STORED, already-deflated bytes for DEFLATE. */
  data: Buffer;
  /** 0 = STORED (default), 8 = DEFLATE. */
  compressionMethod?: 0 | 8;
  /** Unix `st_mode` bits for the central directory's external attributes (default: a regular file,
   *  0o100644). Set to `0o120777` (S_IFLNK | 0777) to fabricate a symlink entry. */
  unixMode?: number;
  /** Declared uncompressed size, when it should differ from the entry's real decompressed size (to
   *  test a lying/mismatched entry). Defaults to `data.length` (correct for STORED; pass this
   *  explicitly for DEFLATE, or use `deflateEntry()` below which sets it correctly by default). */
  declaredUncompressedSize?: number;
  /** ZIP general-purpose flags (default 0). Set bit 3 (0x0008) to fabricate a streamed entry whose
   *  sizes are only known after the fact — `bounded-zip.ts` must reject these outright. */
  flags?: number;
}

const S_IFREG = 0o100644;

/** Builds a real DEFLATE entry: `rawContent` is genuinely compressed with `zlib.deflateRawSync`
 *  (not hand-faked), so a test exercising the actual decompression path — including a real zip-bomb
 *  ratio — gets real bytes in, real bytes out. */
export function deflateEntry(name: string, rawContent: Buffer, options: { declaredUncompressedSize?: number } = {}): ZipEntryInput {
  return {
    name,
    data: deflateRawSync(rawContent),
    compressionMethod: 8,
    declaredUncompressedSize: options.declaredUncompressedSize ?? rawContent.length,
  };
}

export function buildZip(entries: ZipEntryInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const compressionMethod = entry.compressionMethod ?? 0;
    const uncompressedSize = entry.declaredUncompressedSize ?? data.length;
    const flags = entry.flags ?? 0;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(0, 14); // crc32 (unchecked by bounded-zip.ts)
    localHeader.writeUInt32LE(data.length, 18); // compressed size (the actual on-disk bytes)
    localHeader.writeUInt32LE(uncompressedSize, 22); // declared uncompressed size (can be fabricated)
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra len

    const localEntry = Buffer.concat([localHeader, nameBuf, data]);
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
    centralHeader.writeUInt32LE(0, 16); // crc32
    centralHeader.writeUInt32LE(data.length, 20); // compressed size
    centralHeader.writeUInt32LE(uncompressedSize, 24); // uncompressed size (not read by bounded-zip.ts)
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(externalAttrs, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(Buffer.concat([centralHeader, nameBuf]));
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

/** Wraps a `Buffer` in a single-chunk `ReadableStream`, the shape `readBoundedZipStream` consumes. */
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
