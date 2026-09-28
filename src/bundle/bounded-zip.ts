/**
 * A streaming ZIP reader for the capture-sources bundle route
 * (`/upload/:project/:version/bundle/complete`), built to survive an arbitrary customer-uploaded
 * ZIP inside a Cloudflare Worker's ~128 MB isolate (ledger F11, F31, F32).
 *
 * This is a genuine single forward pass over the R2 object's byte stream — never a seek, never a
 * whole-buffer read:
 *
 *   - Local file headers (name, compression method, declared sizes) are parsed as they arrive.
 *     Path traversal / absolute / backslash / drive-letter / NUL / "." / ".." names are rejected
 *     the moment the name is read, before a single byte of that entry's data is decompressed.
 *   - Each entry's data is decompressed incrementally (`DecompressionStream('deflate-raw')` for
 *     DEFLATE, a straight copy for STORED), and the **real, measured** decompressed byte count is
 *     checked after every chunk — never the ZIP's own declared `uncompressedSize` — against: the
 *     entry's own declared size (a real decompressor producing more than the entry itself claimed
 *     is a lying/corrupt entry, ledger F31's exact repro), a per-entry cap, a running total-bytes
 *     cap across the whole bundle, and a compression-ratio cap computed from real bytes produced
 *     vs. real compressed bytes consumed so far. The read aborts the moment any of these is
 *     exceeded — the ZIP bomb never finishes decompressing, let alone gets held in memory.
 *   - Only a bounded amount of each entry's real content is ever kept: the full bytes for a
 *     non-image member (`scf.json`, `structure/*.json`, `source/*`, sidecar JSON), capped at
 *     `maxNonImageEntryBytes`; for an image, only its first `imageHeadBytes` (default 64 KiB —
 *     enough for magic-byte family detection and a header-only dimension read, see
 *     `@scrymore/scf`'s `image-dimensions.ts`) plus its real total size, as a `{head, size}` pair
 *     (see `@scrymore/scf`'s `BundleFileBytes`). Bytes beyond the head are counted (for the caps
 *     above) but never retained.
 *   - The ZIP's central directory (which immediately follows the local entries in the byte stream,
 *     so this still needs no seeking) is read afterwards, metadata-only, to cross-check symlinks: a
 *     Unix-created entry (`version made by` host byte 3) whose external attributes encode
 *     `S_IFLNK` is rejected — SCF bundles are files only. Symlink detection needs the central
 *     directory's Unix mode bits, which a local file header never carries.
 *
 * Two classes of problem are reported this way: (1) structural issues found without needing to
 * abort the whole read (unsafe paths, symlinks) are collected into `issues` and the read continues,
 * so a bundle with several bad entries gets every one of them back in a single response; (2) a real
 * bomb / cap breach throws immediately, aborting the whole read with that one issue — there is no
 * value in continuing to read a request that has already proven itself hostile or corrupt.
 */
import { ByteCursor } from './byte-cursor.js';
import type { BundleFiles } from '../vendor/scf/dist/index.js';

export interface BoundedZipLimits {
  /** Central directory entry count above which the ZIP is rejected outright (no per-entry detail). */
  maxEntries: number;
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
  /** REAL decompressed bytes cap for every other member (`scf.json`, `structure/*.json`,
   *  `source/*`, sidecar JSON) — these are kept in full, so this is also the true memory cost of
   *  holding one. Comfortably above the vendored validator's own hard per-field caps (structure
   *  10 MB, sourceText 1 MB) so this is a backstop, not a tighter re-implementation of those. */
  maxNonImageEntryBytes: number;
  /** Total raw bytes read from the underlying stream (the ZIP object itself, still compressed) —
   *  independent of any ZIP metadata, this is the caller's own bound on how much of the R2 object
   *  it will ever pull down for one request. */
  maxRawBytes: number;
  /** How many of an image entry's real decompressed bytes to actually retain, as its `head` —
   *  enough for magic-byte family detection and a header-only PNG/JPEG/WebP dimension read. */
  imageHeadBytes: number;
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
  maxImageEntryBytes: 20 * 1024 * 1024, // matches @scrymore/scf's MAX_IMAGE_BYTES
  maxNonImageEntryBytes: 12 * 1024 * 1024,
  maxRawBytes: 1024 * 1024 * 1024, // 1 GiB
  imageHeadBytes: 64 * 1024,
};

const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const EOCD_SIGNATURE = 0x06054b50;
/** ZIP general-purpose flag bit 3: sizes/CRC are unknown in the local header and follow the entry's
 *  data in a trailing data descriptor instead. Safely bounding such an entry would mean scanning
 *  for the data-descriptor signature rather than trusting a byte count at all — out of scope here;
 *  every adapter this format targets (see AGENTS.md) writes ordinary, non-streamed ZIPs. */
const STREAMING_DATA_DESCRIPTOR_FLAG = 0x0008;
/** "version made by" host byte for a UNIX-created entry (the only host that carries a Unix mode,
 *  and therefore a symlink bit, in its external file attributes). */
const UNIX_HOST = 3;
/** Unix file-type bits (`st_mode & S_IFMT`) for a symbolic link. */
const S_IFLNK = 0xa000;
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

function isImageLikeName(name: string): boolean {
  const m = /\.([a-zA-Z0-9]+)$/.exec(name);
  return m !== null && IMAGE_LIKE_EXTENSIONS.has(m[1].toLowerCase());
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
    if (chunk === null) throw new Error('Unexpected end of ZIP data while skipping a rejected entry.');
    remaining -= chunk.byteLength;
  }
}

interface EntryScanState {
  path: string;
  isImage: boolean;
  declaredUncompressedSize: number;
  perEntryCap: number;
  realBytes: number;
  headChunks: Uint8Array[];
  headFilled: number;
  fullChunks: Uint8Array[];
}

/** Called with every chunk of an entry's REAL decompressed output, in order, as it is produced.
 *  Throws a `BundleZipLimitError` the instant any bound is exceeded — the caller (both the STORED
 *  and DEFLATE consumers below) lets that propagate straight out, aborting the whole read. */
function accumulateChunk(
  entryState: EntryScanState,
  totalState: { realBytes: number },
  limits: BoundedZipLimits,
  chunk: Uint8Array,
  compressedConsumedSoFar: number
): void {
  entryState.realBytes += chunk.byteLength;
  totalState.realBytes += chunk.byteLength;

  if (entryState.isImage) {
    if (entryState.headFilled < limits.imageHeadBytes) {
      const room = limits.imageHeadBytes - entryState.headFilled;
      const slice = chunk.byteLength <= room ? chunk : chunk.subarray(0, room);
      entryState.headChunks.push(slice);
      entryState.headFilled += slice.byteLength;
    }
    // Bytes beyond imageHeadBytes are counted above (for the caps below) but never retained.
  } else {
    entryState.fullChunks.push(chunk);
  }

  if (entryState.realBytes > entryState.declaredUncompressedSize) {
    throw new BundleZipLimitError(
      'BUNDLE_SIZE_MISMATCH',
      `ZIP entry decompresses to more bytes than its own declared uncompressed size (${entryState.declaredUncompressedSize}): ${entryState.path}`,
      entryState.path
    );
  }
  if (entryState.realBytes > entryState.perEntryCap) {
    throw new BundleZipLimitError(
      entryState.isImage ? 'IMAGE_TOO_LARGE' : 'BUNDLE_MEMBER_TOO_LARGE',
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

async function processLocalEntry(
  cursor: ByteCursor,
  limits: BoundedZipLimits,
  issues: BoundedZipIssue[],
  files: BundleFiles,
  totalState: { realBytes: number }
): Promise<void> {
  const fixed = await mustTake(cursor, 26); // local header fields after the 4-byte signature
  const flags = fixed.readUInt16LE(2);
  const compressionMethod = fixed.readUInt16LE(4);
  const compressedSize = fixed.readUInt32LE(14);
  const uncompressedSize = fixed.readUInt32LE(18);
  const nameLen = fixed.readUInt16LE(22);
  const extraLen = fixed.readUInt16LE(24);

  const nameBuf = await mustTake(cursor, nameLen);
  const name = nameBuf.toString('utf8');
  if (extraLen > 0) await mustTake(cursor, extraLen); // discard; unused

  if (name.endsWith('/')) {
    // Directory entry, not a file (same as the CLI-only vendored reader) — ordinarily no data, but
    // stay in sync with whatever (if anything) is declared, rather than assuming zero.
    if (compressedSize > 0) await skipRawBytes(cursor, compressedSize);
    return;
  }

  if ((flags & STREAMING_DATA_DESCRIPTOR_FLAG) !== 0) {
    throw new BundleZipLimitError(
      'BUNDLE_ZIP_STREAMING_UNSUPPORTED',
      `ZIP entry uses a streamed (data-descriptor) size, which this reader cannot bound safely: ${name}`,
      name
    );
  }
  if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
    throw new BundleZipLimitError(
      'BUNDLE_ZIP64_UNSUPPORTED',
      `ZIP entry uses Zip64 sizes, which this reader does not support: ${name}`,
      name
    );
  }

  if (isUnsafeZipMemberName(name)) {
    issues.push(
      issue(
        'BUNDLE_UNSAFE_PATH',
        `ZIP entry has an unsafe path (absolute, backslash, drive letter, or "." / ".." segment): ${JSON.stringify(name)}`,
        name
      )
    );
    await skipRawBytes(cursor, compressedSize);
    return;
  }
  if (compressionMethod !== 0 && compressionMethod !== 8) {
    issues.push(issue('BUNDLE_ZIP_INVALID', `Unsupported ZIP compression method ${compressionMethod}: ${name}`, name));
    await skipRawBytes(cursor, compressedSize);
    return;
  }

  const isImage = isImageLikeName(name);
  const entryState: EntryScanState = {
    path: name,
    isImage,
    declaredUncompressedSize: uncompressedSize,
    perEntryCap: isImage ? limits.maxImageEntryBytes : limits.maxNonImageEntryBytes,
    realBytes: 0,
    headChunks: [],
    headFilled: 0,
    fullChunks: [],
  };
  const onChunk = (chunk: Uint8Array, compressedConsumedSoFar: number): void =>
    accumulateChunk(entryState, totalState, limits, chunk, compressedConsumedSoFar);

  if (compressionMethod === 0) {
    await consumeStoredEntry(cursor, compressedSize, onChunk);
  } else {
    await consumeDeflateEntry(cursor, compressedSize, onChunk);
  }

  files.set(
    name,
    isImage ? { head: concatUint8(entryState.headChunks), size: entryState.realBytes } : concatUint8(entryState.fullChunks)
  );
}

/** Metadata-only pass over the central directory (which immediately follows the local entries in
 *  the byte stream — no seek needed): the only thing this reader still needs from it is each
 *  entry's Unix symlink bit, which a local file header never carries. The caller has already
 *  consumed the CENTRAL_DIR_SIGNATURE that starts the first record. */
async function processCentralDirectory(cursor: ByteCursor, issues: BoundedZipIssue[]): Promise<void> {
  for (;;) {
    const fixed = await mustTake(cursor, 42); // central directory fields after the 4-byte signature
    const versionMadeByHost = fixed.readUInt8(1);
    const nameLen = fixed.readUInt16LE(24);
    const extraLen = fixed.readUInt16LE(26);
    const commentLen = fixed.readUInt16LE(28);
    const externalAttrs = fixed.readUInt32LE(34);

    const nameBuf = await mustTake(cursor, nameLen);
    const name = nameBuf.toString('utf8');
    if (extraLen > 0) await mustTake(cursor, extraLen);
    if (commentLen > 0) await mustTake(cursor, commentLen);

    const isUnixSymlink = versionMadeByHost === UNIX_HOST && ((externalAttrs >>> 16) & 0xf000) === S_IFLNK;
    if (isUnixSymlink) {
      issues.push(issue('BUNDLE_SYMLINK_REJECTED', `ZIP entry is a symlink, which a bundle must not contain: ${name}`, name));
    }

    const sig = await mustTake(cursor, 4);
    const sigValue = sig.readUInt32LE(0);
    if (sigValue === CENTRAL_DIR_SIGNATURE) continue;
    if (sigValue === EOCD_SIGNATURE) {
      await consumeEocdTail(cursor);
      return;
    }
    throw new Error('Corrupt ZIP: central directory record not followed by another record or the end-of-central-directory signature.');
  }
}

async function consumeEocdTail(cursor: ByteCursor): Promise<void> {
  const fixed = await mustTake(cursor, 18); // EOCD fields after the 4-byte signature
  const commentLen = fixed.readUInt16LE(16);
  if (commentLen > 0) await mustTake(cursor, commentLen);
}

async function readBoundedZipStreamInner(cursor: ByteCursor, limits: BoundedZipLimits): Promise<BoundedZipResult> {
  const issues: BoundedZipIssue[] = [];
  const files: BundleFiles = new Map();
  const totalState = { realBytes: 0 };
  let entryCount = 0;

  for (;;) {
    // Checked between entries, not mid-entry: the object's physical size (checked cheaply via
    // `storage.head()` before this stream was ever opened, in app.ts) already caps how many raw
    // bytes this stream can possibly yield in total, so this is a same-request backstop for that
    // HEAD/GET disagreeing — not a defense against one entry declaring an enormous compressedSize,
    // which costs an attacker real upload bytes 1:1 and is bounded the same way regardless (see
    // `accumulateChunk`'s per-entry/total REAL-byte caps, which apply continuously as any entry's
    // data streams through, no matter how large its declared size claims to be).
    if (cursor.totalBytesRead > limits.maxRawBytes) {
      throw new BundleZipLimitError('BUNDLE_TOO_LARGE', `ZIP object exceeds the ${limits.maxRawBytes} raw byte limit.`);
    }
    const sig = await mustTake(cursor, 4);
    const sigValue = sig.readUInt32LE(0);

    if (sigValue === LOCAL_FILE_SIGNATURE) {
      entryCount++;
      if (entryCount > limits.maxEntries) {
        throw new BundleZipLimitError('BUNDLE_TOO_MANY_ENTRIES', `ZIP has more than ${limits.maxEntries} entries.`);
      }
      await processLocalEntry(cursor, limits, issues, files, totalState);
      continue;
    }
    if (sigValue === CENTRAL_DIR_SIGNATURE) {
      await processCentralDirectory(cursor, issues);
      break;
    }
    if (sigValue === EOCD_SIGNATURE) {
      // Zero-entry archive: no central directory records at all, straight to EOCD.
      await consumeEocdTail(cursor);
      break;
    }
    throw new Error('Corrupt ZIP: expected a local file header, central directory record, or end-of-central-directory signature.');
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, files };
}

/**
 * Reads a ZIP object's stream into a bundle-relative path -> bytes map, enforcing `limits` as a
 * true streaming pass (see module docs) — never buffering the whole compressed object, an entry's
 * whole decompressed output, or the whole bundle's decompressed content at once.
 */
export async function readBoundedZipStream(
  stream: ReadableStream<Uint8Array>,
  limits: BoundedZipLimits = DEFAULT_BOUNDED_ZIP_LIMITS
): Promise<BoundedZipResult> {
  const cursor = new ByteCursor(stream);
  try {
    return await readBoundedZipStreamInner(cursor, limits);
  } catch (e) {
    if (e instanceof BundleZipLimitError) {
      return { ok: false, issues: [issue(e.issueCode, e.message, e.path)] };
    }
    return { ok: false, issues: [issue('BUNDLE_ZIP_INVALID', `Corrupt or truncated ZIP: ${(e as Error).message}`)] };
  } finally {
    await cursor.cancel().catch(() => undefined);
  }
}
