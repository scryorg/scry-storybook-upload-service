import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BOUNDED_ZIP_LIMITS, type BoundedZipLimits } from './bounded-zip.js';
import { buildZip, deflateEntry, streamOf, chunkedStreamOf, readFullZip, readFullZipFromStream } from './__tests__/test-helpers.js';
import { archiverZipFromBuffers, archiverZipFromDirectory, archiverZipMixedInputs } from './__tests__/archiver-helpers.js';

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

describe('readBoundedZip (central-directory-driven)', () => {
  it('reads a well-formed ZIP into a bundle-relative path -> bytes map (image as {head, size}, JSON in full)', async () => {
    const zip = buildZip([
      { name: 'scf.json', data: Buffer.from('{}') },
      { name: 'images/a.png', data: png },
    ]);
    const result = await readFullZip(zip, DEFAULT_BOUNDED_ZIP_LIMITS);
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
    const result = await readFullZipFromStream(zip, chunkedStreamOf(zip, 7), DEFAULT_BOUNDED_ZIP_LIMITS); // deliberately awkward chunk size
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files.get('scf.json')).toEqual(new Uint8Array(Buffer.from('{"a":1}')));
    expect(result.files.get('images/a.png')).toEqual({ head: new Uint8Array(png), size: png.length });
  });

  it('rejects a buffer with no end-of-central-directory record', async () => {
    const result = await readFullZip(Buffer.from('not a zip'), DEFAULT_BOUNDED_ZIP_LIMITS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain('BUNDLE_ZIP_INVALID');
  });

  it('rejects a completely empty stream', async () => {
    const result = await readFullZip(Buffer.alloc(0), DEFAULT_BOUNDED_ZIP_LIMITS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain('BUNDLE_ZIP_INVALID');
  });

  it.each(['../../../etc/passwd', '/etc/passwd', 'a/../../b.png', 'C:\\evil.png', 'a\\b.png'])(
    'rejects the unsafe raw entry name %s (path traversal, ledger F11) before ever inflating it',
    async (name) => {
      const zip = buildZip([{ name, data: png }]);
      const result = await readFullZip(zip, DEFAULT_BOUNDED_ZIP_LIMITS);
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
    const result = await readFullZip(zip, DEFAULT_BOUNDED_ZIP_LIMITS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([expect.objectContaining({ code: 'BUNDLE_SYMLINK_REJECTED', path: 'images/a.png' })]);
    }
  });

  it('rejects a ZIP with more entries than the configured limit, without reading past it', async () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ name: `images/${i}.png`, data: png }));
    const zip = buildZip(entries);
    const result = await readFullZip(zip, withLimits({ maxEntries: 3 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toEqual(['BUNDLE_TOO_MANY_ENTRIES']);
  });

  it('skips directory entries', async () => {
    const zip = buildZip([
      { name: 'images/', data: Buffer.alloc(0) },
      { name: 'images/a.png', data: png },
    ]);
    const result = await readFullZip(zip, DEFAULT_BOUNDED_ZIP_LIMITS);
    expect(result.ok).toBe(true);
    if (result.ok) expect([...result.files.keys()]).toEqual(['images/a.png']);
  });

  it('reports every unsafe entry at once, not just the first', async () => {
    const zip = buildZip([
      { name: '../evil1.png', data: png },
      { name: '../evil2.png', data: png },
    ]);
    const result = await readFullZip(zip, DEFAULT_BOUNDED_ZIP_LIMITS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toHaveLength(2);
  });

  it('reads a STORED + DEFLATE mix in the same bundle', async () => {
    const zip = buildZip([
      { name: 'scf.json', data: Buffer.from('{"mixed":true}') }, // STORED
      { name: 'images/stored.png', data: png }, // STORED
      deflateEntry('images/deflated.png', Buffer.concat([png, Buffer.alloc(1000, 0x41)])), // DEFLATE
    ]);
    const result = await readFullZip(zip, PERMISSIVE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files.size).toBe(3);
    const deflated = result.files.get('images/deflated.png') as { head: Uint8Array; size: number };
    expect(deflated.size).toBe(png.length + 1000);
    expect([...deflated.head.subarray(0, png.length)]).toEqual([...png]);
  });

  describe('ledger F31: real byte counters, never a declared size', () => {
    it('a DEFLATE bomb (real output far larger than the entry itself declares) is rejected — BUNDLE_SIZE_MISMATCH — long before it finishes decompressing', async () => {
      // The exact repro shape from the security review: a real, genuine DEFLATE stream (not
      // hand-faked) whose CENTRAL DIRECTORY lies about how big the decompressed output will be. This
      // reader measures the real output and aborts the moment it exceeds what the central directory
      // itself claimed.
      const realSize = 20 * 1024 * 1024; // 20 MiB real payload
      const bomb = Buffer.alloc(realSize, 0x42); // highly compressible on purpose (a real bomb shape)
      const entry = deflateEntry('images/bomb.png', bomb, { declaredUncompressedSize: 1024 }); // lies: claims 1 KiB
      const zip = buildZip([entry]);

      const result = await readFullZip(zip, PERMISSIVE);
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

      const result = await readFullZip(zip, withLimits({ maxImageEntryBytes: 1024 * 1024 }));
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

      const result = await readFullZip(zip, withLimits({ maxCompressionRatio: 200, maxNonImageEntryBytes: 100 * 1024 * 1024 }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues).toEqual([expect.objectContaining({ code: 'BUNDLE_COMPRESSION_RATIO', path: 'blob.bin' })]);
      }
    });

    it('the running TOTAL real size across several honestly-declared entries is bounded too', async () => {
      const perEntry = 2 * 1024 * 1024;
      const entries = Array.from({ length: 5 }, (_, i) => deflateEntry(`images/${i}.png`, randomBytes(perEntry)));
      const zip = buildZip(entries);

      const result = await readFullZip(zip, withLimits({ maxTotalUncompressedBytes: 3 * perEntry, maxImageEntryBytes: 1024 * 1024 * 1024 }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.map((i) => i.code)).toEqual(['BUNDLE_TOO_LARGE']);
    });
  });

  describe('ledger F49: archiver sets the data-descriptor flag on every entry — this reader must accept that, not reject it', () => {
    it('accepts a genuine streamed (data-descriptor) DEFLATE entry, reading its real size/CRC from the central directory', async () => {
      const content = Buffer.concat([png, Buffer.alloc(2000, 0x41)]);
      const entry = deflateEntry('images/a.png', content, { flags: 0x0008 });
      const zip = buildZip([entry]);
      const result = await readFullZip(zip, PERMISSIVE);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const got = result.files.get('images/a.png') as { head: Uint8Array; size: number };
      expect(got.size).toBe(content.length);
    });

    it('accepts a genuine streamed STORED entry the same way', async () => {
      const content = Buffer.from('{"scf":"1.0"}');
      const zip = buildZip([{ name: 'scf.json', data: content, flags: 0x0008 }]);
      const result = await readFullZip(zip, PERMISSIVE);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.files.get('scf.json')).toEqual(new Uint8Array(content));
    });

    it('still rejects a streamed DEFLATE bomb — the central directory (not the zeroed local header) is what the zip-bomb caps check against', async () => {
      const realSize = 20 * 1024 * 1024;
      const bomb = Buffer.alloc(realSize, 0x42);
      const entry = deflateEntry('images/bomb.png', bomb, { declaredUncompressedSize: 1024, flags: 0x0008 });
      const zip = buildZip([entry]);
      const result = await readFullZip(zip, PERMISSIVE);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues).toEqual([expect.objectContaining({ code: 'BUNDLE_SIZE_MISMATCH', path: 'images/bomb.png' })]);
    });

    it("rejects a data descriptor that disagrees with the central directory's declared sizes (corruption/tampering)", async () => {
      const content = Buffer.from('{"scf":"1.0"}');
      const zip = buildZip([
        { name: 'scf.json', data: content, flags: 0x0008, dataDescriptorOverride: { uncompressedSize: content.length + 1 } },
      ]);
      const result = await readFullZip(zip, PERMISSIVE);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.map((i) => i.code)).toEqual(['BUNDLE_ZIP_INVALID']);
    });
  });

  it("ledger F49: rejects a ZIP whose LOCAL header name disagrees with its central directory name (parser confusion)", async () => {
    const zip = buildZip([{ name: 'scf.json', data: Buffer.from('{}'), localNameOverride: 'not-scf.json' }]);
    const result = await readFullZip(zip, DEFAULT_BOUNDED_ZIP_LIMITS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toEqual(['BUNDLE_NAME_MISMATCH']);
  });

  it("ledger F49: rejects an entry whose real CRC-32 does not match the central directory's declared CRC-32 (cheap integrity check)", async () => {
    const content = Buffer.from('{"scf":"1.0"}');
    const zip = buildZip([{ name: 'scf.json', data: content, declaredCrc32: 0xdeadbeef }]);
    const result = await readFullZip(zip, DEFAULT_BOUNDED_ZIP_LIMITS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toEqual(['BUNDLE_CRC_MISMATCH']);
  });

  it('rejects a streamed entry whose data descriptor is missing entirely (truncated ZIP)', async () => {
    const content = Buffer.from('{"scf":"1.0"}');
    const withDescriptor = buildZip([{ name: 'scf.json', data: content, flags: 0x0008 }]);
    // Strip the 16-byte descriptor that follows the entry's data — the reader should notice the
    // subsequent bytes aren't a valid descriptor / the stream doesn't line up with the central
    // directory offsets it already committed to.
    const localHeaderAndData = 30 + 'scf.json'.length + content.length;
    const truncated = Buffer.concat([withDescriptor.subarray(0, localHeaderAndData), withDescriptor.subarray(localHeaderAndData + 16)]);
    const result = await readFullZip(truncated, DEFAULT_BOUNDED_ZIP_LIMITS);
    expect(result.ok).toBe(false);
  });

  describe('ledger F49: real bundles built with the `archiver` package (our own CLI/sbcov dependency) round-trip', () => {
    it('a DEFLATE archive from buffer entries is accepted end to end', async () => {
      const scf = Buffer.from(JSON.stringify({ scf: '1.0', source: { kind: 'storybook', platform: 'web' }, captures: 'sidecars' }));
      const zip = await archiverZipFromBuffers([
        { name: 'scf.json', data: scf },
        { name: 'images/a.png', data: png },
        { name: 'images/b.png', data: Buffer.concat([png, Buffer.alloc(500, 0x10)]) },
      ]);
      const result = await readFullZip(zip, PERMISSIVE);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.files.size).toBe(3);
      expect(result.files.get('scf.json')).toEqual(new Uint8Array(scf));
    });

    it('a STORED (no compression) archive from buffer entries is accepted end to end', async () => {
      const zip = await archiverZipFromBuffers(
        [
          { name: 'scf.json', data: Buffer.from('{}') },
          { name: 'images/a.png', data: png },
        ],
        { store: true }
      );
      const result = await readFullZip(zip, PERMISSIVE);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.files.size).toBe(2);
    });

    it('an archive built from an on-disk file + directory input (archiver.file()/directory(), not just buffers) is accepted', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'scf-archiver-'));
      writeFileSync(path.join(dir, 'from-file.png'), png);
      mkdirSync(path.join(dir, 'sub'));
      writeFileSync(path.join(dir, 'sub', 'nested.json'), '{"nested":true}');

      const zip = await archiverZipMixedInputs(
        [{ name: 'scf.json', data: Buffer.from('{}') }],
        path.join(dir, 'from-file.png'),
        'images/from-file.png',
        dir,
        'as-dir'
      );
      const result = await readFullZip(zip, PERMISSIVE);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect([...result.files.keys()].sort()).toEqual(
        ['scf.json', 'images/from-file.png', 'as-dir/from-file.png', 'as-dir/sub/nested.json'].sort()
      );
    });

    it('an archive built purely from an on-disk directory (archive.directory()) is accepted', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'scf-archiver-dir-'));
      writeFileSync(path.join(dir, 'a.txt'), 'hello');
      mkdirSync(path.join(dir, 'nested'));
      writeFileSync(path.join(dir, 'nested', 'b.txt'), 'world '.repeat(200));

      const zip = await archiverZipFromDirectory(dir);
      const result = await readFullZip(zip, PERMISSIVE);
      expect(result.ok).toBe(true);
      if (result.ok) expect([...result.files.keys()].sort()).toEqual(['a.txt', 'nested/b.txt']);
    });

    it('an archive with many entries round-trips correctly', async () => {
      const entries = Array.from({ length: 300 }, (_, i) => ({ name: `images/${i}.png`, data: Buffer.concat([png, Buffer.from(`entry-${i}`)]) }));
      const zip = await archiverZipFromBuffers(entries);
      const result = await readFullZip(zip, PERMISSIVE);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.files.size).toBe(300);
      for (let i = 0; i < 300; i++) {
        const got = result.files.get(`images/${i}.png`) as { head: Uint8Array; size: number };
        expect(got.size, `images/${i}.png`).toBe(png.length + `entry-${i}`.length);
      }
    });

    it(
      'a real ~150 MB archiver-built bundle (many DEFLATE images, honest sizes) validates ok with a bounded peak heap',
      async () => {
        const perImageBytes = 18_750_000; // under the 20 MiB per-image cap
        const imageCount = 8; // 8 * 18.75 MB = 150 MB of real, honest decompressed content
        const entries = Array.from({ length: imageCount }, (_, i) => {
          const raw = Buffer.concat([png, randomBytes(perImageBytes - png.length)]);
          return { name: `images/${i}.png`, data: raw };
        });
        const zip = await archiverZipFromBuffers(entries);
        expect(zip.length).toBeGreaterThan(140_000_000); // the on-disk ZIP really is ~150 MB, not a trick

        if (global.gc) global.gc();
        const baselineHeap = process.memoryUsage().heapUsed;
        let peakHeap = baselineHeap;
        const sampler = setInterval(() => {
          peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
        }, 10);

        let result;
        try {
          result = await readFullZipFromStream(zip, chunkedStreamOf(zip, 256 * 1024), DEFAULT_BOUNDED_ZIP_LIMITS);
        } finally {
          clearInterval(sampler);
        }

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.files.size).toBe(imageCount);
        for (const [filePath, entry] of result.files) {
          const withSize = entry as { head: Uint8Array; size: number };
          expect(withSize.size, filePath).toBe(perImageBytes);
          expect(withSize.head.byteLength, filePath).toBeLessThanOrEqual(DEFAULT_BOUNDED_ZIP_LIMITS.imageHeadBytes);
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
});
