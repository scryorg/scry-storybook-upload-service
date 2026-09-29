/**
 * Reads a ZIP's end-of-central-directory (EOCD) record and central directory via targeted byte-range
 * reads of the object's TAIL — never the whole (potentially huge) object — and returns each entry's
 * name, compression method, sizes, CRC, local-header offset, and symlink bit straight from the
 * central directory (ledger F49).
 *
 * This exists because `archiver` (the package our own CLI and sbcov both build bundles with) sets
 * general-purpose flag bit 3 ("data descriptor follows") on every entry, which zeroes out that
 * entry's compressed/uncompressed size and CRC-32 fields in its LOCAL file header — the old reader
 * trusted those fields and rejected every entry as "an unsupported streamed size" (`bounded-zip.ts`'s
 * previous `STREAMING_DATA_DESCRIPTOR_FLAG` check), which meant every real bundle was rejected. The
 * central directory's copies of those same fields are always correct regardless of bit 3, so reading
 * it first — and treating it as the sole source of truth for what each entry's data actually is —
 * fixes that without weakening any of the zip-bomb defenses (ledger F31/F32), which still measure
 * REAL decompressed bytes as they stream, never trusting a declared size outright.
 */
import type { StorageObjectRange } from '../services/storage/storage.service.js';

export interface CentralDirectoryEntry {
  /** The bundle-relative path exactly as the central directory records it — the authoritative name;
   *  `bounded-zip.ts` rejects any entry whose LOCAL header disagrees with this. */
  name: string;
  compressionMethod: number;
  /** REAL, authoritative sizes from the central directory — never a local header's (which, per
   *  above, may be zeroed for a streamed entry). */
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  /** The local header's own general-purpose flags (needed to know whether a trailing data descriptor
   *  follows this entry's data in the byte stream, so the streaming reader can skip over it). */
  flags: number;
  /** Byte offset of this entry's LOCAL file header from the start of the object — used only to
   *  cross-check the streaming reader's own position as it walks forward, never to seek. */
  localHeaderOffset: number;
  isDirectory: boolean;
  /** True specifically when the Unix mode bits say symlink (`S_IFLNK`) — kept as its own field (rather
   *  than folded into `isUnixNonRegularFile`) purely so a rejection can say "symlink" instead of the
   *  more generic message. Every symlink is also `isUnixNonRegularFile`. */
  isUnixSymlink: boolean;
  /** True for any FILE entry (one not already named as a directory, i.e. `name` doesn't end in `/`)
   *  whose external attributes carry a Unix file-type other than "regular file" — a symlink, but also
   *  a character/block device, FIFO or socket. Computed from the mode bits alone, regardless of the
   *  "version made by" host byte (ledger F61) — see that field's removal below. */
  isUnixNonRegularFile: boolean;
}

export interface CentralDirectoryLimits {
  /** Central directory entry count above which the ZIP is rejected outright, before any entry is
   *  even parsed. */
  maxEntries: number;
  /** Upper bound on the central directory's own declared byte size — bounds both the range-GET this
   *  module issues and the memory it holds transiently while parsing (independent of `maxEntries`:
   *  a small number of entries with very long names/extra fields/comments could otherwise still be
   *  large). */
  maxCentralDirectoryBytes: number;
  /** How far back from the end of the object to search for the EOCD record: the format's own worst
   *  case is a fixed 22-byte record plus a 65535-byte comment. */
  maxEocdSearchBytes: number;
}

export interface CentralDirectoryIssue {
  code: string;
  path?: string;
  message: string;
}

export type CentralDirectoryResult =
  | { ok: true; entries: CentralDirectoryEntry[]; centralDirectoryOffset: number; issues: CentralDirectoryIssue[] }
  | { ok: false; issues: CentralDirectoryIssue[] };

/** Reads exactly the requested byte range of the underlying object, or `null`/a short read if it
 *  does not exist / is shorter than expected. This module never assumes any particular storage
 *  backend — `bounded-zip.ts`'s `readBoundedZip` is what binds this to a real `StorageService`. */
export type RangeReader = (range: StorageObjectRange) => Promise<Uint8Array | null>;

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_FIXED_SIZE = 22;
const MAX_EOCD_COMMENT_BYTES = 0xffff;
/** Immediately precedes a Zip64 archive's EOCD record when one is present — a cheap extra signal
 *  alongside the 0xffffffff sentinel checks below (a well-formed Zip64 archive always has one). */
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_LOCATOR_SIZE = 20;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const CENTRAL_DIR_RECORD_FIXED_SIZE = 46;
/** `st_mode & S_IFMT` — the file-type bits of a Unix mode word. */
const S_IFMT = 0xf000;
/** Unix file-type bits (`st_mode & S_IFMT`) for a symbolic link. */
const S_IFLNK = 0xa000;
/** Unix file-type bits for an ordinary file — the only type this reader ever accepts for a FILE entry
 *  (one not already named as a directory). Zero (no type bits set at all, e.g. a DOS-created entry
 *  that never populated Unix external attributes in the first place) is also treated as regular. */
const S_IFREG = 0x8000;
/** A 32-bit field holding this exact value signals "the real value needs a Zip64 extra field" —
 *  this reader treats that as unsupported rather than going to find the extra field (ledger F49). */
const ZIP64_SENTINEL_32 = 0xffffffff;
const ZIP64_SENTINEL_16 = 0xffff;

function issue(code: string, message: string, path?: string): CentralDirectoryIssue {
  return path !== undefined ? { code, message, path } : { code, message };
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Scans `tail` backward for a genuine EOCD record: a real one's declared comment length exactly
 *  accounts for every byte remaining after it. A false-positive match (comment bytes that happen
 *  to contain the signature) will virtually never also satisfy this, and even if it did, every
 *  size/offset/count read from it is still bounds-checked by `parseAndValidateEocdFields` below
 *  before anything is trusted. Returns -1 when no record is found. */
function findEocdIndex(tail: Buffer): number {
  for (let i = tail.byteLength - EOCD_FIXED_SIZE; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== EOCD_SIGNATURE) continue;
    const commentLen = tail.readUInt16LE(i + 20);
    if (i + EOCD_FIXED_SIZE + commentLen === tail.byteLength) {
      return i;
    }
  }
  return -1;
}

type EocdFieldsResult =
  | { ok: true; totalEntries: number; centralDirSize: number; centralDirOffset: number }
  | { ok: false; issues: CentralDirectoryIssue[] };

/** Reads the EOCD record's own fields at `eocdIndex` and validates them: single-disk, no Zip64
 *  sentinel values, entry count and central-directory size within `limits`, and the declared
 *  offset/size consistent with the object's real size. */
function parseAndValidateEocdFields(
  tail: Buffer,
  eocdIndex: number,
  objectSize: number,
  limits: CentralDirectoryLimits
): EocdFieldsResult {
  const diskNumber = tail.readUInt16LE(eocdIndex + 4);
  const diskWithCentralDirStart = tail.readUInt16LE(eocdIndex + 6);
  const entriesOnThisDisk = tail.readUInt16LE(eocdIndex + 8);
  const totalEntries = tail.readUInt16LE(eocdIndex + 10);
  const centralDirSize = tail.readUInt32LE(eocdIndex + 12);
  const centralDirOffset = tail.readUInt32LE(eocdIndex + 16);

  if (diskNumber !== 0 || diskWithCentralDirStart !== 0 || entriesOnThisDisk !== totalEntries) {
    return {
      ok: false,
      issues: [issue('BUNDLE_ZIP_MULTIDISK_UNSUPPORTED', 'ZIP spans multiple disks/volumes, which this reader does not support.')],
    };
  }
  if (
    totalEntries === ZIP64_SENTINEL_16 ||
    entriesOnThisDisk === ZIP64_SENTINEL_16 ||
    centralDirSize === ZIP64_SENTINEL_32 ||
    centralDirOffset === ZIP64_SENTINEL_32
  ) {
    return { ok: false, issues: [issue('BUNDLE_ZIP64_UNSUPPORTED', 'ZIP uses Zip64 sizes, which this reader does not support.')] };
  }
  if (totalEntries > limits.maxEntries) {
    return { ok: false, issues: [issue('BUNDLE_TOO_MANY_ENTRIES', `ZIP has more than ${limits.maxEntries} entries.`)] };
  }
  if (centralDirSize > limits.maxCentralDirectoryBytes) {
    return {
      ok: false,
      issues: [issue('BUNDLE_ZIP_INVALID', `ZIP's central directory is ${centralDirSize} bytes, over the ${limits.maxCentralDirectoryBytes} byte limit.`)],
    };
  }
  if (centralDirOffset > objectSize || centralDirOffset + centralDirSize > objectSize) {
    return {
      ok: false,
      issues: [issue('BUNDLE_ZIP_INVALID', "ZIP's central directory offset/size is inconsistent with the object's real size.")],
    };
  }

  return { ok: true, totalEntries, centralDirSize, centralDirOffset };
}

/** The bytes of the central directory itself, located via the EOCD record, plus the two EOCD
 *  fields the entry-parsing pass below needs (`totalEntries`) and the caller needs back
 *  (`centralDirOffset`, part of the final `CentralDirectoryResult`). */
type EocdLocateResult =
  | { ok: true; cd: Buffer; centralDirOffset: number; totalEntries: number }
  | { ok: false; issues: CentralDirectoryIssue[] };

/**
 * Locates a ZIP's EOCD record via `readRange` and returns the central directory's raw bytes,
 * bounding both the declared entry count and the central directory's own byte size before ever
 * reading it in full. Rejects Zip64 and multi-disk archives outright (fail closed — out of scope,
 * ledger F49) rather than attempting to support them partially. Split out of
 * `readCentralDirectory` purely to keep that function's own cognitive complexity down — this half
 * and the per-entry parsing half below are independent concerns.
 */
async function locateAndReadCentralDirectory(
  readRange: RangeReader,
  objectSize: number,
  limits: CentralDirectoryLimits
): Promise<EocdLocateResult> {
  if (objectSize < EOCD_FIXED_SIZE) {
    return { ok: false, issues: [issue('BUNDLE_ZIP_INVALID', 'Object is smaller than a minimal ZIP end-of-central-directory record.')] };
  }

  const tailWindow = Math.min(objectSize, EOCD_FIXED_SIZE + MAX_EOCD_COMMENT_BYTES, Math.max(EOCD_FIXED_SIZE, limits.maxEocdSearchBytes));
  const tailOffset = objectSize - tailWindow;
  const tailBytes = await readRange({ offset: tailOffset, length: tailWindow });
  if (!tailBytes || tailBytes.byteLength < EOCD_FIXED_SIZE) {
    return { ok: false, issues: [issue('BUNDLE_ZIP_INVALID', 'Could not read the object tail to locate the end-of-central-directory record.')] };
  }
  const tail = asBuffer(tailBytes);

  const eocdIndex = findEocdIndex(tail);
  if (eocdIndex === -1) {
    return { ok: false, issues: [issue('BUNDLE_ZIP_INVALID', 'No end-of-central-directory record found.')] };
  }

  if (eocdIndex >= ZIP64_EOCD_LOCATOR_SIZE && tail.readUInt32LE(eocdIndex - ZIP64_EOCD_LOCATOR_SIZE) === ZIP64_EOCD_LOCATOR_SIGNATURE) {
    return {
      ok: false,
      issues: [issue('BUNDLE_ZIP64_UNSUPPORTED', 'ZIP has a Zip64 end-of-central-directory locator, which this reader does not support.')],
    };
  }

  const eocdFields = parseAndValidateEocdFields(tail, eocdIndex, objectSize, limits);
  if (!eocdFields.ok) return eocdFields;
  const { totalEntries, centralDirSize, centralDirOffset } = eocdFields;

  // The central directory is almost always already inside the tail window we just read (EOCD
  // comments are virtually always empty) — reuse those bytes rather than a second round trip when
  // possible.
  let cd: Buffer;
  if (centralDirOffset >= tailOffset) {
    const start = centralDirOffset - tailOffset;
    cd = tail.subarray(start, start + centralDirSize);
  } else {
    const fetched = await readRange({ offset: centralDirOffset, length: centralDirSize });
    if (!fetched || fetched.byteLength < centralDirSize) {
      return { ok: false, issues: [issue('BUNDLE_ZIP_INVALID', 'Could not read the full central directory.')] };
    }
    cd = asBuffer(fetched);
  }

  return { ok: true, cd, centralDirOffset, totalEntries };
}

/** The result of parsing every central directory record already located by
 *  `locateAndReadCentralDirectory` above. */
type EntriesParseResult =
  | { ok: true; entries: CentralDirectoryEntry[]; issues: CentralDirectoryIssue[] }
  | { ok: false; issues: CentralDirectoryIssue[] };

/**
 * Ledger F62: two central-directory records sharing a name -- exactly, or merely after Unicode NFC
 * normalisation and case-folding (the same collision many real filesystems apply on extraction,
 * e.g. macOS's default case-insensitive volumes, or two visually-identical names composed
 * differently) -- is a raw zip-path-level smuggling primitive: nothing downstream ever notices,
 * since a `Map`'s `.set(entry.name, ...)` silently keeps whichever entry is physically last and
 * discards the other with no signal at all. `seenNames` is keyed by the folded name so both forms
 * of collision are caught with one check; mutated in place (records `name` under its folded key)
 * exactly when it does NOT already contain a collision, same as the inline version this replaced.
 */
function checkDuplicateName(name: string, seenNames: Map<string, string>): CentralDirectoryIssue | null {
  const foldedName = name.normalize('NFC').toLowerCase();
  const firstName = seenNames.get(foldedName);
  if (firstName !== undefined) {
    return issue(
      'BUNDLE_DUPLICATE_NAME',
      firstName === name
        ? `ZIP has two entries with the exact same name: ${name}`
        : `ZIP has two entries whose names collide after Unicode normalisation/case-folding: ${JSON.stringify(firstName)} and ${JSON.stringify(name)}`,
      name
    );
  }
  seenNames.set(foldedName, name);
  return null;
}

interface UnixFileTypeClassification {
  isDirectory: boolean;
  isUnixSymlink: boolean;
  isUnixNonRegularFile: boolean;
  /** Set exactly when `isUnixNonRegularFile` — an ordinary read issue (ledger F61), never a rejection. */
  nonRegularFileIssue: CentralDirectoryIssue | null;
}

/**
 * Ledger F61: this used to also require `versionMadeByHost === UNIX_HOST`, which a crafted central
 * directory record can trivially lie about while still carrying genuine Unix mode bits in external
 * attributes — the mode bits themselves are the only thing checked now, regardless of the declared
 * host. `isDirectory` (by NAME) is checked first so a legitimately Unix-mode-stamped directory
 * entry (S_IFDIR, very common from real Unix zip tools) is never flagged here; this is only about
 * FILE entries whose Unix mode disagrees with them being an ordinary file.
 */
function classifyUnixFileType(name: string, externalAttrs: number): UnixFileTypeClassification {
  const isDirectory = name.endsWith('/');
  const unixFileType = (externalAttrs >>> 16) & S_IFMT;
  const isUnixSymlink = unixFileType === S_IFLNK;
  const isUnixNonRegularFile = !isDirectory && unixFileType !== 0 && unixFileType !== S_IFREG;

  let nonRegularFileIssue: CentralDirectoryIssue | null = null;
  if (isUnixNonRegularFile) {
    nonRegularFileIssue = isUnixSymlink
      ? issue('BUNDLE_SYMLINK_REJECTED', `ZIP entry is a symlink, which a bundle must not contain: ${name}`, name)
      : issue(
          'BUNDLE_NON_REGULAR_FILE',
          `ZIP entry's Unix mode (external attributes) says it is not a regular file (type 0o${unixFileType.toString(8)}): ${name}`,
          name
        );
  }
  return { isDirectory, isUnixSymlink, isUnixNonRegularFile, nonRegularFileIssue };
}

/** Parses each fixed-size central directory record in `cd` into a `CentralDirectoryEntry`,
 *  rejecting Zip64 entries, a corrupt/overrunning record, a duplicate/colliding name (ledger F62),
 *  or an out-of-range local header offset; a Unix-mode symlink or other non-regular file is
 *  reported as an ordinary read issue instead (ledger F61), not a rejection. */
function parseCentralDirectoryRecords(cd: Buffer, totalEntries: number, objectSize: number): EntriesParseResult {
  const entries: CentralDirectoryEntry[] = [];
  const issues: CentralDirectoryIssue[] = [];
  const seenNames = new Map<string, string>(); // foldedName -> first entry's real (unfolded) name
  let idx = 0;
  for (let n = 0; n < totalEntries; n++) {
    if (idx + CENTRAL_DIR_RECORD_FIXED_SIZE > cd.byteLength || cd.readUInt32LE(idx) !== CENTRAL_DIR_SIGNATURE) {
      return { ok: false, issues: [issue('BUNDLE_ZIP_INVALID', 'Corrupt central directory: expected another record.')] };
    }
    const flags = cd.readUInt16LE(idx + 8);
    const compressionMethod = cd.readUInt16LE(idx + 10);
    const crc32 = cd.readUInt32LE(idx + 16);
    const compressedSize = cd.readUInt32LE(idx + 20);
    const uncompressedSize = cd.readUInt32LE(idx + 24);
    const nameLen = cd.readUInt16LE(idx + 28);
    const extraLen = cd.readUInt16LE(idx + 30);
    const commentLen = cd.readUInt16LE(idx + 32);
    const externalAttrs = cd.readUInt32LE(idx + 38);
    const localHeaderOffset = cd.readUInt32LE(idx + 42);

    const recordEnd = idx + CENTRAL_DIR_RECORD_FIXED_SIZE + nameLen + extraLen + commentLen;
    if (recordEnd > cd.byteLength) {
      return { ok: false, issues: [issue('BUNDLE_ZIP_INVALID', 'Corrupt central directory: a record overruns the directory.')] };
    }
    const name = cd.toString('utf8', idx + CENTRAL_DIR_RECORD_FIXED_SIZE, idx + CENTRAL_DIR_RECORD_FIXED_SIZE + nameLen);

    const duplicateIssue = checkDuplicateName(name, seenNames);
    if (duplicateIssue) {
      return { ok: false, issues: [duplicateIssue] };
    }

    if (compressedSize === ZIP64_SENTINEL_32 || uncompressedSize === ZIP64_SENTINEL_32 || localHeaderOffset === ZIP64_SENTINEL_32) {
      return {
        ok: false,
        issues: [issue('BUNDLE_ZIP64_UNSUPPORTED', `ZIP entry uses Zip64 sizes/offset, which this reader does not support: ${name}`, name)],
      };
    }
    if (localHeaderOffset >= objectSize) {
      return {
        ok: false,
        issues: [issue('BUNDLE_ZIP_INVALID', `ZIP entry's local header offset is past the end of the object: ${name}`, name)],
      };
    }

    const { isDirectory, isUnixSymlink, isUnixNonRegularFile, nonRegularFileIssue } = classifyUnixFileType(name, externalAttrs);
    if (nonRegularFileIssue) {
      issues.push(nonRegularFileIssue);
    }

    entries.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      crc32,
      flags,
      localHeaderOffset,
      isDirectory,
      isUnixSymlink,
      isUnixNonRegularFile,
    });

    idx = recordEnd;
  }
  if (idx !== cd.byteLength) {
    return { ok: false, issues: [issue('BUNDLE_ZIP_INVALID', 'Corrupt central directory: trailing bytes after the declared entry count.')] };
  }

  return { ok: true, entries, issues };
}

/**
 * Locates and parses a ZIP's EOCD record and central directory via `readRange`, bounding both the
 * entry count and the central directory's own byte size before ever reading it in full. Rejects
 * Zip64 and multi-disk archives outright (fail closed — out of scope, ledger F49) rather than
 * attempting to support them partially.
 */
export async function readCentralDirectory(
  readRange: RangeReader,
  objectSize: number,
  limits: CentralDirectoryLimits
): Promise<CentralDirectoryResult> {
  const located = await locateAndReadCentralDirectory(readRange, objectSize, limits);
  if (!located.ok) return located;

  const parsed = parseCentralDirectoryRecords(located.cd, located.totalEntries, objectSize);
  if (!parsed.ok) return parsed;

  return { ok: true, entries: parsed.entries, centralDirectoryOffset: located.centralDirOffset, issues: parsed.issues };
}
