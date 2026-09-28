/**
 * A streaming ZIP reader for the capture-sources bundle route
 * (`/upload/:project/:version/bundle/complete`), built to survive an arbitrary customer-uploaded
 * ZIP inside a Cloudflare Worker's ~128 MB isolate (ledger F11, F31, F32, F49).
 *
 * Two passes, neither of which ever buffers the whole (possibly huge) object:
 *
 *   1. `central-directory.ts` range-GETs just the ZIP's TAIL (the end-of-central-directory record,
 *      then the central directory itself) and parses every entry's name, compression method, REAL
 *      sizes, CRC-32, and local-header offset straight from it — the sole source of truth this
 *      reader trusts for what an entry's data actually is. This matters because `archiver` (what our
 *      own CLI and sbcov build bundles with) sets general-purpose flag bit 3 ("data descriptor
 *      follows") on every entry, which zeroes out that entry's size/CRC fields in its LOCAL header;
 *      the central directory's copies are always correct regardless (ledger F49).
 *   2. This module then makes a genuine single forward pass over the object's byte stream (never a
 *      seek): for each central directory entry, in ascending local-header-offset order, it reads
 *      just enough of the LOCAL header to know the name/extra field lengths (never trusting its
 *      size/CRC fields), skips past them, decompresses exactly the central directory's declared
 *      `compressedSize` bytes (`DecompressionStream('deflate-raw')` for DEFLATE, a straight copy for
 *      STORED), and — if flag bit 3 is set — skips the trailing data descriptor afterwards. The
 *      **real, measured** decompressed byte count is checked after every chunk — never a declared
 *      size — against: the central directory's own declared size (a real decompressor producing more
 *      than that is a lying/corrupt entry), a per-entry cap, a running total-bytes cap across the
 *      whole bundle, and a compression-ratio cap computed from real bytes produced vs. real
 *      compressed bytes consumed so far. The read aborts the moment any of these is exceeded — the
 *      ZIP bomb never finishes decompressing, let alone gets held in memory.
 *
 * Additional integrity checks, all cheap (no extra buffering): a LOCAL header whose name disagrees
 * with the central directory's is rejected outright (the classic "parser confusion" attack, where
 * different tools reading the same ZIP via different headers disagree about what a given entry is);
 * each local file header is expected at exactly the byte offset the central directory declared for
 * it (no seeking — this cursor only ever reads forward — but a mismatch means the ZIP's local data
 * doesn't actually match its own central directory, so the whole read aborts); a present data
 * descriptor's own compressed/uncompressed size fields are cross-checked against the central
 * directory's; and the real decompressed content's CRC-32 is compared against the central
 * directory's declared CRC-32.
 *
 * Only a bounded amount of each entry's real content is ever kept — and, critically (ledger F60),
 * only a bounded amount is ever held AT ONCE, not summed forever across the whole bundle:
 *   - `scf.json`: kept in full, capped at `maxScfJsonBytes` (16 MiB) — the manifest is genuinely
 *     needed whole by `validateBundle` afterwards.
 *   - `structure/*.json` and `source/*`: the instant one of these is fully inflated (still capped per
 *     entry at `maxNonImageEntryBytes`, same as before), its content is run through `@scrymore/scf`'s
 *     own `checkStructureMember`/`checkSourceTextMember` — the exact content checks `validateBundle`
 *     would otherwise apply — and the bytes are then DISCARDED, replaced in `files` with a
 *     `{checked: true, size}` stand-in (`BundleFileChecked`). This is the fix for F60's actual repro:
 *     a 225-story Storybook's structure trees alone can run 100s of MB in aggregate, and the route
 *     used to keep every one of them in memory until the whole-bundle `validateBundle` call.
 *   - Every other non-image member (sidecar JSON, e.g. `images/x.json` in sidecar-capture mode): kept
 *     in full, each still capped individually at `maxNonImageEntryBytes`, but ALSO summed against a
 *     much tighter aggregate `maxSidecarsTotalBytes` (16 MiB) — these are index-only per-image
 *     metadata and have no legitimate reason to add up to much.
 *   - Images: ledger F69 (a THIRD recurrence of F32/F60's own root cause — F32 covered the whole
 *     bundle, F60 covered structure/source, this is the image category F60 explicitly left exposed):
 *     the previous `{head, size}` fix (F31/F32/F50) still retained an image's ENTIRE content whenever
 *     its real size was at or under `imageHeadBytes` (64 KiB) — no aggregate cap of its own meant an
 *     8,000-entry bundle of honest, individually-tiny images could add up to ~500 MB of live retained
 *     memory. Fixed: only up to `imageHeadBytes` of an image's real bytes is ever buffered, and only
 *     TRANSIENTLY, during that one entry's own decompression (`entryState.headChunks`, discarded the
 *     instant this entry finishes, never summed across entries) — the instant the entry finishes, that
 *     transient prefix is fed to `@scrymore/scf`'s own `measureImage()` (magic-byte family detection +
 *     a header-only dimension read, combined) and then thrown away entirely, replaced in `files` with
 *     a `{measured: true, family, width, height, size}` stand-in (`BundleFileMeasured`) — a handful of
 *     small fields, never bytes. `validateBundle` applies the exact same format/size/dimension rules
 *     to that record as it would a full image.
 *
 * Two classes of problem are reported this way: (1) structural issues found without needing to abort
 * the whole read (unsafe paths, symlinks) are collected into `issues` and the read continues, so a
 * bundle with several bad entries gets every one of them back in a single response; (2) a real bomb /
 * cap breach / integrity mismatch throws immediately, aborting the whole read with that one issue —
 * there is no value in continuing to read a request that has already proven itself hostile or corrupt.
 */
import { ByteCursor } from './byte-cursor.js';
import { CRC32_SEED, crc32Final, crc32Update } from './crc32.js';
import { readCentralDirectory, type CentralDirectoryEntry, type CentralDirectoryIssue } from './central-directory.js';
import type { StorageObjectRange } from '../services/storage/storage.service.js';
import { checkSourceTextMember, checkStructureMember, measureImage } from '../vendor/scf/dist/index.js';
import type { BundleFiles } from '../vendor/scf/dist/index.js';

export interface BoundedZipLimits {
  /** Central directory entry count above which the ZIP is rejected outright (no per-entry detail). */
  maxEntries: number;
  /** Upper bound on the central directory's own declared byte size (contract §9: bounds the range-GET
   *  and the memory it's held in before this reader ever streams a single local entry — ledger F49). */
  maxCentralDirectoryBytes: number;
  /** How far back from the end of the object to search for the end-of-central-directory record. */
  maxEocdSearchBytes: number;
  /** Sum of every entry's REAL (measured, not declared) decompressed bytes, across the whole ZIP —
   *  a CPU/time bound: even entries that each individually pass `maxImageEntryBytes` /
   *  `maxNonImageEntryBytes` could otherwise be repeated enough times to still cost gigabytes of
   *  decompression work. */
  maxTotalUncompressedBytes: number;
  /** Real decompressed bytes / real compressed bytes consumed so far, per entry, above which an
   *  entry is treated as a zip bomb — the second, cheaper-to-trip signal alongside the absolute
   *  per-entry caps below. */
  maxCompressionRatio: number;
  /** REAL decompressed bytes cap for an image-extension entry (only its head is ever retained, but
   *  its real size is still measured and bounded — matches the vendored validator's own
   *  `MAX_IMAGE_BYTES`, so a bomb disguised as an image can never inflate past what a legitimate
   *  image could ever validly be). */
  maxImageEntryBytes: number;
  /** REAL decompressed bytes cap for a single `structure/*.json`/`source/*` member (checked then
   *  discarded, ledger F60 — this is the peak transient memory cost of checking ONE such member, never
   *  a running total) or a single sidecar JSON member (kept in full). Comfortably above the vendored
   *  validator's own hard per-field caps (structure 10 MB, sourceText 1 MB) so this is a backstop, not
   *  a tighter re-implementation of those. */
  maxNonImageEntryBytes: number;
  /** REAL decompressed bytes cap for `scf.json` specifically (kept in full — the manifest is needed
   *  whole by `validateBundle`) — ledger F60. Deliberately larger than `maxNonImageEntryBytes` since a
   *  bundle with hundreds of captures can have a legitimately larger manifest than any one sidecar. */
  maxScfJsonBytes: number;
  /** Sum of every sidecar JSON member's REAL decompressed bytes (kept in full, unlike
   *  `structure/*.json`/`source/*`, which are discarded after checking) — ledger F60. Much tighter
   *  than `maxTotalUncompressedBytes` because these are index-only per-image metadata with no
   *  legitimate reason to add up to much, and — unlike structure/source — this route has no
   *  check-then-discard mechanism for them to fall back on. */
  maxSidecarsTotalBytes: number;
  /** Total raw bytes read from the underlying stream (the ZIP object itself, still compressed) —
   *  independent of any ZIP metadata, this is the caller's own bound on how much of the R2 object
   *  it will ever pull down for one request. */
  maxRawBytes: number;
  /** How many of an image entry's real decompressed bytes to buffer TRANSIENTLY, during that one
   *  entry's own decompression, before feeding them to `measureImage()` and discarding them — enough
   *  for magic-byte family detection and a header-only PNG/JPEG/WebP dimension read (ledger F69). This
   *  bounds a per-entry, in-flight buffer, never anything retained in `files` afterwards — the
   *  persisted `{measured, ...}` record is a handful of fields, not bytes. */
  imageHeadBytes: number;
}

export interface BoundedZipIssue {
  code: string;
  path?: string;
  message: string;
}

export type BoundedZipResult =
  | { ok: true; files: BundleFiles; warnings: BoundedZipIssue[] }
  | { ok: false; issues: BoundedZipIssue[] };

export const DEFAULT_BOUNDED_ZIP_LIMITS: BoundedZipLimits = {
  maxEntries: 20_000,
  maxCentralDirectoryBytes: 8 * 1024 * 1024, // 8 MiB — generous for 20,000 entries' worth of headers
  maxEocdSearchBytes: 22 + 0xffff, // the format's own worst case: fixed record + max comment
  maxTotalUncompressedBytes: 1024 * 1024 * 1024, // 1 GiB
  maxCompressionRatio: 200,
  maxImageEntryBytes: 20 * 1024 * 1024, // matches @scrymore/scf's MAX_IMAGE_BYTES
  maxNonImageEntryBytes: 12 * 1024 * 1024,
  maxScfJsonBytes: 16 * 1024 * 1024,
  maxSidecarsTotalBytes: 16 * 1024 * 1024,
  maxRawBytes: 1024 * 1024 * 1024, // 1 GiB
  imageHeadBytes: 64 * 1024,
};

const LOCAL_FILE_SIGNATURE = 0x04034b50;
/** Optional signature word at the start of a data descriptor — most real writers (including
 *  `archiver`) include it, though the ZIP spec allows omitting it. */
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
/** ZIP general-purpose flag bit 3: sizes/CRC are unknown in the local header and follow the entry's
 *  data in a trailing data descriptor instead. This reader no longer needs those local-header fields
 *  at all (the central directory's copies are authoritative — ledger F49) — this flag now only says
 *  whether a data descriptor needs to be skipped after the entry's data. */
const STREAMING_DATA_DESCRIPTOR_FLAG = 0x0008;
const IMAGE_LIKE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);
/** A ratio check below this many real compressed bytes consumed is too noisy to trust (a handful
 *  of DEFLATE's own framing bytes can look like an enormous "ratio" before any real content has
 *  flowed) — matches this reader's own `imageHeadBytes` order of magnitude. */
const MIN_BYTES_FOR_RATIO_CHECK = 4096;

class BundleZipLimitError extends Error {
  constructor(
    public readonly issueCode: string,
    message: string,
    public readonly path?: string
  ) {
    super(message);
  }
}

function issue(code: string, message: string, path?: string): BoundedZipIssue {
  return path !== undefined ? { code, message, path } : { code, message };
}

/** An unsafe raw ZIP member name: absolute, a backslash, a Windows drive letter, a NUL byte, empty,
 *  over a generous length, or containing a "." / ".." path segment. */
function isUnsafeZipMemberName(name: string): boolean {
  if (name.length === 0 || name.length > 1024) return true;
  if (name.startsWith('/') || name.includes('\\') || /^[A-Za-z]:/.test(name) || name.includes('\0')) return true;
  return name.split('/').some((seg) => seg === '.' || seg === '..');
}

function extOf(name: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

function isImageLikeName(name: string): boolean {
  return IMAGE_LIKE_EXTENSIONS.has(extOf(name));
}

/** Mirrors `@scrymore/scf`'s own `isCheckableStructureOrSourcePath` (validate.ts) exactly — the two
 *  prefixes its `{checked: true, size}` shape is accepted for (ledger F60). Kept in sync by hand since
 *  that helper isn't itself exported from the package (only `checkStructureMember`/
 *  `checkSourceTextMember`, which this module calls directly). */
function isCheckedMemberPath(name: string): boolean {
  return (name.startsWith('structure/') && extOf(name) === 'json') || name.startsWith('source/');
}

/**
 * Which of the four memory-handling strategies (ledger F60, see this module's own doc comment) a
 * member's raw ZIP path falls into. `scf.json` and the checked-member prefixes take priority over the
 * generic "image" check purely for clarity of intent — in practice none of the SCF-reserved prefixes
 * overlap with an image extension, so the order rarely matters.
 */
type MemberCategory = 'image' | 'scfJson' | 'checkedMember' | 'sidecar';

function categorizeMember(name: string): MemberCategory {
  if (name === 'scf.json') return 'scfJson';
  if (isCheckedMemberPath(name)) return 'checkedMember';
  if (isImageLikeName(name)) return 'image';
  return 'sidecar';
}

function concatUint8(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

async function mustTake(cursor: ByteCursor, n: number): Promise<Buffer> {
  const bytes = await cursor.take(n);
  if (bytes === null) throw new Error('Unexpected end of ZIP data while parsing a header.');
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

async function skipRawBytes(cursor: ByteCursor, n: number): Promise<void> {
  let remaining = n;
  while (remaining > 0) {
    const chunk = await cursor.takeUpTo(remaining);
    if (chunk === null) throw new Error('Unexpected end of ZIP data while skipping an entry.');
    remaining -= chunk.byteLength;
  }
}

interface EntryScanState {
  path: string;
  category: MemberCategory;
  declaredUncompressedSize: number;
  perEntryCap: number;
  realBytes: number;
  headChunks: Uint8Array[];
  headFilled: number;
  fullChunks: Uint8Array[];
  crcState: number;
}

/** Real decompressed bytes summed across the whole ZIP so far — `realBytes` against
 *  `maxTotalUncompressedBytes` (every member) and `sidecarBytes` against `maxSidecarsTotalBytes`
 *  (sidecar-category members only, ledger F60) are independent running totals. */
interface TotalScanState {
  realBytes: number;
  sidecarBytes: number;
}

/** Called with every chunk of an entry's REAL decompressed output, in order, as it is produced.
 *  Throws a `BundleZipLimitError` the instant any bound is exceeded — the caller (both the STORED
 *  and DEFLATE consumers below) lets that propagate straight out, aborting the whole read. */
function accumulateChunk(
  entryState: EntryScanState,
  totalState: TotalScanState,
  limits: BoundedZipLimits,
  chunk: Uint8Array,
  compressedConsumedSoFar: number
): void {
  entryState.realBytes += chunk.byteLength;
  totalState.realBytes += chunk.byteLength;
  entryState.crcState = crc32Update(entryState.crcState, chunk);

  if (entryState.category === 'image') {
    if (entryState.headFilled < limits.imageHeadBytes) {
      const room = limits.imageHeadBytes - entryState.headFilled;
      const slice = chunk.byteLength <= room ? chunk : chunk.subarray(0, room);
      entryState.headChunks.push(slice);
      entryState.headFilled += slice.byteLength;
    }
    // Bytes beyond imageHeadBytes are counted above (for the caps below) but never retained.
  } else {
    // scf.json, a checked-then-discarded structure/source member (still needs its full bytes
    // transiently to run checkStructureMember/checkSourceTextMember, ledger F60), or a sidecar: all
    // three accumulate in full for now — what happens to `fullChunks` once the entry finishes is
    // `processEntry`'s decision, not this function's.
    entryState.fullChunks.push(chunk);
  }

  if (entryState.realBytes > entryState.declaredUncompressedSize) {
    throw new BundleZipLimitError(
      'BUNDLE_SIZE_MISMATCH',
      `ZIP entry decompresses to more bytes than the central directory's declared uncompressed size (${entryState.declaredUncompressedSize}): ${entryState.path}`,
      entryState.path
    );
  }
  if (entryState.realBytes > entryState.perEntryCap) {
    throw new BundleZipLimitError(
      entryState.category === 'image' ? 'IMAGE_TOO_LARGE' : 'BUNDLE_MEMBER_TOO_LARGE',
      `ZIP entry's real decompressed size exceeds the ${entryState.perEntryCap} byte per-entry limit: ${entryState.path}`,
      entryState.path
    );
  }
  if (totalState.realBytes > limits.maxTotalUncompressedBytes) {
    throw new BundleZipLimitError(
      'BUNDLE_TOO_LARGE',
      `ZIP's total real decompressed size exceeds the ${limits.maxTotalUncompressedBytes} byte limit.`,
      entryState.path
    );
  }
  if (entryState.category === 'sidecar') {
    // Ledger F60: sidecars have no check-then-discard mechanism to fall back on (unlike structure/
    // source), so they get their own, much tighter aggregate instead — index-only per-image metadata
    // has no legitimate reason to add up to much.
    totalState.sidecarBytes += chunk.byteLength;
    if (totalState.sidecarBytes > limits.maxSidecarsTotalBytes) {
      throw new BundleZipLimitError(
        'BUNDLE_SIDECARS_TOO_LARGE',
        `ZIP's sidecar JSON members total more than the ${limits.maxSidecarsTotalBytes} byte limit.`,
        entryState.path
      );
    }
  }
  if (
    compressedConsumedSoFar >= MIN_BYTES_FOR_RATIO_CHECK &&
    entryState.realBytes / compressedConsumedSoFar > limits.maxCompressionRatio
  ) {
    throw new BundleZipLimitError(
      'BUNDLE_COMPRESSION_RATIO',
      `ZIP entry's real compression ratio exceeds the ${limits.maxCompressionRatio}x limit: ${entryState.path}`,
      entryState.path
    );
  }
}

/** STORED (compressionMethod 0): output is exactly the raw bytes, so no amplification is possible —
 *  this still routes through `onChunk` so the same caps/bookkeeping apply uniformly. */
async function consumeStoredEntry(
  cursor: ByteCursor,
  compressedSize: number,
  onChunk: (chunk: Uint8Array, compressedConsumedSoFar: number) => void
): Promise<void> {
  let remaining = compressedSize;
  let consumed = 0;
  while (remaining > 0) {
    const chunk = await cursor.takeUpTo(remaining);
    if (chunk === null) throw new Error('Unexpected end of ZIP data while reading a STORED entry.');
    remaining -= chunk.byteLength;
    consumed += chunk.byteLength;
    onChunk(chunk, consumed);
  }
}

/**
 * DEFLATE (compressionMethod 8): feeds exactly `compressedSize` raw bytes into
 * `DecompressionStream('deflate-raw')` and drains its output concurrently, so a huge amplification
 * factor never has to sit fully decompressed anywhere — `onChunk` (and therefore the caller's caps)
 * sees each decompressed chunk as it is produced, and can abort mid-entry by throwing.
 *
 * The write side and the read side run concurrently (not write-everything-then-read): a
 * `TransformStream`'s own backpressure means `writer.write()` won't resolve once its internal queue
 * is full, so if these ran sequentially instead, a large or bomb-like entry could deadlock — never
 * finishing the write, so the read loop that would drain it never even starts.
 */
async function consumeDeflateEntry(
  cursor: ByteCursor,
  compressedSize: number,
  onChunk: (chunk: Uint8Array, compressedConsumedSoFar: number) => void
): Promise<void> {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  let failure: unknown = null;
  let compressedConsumed = 0;
  const fail = (e: unknown): void => {
    if (failure === null) failure = e;
  };

  const writeTask = (async (): Promise<void> => {
    let remaining = compressedSize;
    while (remaining > 0 && failure === null) {
      let chunk: Uint8Array | null;
      try {
        chunk = await cursor.takeUpTo(remaining);
      } catch (e) {
        fail(e);
        break;
      }
      if (chunk === null) {
        fail(new Error('Unexpected end of ZIP data while reading a DEFLATE entry.'));
        break;
      }
      remaining -= chunk.byteLength;
      try {
        // `DecompressionStream`'s `writable` side is typed to require `BufferSource`, which (under
        // TS 5.7+'s generic typed arrays) excludes a `Uint8Array` whose backing buffer could be a
        // `SharedArrayBuffer`. Every chunk here is genuinely `ArrayBuffer`-backed (it comes from
        // `ByteCursor`, which only ever slices/allocates plain `Uint8Array`s), so this is a safe
        // narrowing cast, not a workaround for a real type mismatch.
        await writer.write(chunk as Uint8Array<ArrayBuffer>);
        compressedConsumed += chunk.byteLength;
      } catch (e) {
        fail(e);
        break;
      }
    }
    if (failure === null) {
      try {
        await writer.close();
      } catch (e) {
        fail(e);
      }
    } else {
      await writer.abort(failure).catch(() => undefined);
    }
  })();

  const readTask = (async (): Promise<void> => {
    for (;;) {
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await reader.read();
      } catch (e) {
        fail(e);
        break;
      }
      if (step.done) break;
      if (step.value && step.value.byteLength > 0) {
        // `compressedConsumed` is updated by the write side as it feeds input; because the write
        // and read loops run concurrently, it may already include a little more than what strictly
        // produced THIS chunk (a write can resolve before its output is fully drained). That only
        // ever makes the ratio look a bit LOWER than the true instantaneous value — never masks a
        // real bomb, since the absolute per-entry/total caps in `onChunk` are the hard backstop
        // either way.
        try {
          onChunk(step.value, compressedConsumed);
        } catch (e) {
          fail(e);
          break;
        }
      }
      if (failure !== null) break;
    }
    await reader.cancel(failure ?? undefined).catch(() => undefined);
  })();

  await Promise.all([writeTask, readTask]);
  if (failure !== null) throw failure;
}

/** Reads a data descriptor (12 bytes, or 16 with the optional signature word) immediately following
 *  an entry's data when its general-purpose flag bit 3 is set, and cross-checks its size fields
 *  against the central directory's own declared values (ledger F49: "verify the data descriptor ...
 *  if cheap") — a disagreement between an entry's own trailing descriptor and its central directory
 *  record means the ZIP is corrupt or was tampered with in transit. */
async function skipAndVerifyDataDescriptor(cursor: ByteCursor, entry: CentralDirectoryEntry): Promise<void> {
  const first = await mustTake(cursor, 4);
  let compressedSize: number;
  let uncompressedSize: number;
  if (first.readUInt32LE(0) === DATA_DESCRIPTOR_SIGNATURE) {
    // [signature(already read)][crc-32(4)][compressed size(4)][uncompressed size(4)].
    const rest = await mustTake(cursor, 12);
    compressedSize = rest.readUInt32LE(4);
    uncompressedSize = rest.readUInt32LE(8);
  } else {
    // No signature word: `first` was actually the CRC-32 field itself, immediately followed by
    // [compressed size(4)][uncompressed size(4)].
    const rest = await mustTake(cursor, 8);
    compressedSize = rest.readUInt32LE(0);
    uncompressedSize = rest.readUInt32LE(4);
  }
  if (compressedSize !== entry.compressedSize || uncompressedSize !== entry.uncompressedSize) {
    throw new BundleZipLimitError(
      'BUNDLE_ZIP_INVALID',
      `ZIP entry's data descriptor disagrees with its central directory record: ${entry.name}`,
      entry.name
    );
  }
}

/** Skips an entry's raw data (and its trailing data descriptor, if any) without decompressing it —
 *  used for an entry this reader has already decided to reject (unsafe path, symlink, unsupported
 *  compression method) but must still walk past byte-for-byte to keep the stream aligned with the
 *  central directory's offsets for every entry after it. */
async function skipEntryData(cursor: ByteCursor, entry: CentralDirectoryEntry): Promise<void> {
  if (entry.compressedSize > 0) await skipRawBytes(cursor, entry.compressedSize);
  if ((entry.flags & STREAMING_DATA_DESCRIPTOR_FLAG) !== 0) {
    await skipAndVerifyDataDescriptor(cursor, entry);
  }
}

async function processEntry(
  cursor: ByteCursor,
  entry: CentralDirectoryEntry,
  limits: BoundedZipLimits,
  issues: BoundedZipIssue[],
  warnings: BoundedZipIssue[],
  files: BundleFiles,
  totalState: TotalScanState
): Promise<void> {
  if (cursor.position !== entry.localHeaderOffset) {
    throw new Error(
      `Corrupt ZIP: expected entry ${JSON.stringify(entry.name)}'s local file header at byte offset ${entry.localHeaderOffset} (the central directory's declared offset), but the stream was at ${cursor.position}.`
    );
  }

  const sig = await mustTake(cursor, 4);
  if (sig.readUInt32LE(0) !== LOCAL_FILE_SIGNATURE) {
    throw new Error(`Corrupt ZIP: no local file header signature at offset ${entry.localHeaderOffset} for entry ${JSON.stringify(entry.name)}.`);
  }
  const fixed = await mustTake(cursor, 26); // local header fields after the 4-byte signature
  const nameLen = fixed.readUInt16LE(22);
  const extraLen = fixed.readUInt16LE(24);

  const nameBuf = await mustTake(cursor, nameLen);
  const localName = nameBuf.toString('utf8');
  if (extraLen > 0) await mustTake(cursor, extraLen); // discard; unused

  // ledger F49: a local header that disagrees with the central directory about an entry's own name
  // is the classic "parser confusion" shape (different consumers of the same ZIP, reading different
  // headers, disagreeing about what a given entry even is) — reject outright rather than guess which
  // header to believe.
  if (localName !== entry.name) {
    throw new BundleZipLimitError(
      'BUNDLE_NAME_MISMATCH',
      `ZIP entry's local file header name (${JSON.stringify(localName)}) does not match its central directory name (${JSON.stringify(entry.name)}).`,
      entry.name
    );
  }

  if (entry.isDirectory) {
    // Directory entries carry no data of their own (archiver's own output confirms this), but stay
    // in sync with whatever the central directory declares rather than assuming zero.
    await skipEntryData(cursor, entry);
    return;
  }
  if (entry.isUnixNonRegularFile) {
    // Already reported by `readCentralDirectory` (BUNDLE_SYMLINK_REJECTED or BUNDLE_NON_REGULAR_FILE,
    // ledger F61 — computed from the Unix mode bits alone, never gated on the "version made by" host
    // byte); just walk past its data.
    await skipEntryData(cursor, entry);
    return;
  }
  if (isUnsafeZipMemberName(entry.name)) {
    issues.push(
      issue(
        'BUNDLE_UNSAFE_PATH',
        `ZIP entry has an unsafe path (absolute, backslash, drive letter, or "." / ".." segment): ${JSON.stringify(entry.name)}`,
        entry.name
      )
    );
    await skipEntryData(cursor, entry);
    return;
  }
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    issues.push(issue('BUNDLE_ZIP_INVALID', `Unsupported ZIP compression method ${entry.compressionMethod}: ${entry.name}`, entry.name));
    await skipEntryData(cursor, entry);
    return;
  }

  const category = categorizeMember(entry.name);
  const perEntryCap =
    category === 'image' ? limits.maxImageEntryBytes : category === 'scfJson' ? limits.maxScfJsonBytes : limits.maxNonImageEntryBytes;
  const entryState: EntryScanState = {
    path: entry.name,
    category,
    declaredUncompressedSize: entry.uncompressedSize,
    perEntryCap,
    realBytes: 0,
    headChunks: [],
    headFilled: 0,
    fullChunks: [],
    crcState: CRC32_SEED,
  };
  const onChunk = (chunk: Uint8Array, compressedConsumedSoFar: number): void =>
    accumulateChunk(entryState, totalState, limits, chunk, compressedConsumedSoFar);

  if (entry.compressionMethod === 0) {
    await consumeStoredEntry(cursor, entry.compressedSize, onChunk);
  } else {
    await consumeDeflateEntry(cursor, entry.compressedSize, onChunk);
  }

  if (entryState.realBytes !== entry.uncompressedSize) {
    // A real decompressor producing FEWER bytes than declared is just as much a mismatch as more
    // (the `>` check inside accumulateChunk only ever catches "too many", mid-stream); this is the
    // "too few" half of the same integrity check, checked once the entry's data is fully consumed.
    throw new BundleZipLimitError(
      'BUNDLE_SIZE_MISMATCH',
      `ZIP entry decompresses to ${entryState.realBytes} bytes, not the central directory's declared ${entry.uncompressedSize}: ${entry.name}`,
      entry.name
    );
  }

  if ((entry.flags & STREAMING_DATA_DESCRIPTOR_FLAG) !== 0) {
    await skipAndVerifyDataDescriptor(cursor, entry);
  }

  // ledger F49: "verify ... CRC if cheap" — a single table lookup per byte, already paid for as the
  // entry streamed through `accumulateChunk`; finalize and compare now that all of it has arrived.
  const realCrc32 = crc32Final(entryState.crcState);
  if (realCrc32 !== entry.crc32) {
    throw new BundleZipLimitError(
      'BUNDLE_CRC_MISMATCH',
      `ZIP entry's real CRC-32 (0x${realCrc32.toString(16)}) does not match the central directory's declared CRC-32 (0x${entry.crc32.toString(16)}): ${entry.name}`,
      entry.name
    );
  }

  if (entryState.category === 'image') {
    // Ledger F69: `headChunks` is only ever the TRANSIENT prefix accumulated during this one entry's
    // own decompression (never summed across entries, and this local `prefixBytes` value itself
    // becomes garbage the moment this block returns) — `measureImage` turns it into a small,
    // fixed-size record, and only that record (never the bytes) is retained in `files` from here on.
    // A `null` result (family unidentifiable, or identifiable but dimensions unreadable from this
    // bounded prefix — see `measureImage`'s own doc comment for why those collapse together) is
    // still recorded as `family: null`, letting `validateBundle` reject it the same way it would an
    // unreadable/wrong-format full image.
    const prefixBytes = concatUint8(entryState.headChunks);
    const measured = measureImage(prefixBytes);
    files.set(entry.name, {
      measured: true,
      family: measured?.family ?? null,
      width: measured?.width ?? 0,
      height: measured?.height ?? 0,
      size: entryState.realBytes,
    });
    return;
  }

  if (entryState.category === 'checkedMember') {
    // Ledger F60: run the exact content checks validateBundle would otherwise apply (moved into
    // @scrymore/scf as checkStructureMember/checkSourceTextMember precisely for this), record whatever
    // they find as ordinary read issues (the same "collected, read continues" bucket as an unsafe path
    // or a symlink above), and then let `fullBytes` — and every chunk that built it — be freed: only a
    // few bytes (`{checked: true, size}`) are ever retained for this member from this point on, not its
    // content. `optedIn: true` in the sourceText case mirrors validateBundle's own call — the aggregate
    // SOURCE_TEXT_NOT_OPT_IN check (once the whole manifest is known) is always the source of truth,
    // never this per-member fast path; see checkSourceTextMember's own doc comment.
    const fullBytes = concatUint8(entryState.fullChunks);
    const result = entry.name.startsWith('structure/')
      ? checkStructureMember(entry.name, fullBytes)
      : checkSourceTextMember(entry.name, fullBytes, true);
    for (const e of result.errors) issues.push(issue(e.code, e.message, e.path));
    for (const w of result.warnings) warnings.push(issue(w.code, w.message, w.path));
    files.set(entry.name, { checked: true, size: entryState.realBytes });
    return;
  }

  // scf.json or a sidecar JSON member: kept in full, per this module's own doc comment.
  files.set(entry.name, concatUint8(entryState.fullChunks));
}

/**
 * The forward streaming pass over a ZIP's local entries, given the entries already parsed from its
 * central directory (`readCentralDirectory`). Exported mainly for tests that want to exercise this
 * pass directly against an in-memory buffer's own (also locally-parsed) central directory; real
 * callers should use `readBoundedZip` below.
 */
export async function readBoundedZipEntries(
  stream: ReadableStream<Uint8Array>,
  entries: CentralDirectoryEntry[],
  centralDirectoryOffset: number,
  limits: BoundedZipLimits = DEFAULT_BOUNDED_ZIP_LIMITS,
  centralDirectoryIssues: CentralDirectoryIssue[] = []
): Promise<BoundedZipResult> {
  const cursor = new ByteCursor(stream);
  try {
    const issues: BoundedZipIssue[] = [...centralDirectoryIssues];
    // Ledger F60: warnings surfaced by checkStructureMember/checkSourceTextMember on a checked-then-
    // discarded member (e.g. STRUCTURE_TREE_LARGE) — never cause rejection, but are worth carrying
    // through to the final response the same way validateBundle's own `warnings` would have, had the
    // member's full bytes still been around for it to see.
    const warnings: BoundedZipIssue[] = [];
    const files: BundleFiles = new Map();
    const totalState: TotalScanState = { realBytes: 0, sidecarBytes: 0 };

    // ascending local-header-offset order: this reader only ever moves forward, so a corrupt or
    // adversarial central directory that lists entries out of physical order (or aliases two
    // entries onto the same offset) is caught by `processEntry`'s own position check below, not by
    // sorting away the anomaly.
    const ordered = [...entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);

    for (const entry of ordered) {
      if (cursor.position > limits.maxRawBytes) {
        throw new BundleZipLimitError('BUNDLE_TOO_LARGE', `ZIP object exceeds the ${limits.maxRawBytes} raw byte limit.`);
      }
      await processEntry(cursor, entry, limits, issues, warnings, files, totalState);
    }

    if (cursor.position !== centralDirectoryOffset) {
      throw new Error(
        `Corrupt ZIP: local entries ended at byte offset ${cursor.position}, not the central directory's declared start (${centralDirectoryOffset}).`
      );
    }

    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, files, warnings };
  } catch (e) {
    if (e instanceof BundleZipLimitError) {
      return { ok: false, issues: [issue(e.issueCode, e.message, e.path)] };
    }
    return { ok: false, issues: [issue('BUNDLE_ZIP_INVALID', `Corrupt or truncated ZIP: ${(e as Error).message}`)] };
  } finally {
    // Deliberately never reads through to the object's own trailing central directory/EOCD bytes —
    // those were already fetched via a targeted range-GET, not this stream. Cancelling here as soon
    // as every local entry is accounted for lets the underlying connection close early instead of
    // paying to transfer bytes this reader already has.
    await cursor.cancel().catch(() => undefined);
  }
}

/** Minimal shape this module needs from a `StorageService` — just enough to range-GET the tail and
 *  then open a full stream, so tests can pass a lighter double than the whole interface. */
export interface BoundedZipStorage {
  getObjectRange(key: string, range: StorageObjectRange): Promise<Uint8Array | null>;
  getObjectStream(key: string): Promise<ReadableStream | null>;
}

/**
 * Reads an SCF bundle ZIP object from storage into a bundle-relative path -> bytes map, enforcing
 * `limits` (ledger F11, F31, F32, F49). `objectSize` must be the object's real, already-HEAD-checked
 * size (the caller in `app.ts` already needs this for its own size cap, so this never HEADs again).
 */
export async function readBoundedZip(
  storage: BoundedZipStorage,
  key: string,
  objectSize: number,
  limits: BoundedZipLimits = DEFAULT_BOUNDED_ZIP_LIMITS
): Promise<BoundedZipResult> {
  const centralDirectory = await readCentralDirectory((range) => storage.getObjectRange(key, range), objectSize, limits);
  if (!centralDirectory.ok) return { ok: false, issues: centralDirectory.issues };

  if (centralDirectory.entries.length === 0) {
    // Nothing to stream — a zero-entry archive never needs to open the (potentially large) object
    // stream at all.
    if (centralDirectory.issues.length > 0) return { ok: false, issues: centralDirectory.issues };
    return { ok: true, files: new Map(), warnings: [] };
  }

  const stream = await storage.getObjectStream(key);
  if (!stream) {
    return { ok: false, issues: [issue('BUNDLE_ZIP_INVALID', 'Bundle object disappeared between reading its central directory and opening its full stream.')] };
  }

  return readBoundedZipEntries(stream, centralDirectory.entries, centralDirectory.centralDirectoryOffset, limits, centralDirectory.issues);
}
