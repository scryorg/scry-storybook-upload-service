import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readBoundedZipStream, DEFAULT_BOUNDED_ZIP_LIMITS, type BoundedZipLimits } from './bounded-zip.js';
import { buildZip, deflateEntry, streamOf, chunkedStreamOf } from './__tests__/test-helpers.js';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // just the magic bytes

/** Merges partial overrides onto the defaults — every test below only needs to name the one or two
 *  limits it's actually exercising. */
function withLimits(overrides: Partial<BoundedZipLimits>): BoundedZipLimits {
  return { ...DEFAULT_BOUNDED_ZIP_LIMITS, ...overrides };
}

/** A generously-loose set of limits for tests that aren't exercising any particular bound. */
const PERMISSIVE = withLimits({
  maxTotalUncompressedBytes: 10 * 1024 * 1024 * 1024,
  maxImageEntryBytes: 1024 * 1024 * 1024,
  maxNonImageEntryBytes: 1024 * 1024 * 1024,
  maxCompressionRatio: 1_000_000,
});

describe('readBoundedZipStream', () => {
  it('reads a well-formed ZIP into a bundle-relative path -> bytes map (image as {head, size}, JSON in full)', async () => {
    const zip = buildZip([
      { name: 'scf.json', data: Buffer.from('{}') },
      { name: 'images/a.png', data: png },
    ]);
    const result = await readBoundedZipStream(streamOf(zip));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files.size).toBe(2);
    expect(result.files.get('scf.json')).toEqual(new Uint8Array(Buffer.from('{}')));
    expect(result.files.get('images/a.png')).toEqual({ head: new Uint8Array(png), size: png.length });
  });

  it('reads the same ZIP correctly when the underlying stream delivers it in small chunks', async () => {
    const zip = buildZip([
      { name: 'scf.json', data: Buffer.from('{"a":1}') },
      { name: 'images/a.png', data: png },
    ]);
    const result = await readBoundedZipStream(chunkedStreamOf(zip, 7)); // deliberately awkward chunk size
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files.get('scf.json')).toEqual(new Uint8Array(Buffer.from('{"a":1}')));
    expect(result.files.get('images/a.png')).toEqual({ head: new Uint8Array(png), size: png.length });
  });

  it('rejects a buffer with no end-of-central-directory record', async () => {
    const result = await readBoundedZipStream(streamOf(Buffer.from('not a zip')));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain('BUNDLE_ZIP_INVALID');
  });

  it('rejects a completely empty stream', async () => {
    const result = await readBoundedZipStream(streamOf(Buffer.alloc(0)));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain('BUNDLE_ZIP_INVALID');
  });

  it.each(['../../../etc/passwd', '/etc/passwd', 'a/../../b.png', 'C:\\evil.png', 'a\\b.png'])(
    'rejects the unsafe raw entry name %s (path traversal, ledger F11) before ever inflating it',
    async (name) => {
      const zip = buildZip([{ name, data: png }]);
      const result = await readBoundedZipStream(streamOf(zip));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues).toEqual([expect.objectContaining({ code: 'BUNDLE_UNSAFE_PATH', path: name })]);
      }
    }
  );

  it('rejects a unix symlink entry outright (ledger F11), found via the central directory pass', async () => {
    const zip = buildZip([
      { name: 'scf.json', data: Buffer.from('{}') },
      { name: 'images/a.png', data: png, unixMode: 0o120777 }, // S_IFLNK
    ]);
    const result = await readBoundedZipStream(streamOf(zip));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([expect.objectContaining({ code: 'BUNDLE_SYMLINK_REJECTED', path: 'images/a.png' })]);
    }
  });

  it('rejects a ZIP with more entries than the configured limit, without reading past it', async () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ name: `images/${i}.png`, data: png }));
    const zip = buildZip(entries);
    const result = await readBoundedZipStream(streamOf(zip), withLimits({ maxEntries: 3 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toEqual(['BUNDLE_TOO_MANY_ENTRIES']);
  });

  it('skips directory entries', async () => {
    const zip = buildZip([
      { name: 'images/', data: Buffer.alloc(0) },
      { name: 'images/a.png', data: png },
    ]);
    const result = await readBoundedZipStream(streamOf(zip));
    expect(result.ok).toBe(true);
    if (result.ok) expect([...result.files.keys()]).toEqual(['images/a.png']);
  });

  it('reports every unsafe entry at once, not just the first', async () => {
    const zip = buildZip([
      { name: '../evil1.png', data: png },
      { name: '../evil2.png', data: png },
    ]);
    const result = await readBoundedZipStream(streamOf(zip));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toHaveLength(2);
  });

  it('reads a STORED + DEFLATE mix in the same bundle', async () => {
    const zip = buildZip([
      { name: 'scf.json', data: Buffer.from('{"mixed":true}') }, // STORED
      { name: 'images/stored.png', data: png }, // STORED
      deflateEntry('images/deflated.png', Buffer.concat([png, Buffer.alloc(1000, 0x41)])), // DEFLATE
    ]);
    const result = await readBoundedZipStream(streamOf(zip), PERMISSIVE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files.size).toBe(3);
    const deflated = result.files.get('images/deflated.png') as { head: Uint8Array; size: number };
    expect(deflated.size).toBe(png.length + 1000);
    expect([...deflated.head.subarray(0, png.length)]).toEqual([...png]);
  });

  describe('ledger F31: real byte counters, never the declared/central-directory size', () => {
    it('a DEFLATE bomb (real output far larger than the entry itself declares) is rejected — BUNDLE_SIZE_MISMATCH — long before it finishes decompressing', async () => {
      // The exact repro shape from the security review: a real, genuine DEFLATE stream (not
      // hand-faked) whose LOCAL HEADER lies about how big the decompressed output will be. The old
      // (vulnerable) reader trusted this declared value outright, before ever inflating; this one
      // measures the real output and aborts the moment it exceeds what the entry itself claimed.
      const realSize = 20 * 1024 * 1024; // 20 MiB real payload
      const bomb = Buffer.alloc(realSize, 0x42); // highly compressible on purpose (a real bomb shape)
      const entry = deflateEntry('images/bomb.png', bomb, { declaredUncompressedSize: 1024 }); // lies: claims 1 KiB
      const zip = buildZip([entry]);

      const result = await readBoundedZipStream(streamOf(zip), PERMISSIVE);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues).toEqual([expect.objectContaining({ code: 'BUNDLE_SIZE_MISMATCH', path: 'images/bomb.png' })]);
      }
    });

    it('an honestly-declared entry that is simply too big is rejected by the per-entry cap on its REAL size', async () => {
      const realSize = 5 * 1024 * 1024;
      const content = randomBytes(realSize); // ~incompressible, so this also isn't a ratio bomb
      const entry = deflateEntry('images/big.png', content); // declared size == real size (honest)
      const zip = buildZip([entry]);

      const result = await readBoundedZipStream(streamOf(zip), withLimits({ maxImageEntryBytes: 1024 * 1024 }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues).toEqual([expect.objectContaining({ code: 'IMAGE_TOO_LARGE', path: 'images/big.png' })]);
      }
    });

    it('an honestly-declared entry with an implausible REAL compression ratio is rejected (second zip-bomb signal)', async () => {
      // A 256-byte random block repeated 8000x (2 MiB): DEFLATE's 32 KiB window finds each repeat
      // of one of the last ~128 occurrences, so this compresses to roughly a 247x ratio — real,
      // comfortably over the 200x cap, and (unlike all-zero content, which compresses so well the
      // compressed size would fall BELOW the ratio check's own minimum-sample floor) its ~8 KB
      // compressed size is comfortably over that floor too.
      const block = randomBytes(256);
      const content = Buffer.concat(Array.from({ length: 8000 }, () => block));
      const entry = deflateEntry('blob.bin', content); // honest declared size; non-image path
      const zip = buildZip([entry]);
      expect(entry.data.length).toBeGreaterThan(4096); // sanity: comfortably over MIN_BYTES_FOR_RATIO_CHECK
      expect(content.length / entry.data.length).toBeGreaterThan(200); // sanity: a real >200x ratio

      const result = await readBoundedZipStream(
        streamOf(zip),
        withLimits({ maxCompressionRatio: 200, maxNonImageEntryBytes: 100 * 1024 * 1024 })
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues).toEqual([expect.objectContaining({ code: 'BUNDLE_COMPRESSION_RATIO', path: 'blob.bin' })]);
      }
    });

    it('the running TOTAL real size across several honestly-declared entries is bounded too', async () => {
      const perEntry = 2 * 1024 * 1024;
      const entries = Array.from({ length: 5 }, (_, i) => deflateEntry(`images/${i}.png`, randomBytes(perEntry)));
      const zip = buildZip(entries);

      const result = await readBoundedZipStream(
        streamOf(zip),
        withLimits({ maxTotalUncompressedBytes: 3 * perEntry, maxImageEntryBytes: 1024 * 1024 * 1024 })
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.map((i) => i.code)).toEqual(['BUNDLE_TOO_LARGE']);
    });
  });

  it('rejects a streamed (data-descriptor) entry outright rather than guessing its size', async () => {
    const zip = buildZip([{ name: 'images/a.png', data: png, flags: 0x0008 }]);
    const result = await readBoundedZipStream(streamOf(zip));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toEqual(['BUNDLE_ZIP_STREAMING_UNSUPPORTED']);
  });

  it(
    'a real ~150 MB legitimate bundle (many DEFLATE images, honest sizes) validates ok with a bounded peak heap',
    async () => {
      const perImageBytes = 18_750_000; // under the 20 MiB per-image cap
      const imageCount = 8; // 8 * 18.75 MB = 150 MB of real, honest decompressed content
      const entries = Array.from({ length: imageCount }, (_, i) => {
        // Real, ~incompressible content (so the ZIP object on "disk" is itself close to 150 MB too,
        // like real photographic JPEGs/PNGs) prefixed with a real PNG signature + IHDR so format
        // detection later in the pipeline has something genuine to sniff.
        const raw = Buffer.concat([png, randomBytes(perImageBytes - png.length)]);
        return deflateEntry(`images/${i}.png`, raw);
      });
      const zip = buildZip(entries);
      expect(zip.length).toBeGreaterThan(140_000_000); // the on-disk ZIP really is ~150 MB, not a trick

      if (global.gc) global.gc();
      const baselineHeap = process.memoryUsage().heapUsed;
      let peakHeap = baselineHeap;
      const sampler = setInterval(() => {
        peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      }, 10);

      let result;
      try {
        result = await readBoundedZipStream(chunkedStreamOf(zip, 256 * 1024));
      } finally {
        clearInterval(sampler);
      }

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.files.size).toBe(imageCount);
      for (const [path, entry] of result.files) {
        const withSize = entry as { head: Uint8Array; size: number };
        expect(withSize.size, path).toBe(perImageBytes);
        expect(withSize.head.byteLength, path).toBeLessThanOrEqual(DEFAULT_BOUNDED_ZIP_LIMITS.imageHeadBytes);
      }

      const peakGrowthMb = (peakHeap - baselineHeap) / (1024 * 1024);
      // eslint-disable-next-line no-console
      console.log(
        `[bounded-zip 150MB test] baseline heap ${(baselineHeap / 1024 / 1024).toFixed(1)} MB, ` +
          `peak heap ${(peakHeap / 1024 / 1024).toFixed(1)} MB, growth ${peakGrowthMb.toFixed(1)} MB ` +
          `for a ${(zip.length / 1024 / 1024).toFixed(1)} MB on-disk / 150 MB real-content bundle`
      );
      // Old behavior would have needed >= the full compressed buffer + the full decompressed
      // content resident at once (~250+ MB for this fixture). This is generous headroom above the
      // brief's ~48 MB target (V8 heap accounting and this sampler's own polling aren't exact), but
      // is still nowhere near "the whole bundle" — the real regression this guards against.
      expect(peakGrowthMb).toBeLessThan(100);
    },
    30_000
  );
});
