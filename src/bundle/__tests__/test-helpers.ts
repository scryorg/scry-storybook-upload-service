/**
 * Test-only ZIP writer and directory zipper for the capture-sources bundle route tests. A hand
 * rolled writer (not the `zip` CLI) so a test can also craft adversarial entries the `zip` CLI
 * can't easily produce — a fabricated symlink's external attributes, or a declared uncompressed
 * size that lies about the actual bytes — which is exactly what `bounded-zip.test.ts` needs.
 *
 * Every entry is STORED (compression method 0): `readBoundedZip`'s local-entry reader copies stored
 * bytes verbatim, so there is no need to exercise `inflateRawSync` here to prove the *bounds* logic;
 * the vendored validator's own test suite (scry-capture-format) already covers deflate.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface ZipEntryInput {
  name: string;
  data: Buffer;
  /** Unix `st_mode` bits for the central directory's external attributes (default: a regular file,
   *  0o100644). Set to `0o120777` (S_IFLNK | 0777) to fabricate a symlink entry. */
  unixMode?: number;
  /** Declared uncompressed size, when it should differ from `data.length` (to test a lying entry). */
  declaredUncompressedSize?: number;
}

const S_IFREG = 0o100644;

export function buildZip(entries: ZipEntryInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const uncompressedSize = entry.declaredUncompressedSize ?? data.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(0, 8); // compression: stored
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(0, 14); // crc32 (unchecked by readBoundedZip)
    localHeader.writeUInt32LE(data.length, 18); // compressed size (the actual bytes written)
    localHeader.writeUInt32LE(data.length, 22); // uncompressed size (local header; readers trust the central directory's copy)
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
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(0, 16); // crc32
    centralHeader.writeUInt32LE(data.length, 20); // compressed size
    centralHeader.writeUInt32LE(uncompressedSize, 24); // uncompressed size (can be fabricated)
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
