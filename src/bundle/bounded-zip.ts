/**
 * A ZIP reader for the capture-sources bundle route (`/upload/:project/:version/bundle/complete`),
 * with the bounds a server reading an arbitrary customer-uploaded ZIP needs and the CLI-only reader
 * vendored from `@scrymore/scf` (`src/vendor/scf/dist/zip.js`) does not have (ledger F11):
 *
 *   - a cap on the number of entries and on their total *uncompressed* size (a zip bomb can be a
 *     few KB compressed and gigabytes uncompressed — checked from the central directory's declared
 *     sizes before any entry is inflated, so a bomb is rejected without ever running `inflateRawSync`
 *     on it)
 *   - a per-entry compression-ratio cap, as a second, cheaper zip-bomb signal
 *   - path traversal: an entry name that is absolute, has a backslash, a Windows drive letter, a NUL
 *     byte, or a "." / ".." path segment is rejected outright (independent of, and checked before,
 *     the vendored validator's own `isSafeRelPath` on the *manifest-referenced* paths)
 *   - symlinks: a Unix-created entry (`version made by` host byte 3) whose external attributes encode
 *     `S_IFLNK` is rejected — SCF bundles are files only
 *
 * Two passes over the central directory: the first only reads entry metadata (names, sizes, unix
 * mode) and collects every problem; only when that pass finds nothing wrong does the second pass
 * actually inflate entry bodies. A malicious bundle is therefore rejected without inflating anything.
 *
 * Not vendored (contract §2's `validateBundle` takes an already-extracted `BundleFiles` map, not a
 * raw ZIP buffer — turning bytes into that map, safely, is a per-consumer concern).
 */
import { inflateRawSync } from 'node:zlib';
import type { BundleFiles } from '../vendor/scf/dist/index.js';

export interface BoundedZipLimits {
  /** Central directory entry count above which the ZIP is rejected outright (no per-entry detail). */
  maxEntries: number;
  /** Sum of every entry's declared uncompressed size, read from the central directory. */
  maxTotalUncompressedBytes: number;
  /** uncompressedSize / compressedSize above which a single entry is treated as a zip bomb. */
  maxCompressionRatio: number;
}

export interface BoundedZipIssue {
  code: string;
  path?: string;
  message: string;
}

export type BoundedZipResult = { ok: true; files: BundleFiles } | { ok: false; issues: BoundedZipIssue[] };

export const DEFAULT_BOUNDED_ZIP_LIMITS: BoundedZipLimits = {
  maxEntries: 20_000,
  maxTotalUncompressedBytes: 1024 * 1024 * 1024, // 1 GiB
  maxCompressionRatio: 200,
};

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_SIZE = 0xffff;
/** "version made by" host byte for a UNIX-created entry (the only host that carries a Unix mode,
 *  and therefore a symlink bit, in its external file attributes). */
const UNIX_HOST = 3;
/** Unix file-type bits (`st_mode & S_IFMT`) for a symbolic link. */
const S_IFLNK = 0xa000;

function issue(code: string, message: string, path?: string): BoundedZipIssue {
  return path !== undefined ? { code, message, path } : { code, message };
}

function findEndOfCentralDirectory(buf: Buffer): number | null {
  const start = Math.max(0, buf.length - EOCD_MIN_SIZE - MAX_COMMENT_SIZE);
  for (let i = buf.length - EOCD_MIN_SIZE; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return null;
}

/** An unsafe raw ZIP member name: absolute, a backslash, a Windows drive letter, a NUL byte, empty,
 *  over a generous length, or containing a "." / ".." path segment. */
function isUnsafeZipMemberName(name: string): boolean {
  if (name.length === 0 || name.length > 1024) return true;
  if (name.startsWith('/') || name.includes('\\') || /^[A-Za-z]:/.test(name) || name.includes('\0')) return true;
  return name.split('/').some((seg) => seg === '.' || seg === '..');
}

interface CentralDirEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  isUnixSymlink: boolean;
}

/** Reads every central directory entry's metadata (no decompression). Returns `null` on a
 *  structurally corrupt central directory — the caller reports that as one bundle-level issue. */
function readCentralDirectory(buf: Buffer, eocdOffset: number, entryCount: number): CentralDirEntry[] | null {
  const entries: CentralDirEntry[] = [];
  let offset = buf.readUInt32LE(eocdOffset + 16);

  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CENTRAL_DIR_SIGNATURE) return null;

    const versionMadeByHost = buf.readUInt8(offset + 5);
    const compressionMethod = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const externalAttrs = buf.readUInt32LE(offset + 38);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);

    if (offset + 46 + nameLen > buf.length) return null;
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

    const isUnixSymlink =
      versionMadeByHost === UNIX_HOST && ((externalAttrs >>> 16) & 0xf000) === S_IFLNK;

    entries.push({ name, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset, isUnixSymlink });

    offset += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

function readLocalEntryBody(buf: Buffer, localHeaderOffset: number, compressionMethod: number, compressedSize: number): Uint8Array {
  if (localHeaderOffset + 30 > buf.length || buf.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_SIGNATURE) {
    throw new Error(`Corrupt ZIP local file header at offset ${localHeaderOffset}.`);
  }
  const nameLen = buf.readUInt16LE(localHeaderOffset + 26);
  const extraLen = buf.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + nameLen + extraLen;
  const compressed = buf.subarray(dataStart, dataStart + compressedSize);

  if (compressionMethod === 0) return new Uint8Array(compressed);
  if (compressionMethod === 8) return new Uint8Array(inflateRawSync(compressed));
  throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
}

/**
 * Parses a ZIP buffer into a bundle-relative path -> bytes map, enforcing `limits`. Directory
 * entries are skipped, same as the vendored reader.
 */
export function readBoundedZip(buf: Buffer, limits: BoundedZipLimits = DEFAULT_BOUNDED_ZIP_LIMITS): BoundedZipResult {
  const eocdOffset = findEndOfCentralDirectory(buf);
  if (eocdOffset === null) {
    return { ok: false, issues: [issue('BUNDLE_ZIP_INVALID', 'Not a valid ZIP file (no end-of-central-directory record found).')] };
  }

  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  if (entryCount > limits.maxEntries) {
    return {
      ok: false,
      issues: [issue('BUNDLE_TOO_MANY_ENTRIES', `ZIP has ${entryCount} entries, over the ${limits.maxEntries} limit.`)],
    };
  }

  const entries = readCentralDirectory(buf, eocdOffset, entryCount);
  if (entries === null) {
    return { ok: false, issues: [issue('BUNDLE_ZIP_INVALID', 'Corrupt ZIP central directory.')] };
  }

  // Pass 1: metadata-only checks. No entry is inflated here, so a hostile bundle costs nothing
  // beyond reading the (bounded-count) central directory.
  const issues: BoundedZipIssue[] = [];
  let totalUncompressed = 0;
  const fileEntries: CentralDirEntry[] = [];

  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue; // directory entry, not a file

    if (isUnsafeZipMemberName(entry.name)) {
      issues.push(
        issue(
          'BUNDLE_UNSAFE_PATH',
          `ZIP entry has an unsafe path (absolute, backslash, drive letter, or "." / ".." segment): ${JSON.stringify(entry.name)}`,
          entry.name
        )
      );
      continue;
    }
    if (entry.isUnixSymlink) {
      issues.push(issue('BUNDLE_SYMLINK_REJECTED', `ZIP entry is a symlink, which a bundle must not contain: ${entry.name}`, entry.name));
      continue;
    }
    if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > limits.maxCompressionRatio) {
      issues.push(
        issue(
          'BUNDLE_COMPRESSION_RATIO',
          `ZIP entry's compression ratio (${Math.round(entry.uncompressedSize / entry.compressedSize)}x) exceeds the ${limits.maxCompressionRatio}x limit: ${entry.name}`,
          entry.name
        )
      );
      continue;
    }

    totalUncompressed += entry.uncompressedSize;
    fileEntries.push(entry);
  }

  if (totalUncompressed > limits.maxTotalUncompressedBytes) {
    return {
      ok: false,
      issues: [
        issue(
          'BUNDLE_TOO_LARGE',
          `ZIP's total uncompressed size (${totalUncompressed} bytes) exceeds the ${limits.maxTotalUncompressedBytes} byte limit.`
        ),
      ],
    };
  }
  if (issues.length > 0) return { ok: false, issues };

  // Pass 2: only reached once every entry passed pass 1 — safe to inflate.
  const files: BundleFiles = new Map();
  for (const entry of fileEntries) {
    try {
      files.set(entry.name, readLocalEntryBody(buf, entry.localHeaderOffset, entry.compressionMethod, entry.compressedSize));
    } catch (e) {
      issues.push(issue('BUNDLE_ZIP_INVALID', `Could not read ZIP entry ${entry.name}: ${(e as Error).message}`, entry.name));
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, files };
}
