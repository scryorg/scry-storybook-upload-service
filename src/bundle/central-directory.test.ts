import { describe, expect, it } from 'vitest';
import { readCentralDirectory, type CentralDirectoryLimits, type RangeReader } from './central-directory.js';
import { buildZip } from './__tests__/test-helpers.js';

const LIMITS: CentralDirectoryLimits = {
  maxEntries: 20_000,
  maxCentralDirectoryBytes: 8 * 1024 * 1024,
  maxEocdSearchBytes: 22 + 0xffff,
};

function rangeReaderOf(buf: Buffer): RangeReader {
  return async (range) => {
    if (range.offset >= buf.length) return new Uint8Array(0);
    return buf.subarray(range.offset, Math.min(buf.length, range.offset + range.length));
  };
}

describe('readCentralDirectory', () => {
  it('parses a well-formed ZIP: names, sizes, CRC, method, flags, and local-header offsets straight from the central directory', async () => {
    const zip = buildZip([
      { name: 'scf.json', data: Buffer.from('{}') },
      { name: 'images/a.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    ]);
    const result = await readCentralDirectory(rangeReaderOf(zip), zip.length, LIMITS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((e) => e.name)).toEqual(['scf.json', 'images/a.png']);
    expect(result.entries[0].localHeaderOffset).toBe(0);
    expect(result.entries[1].localHeaderOffset).toBeGreaterThan(0);
    expect(result.issues).toEqual([]);
  });

  it('a zero-entry ZIP (just an EOCD record) parses to no entries, no issues', async () => {
    const zip = buildZip([]);
    const result = await readCentralDirectory(rangeReaderOf(zip), zip.length, LIMITS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entries).toEqual([]);
  });

  it('rejects an object with no end-of-central-directory record', async () => {
    const buf = Buffer.from('not a zip, and shorter than 22 bytes is fine too');
    const result = await readCentralDirectory(rangeReaderOf(buf), buf.length, LIMITS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain('BUNDLE_ZIP_INVALID');
  });

  it('rejects an object smaller than a minimal EOCD record', async () => {
    const buf = Buffer.from('short');
    const result = await readCentralDirectory(rangeReaderOf(buf), buf.length, LIMITS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toEqual(['BUNDLE_ZIP_INVALID']);
  });

  it('finds the EOCD past an arbitrary comment (ledger F49: some real writers set one)', async () => {
    const zip = buildZip([{ name: 'scf.json', data: Buffer.from('{}') }]);
    // Splice a comment into the EOCD: bump commentLength (bytes 20-21 of the 22-byte record) and
    // append that many bytes.
    const eocdStart = zip.length - 22;
    const withComment = Buffer.concat([zip.subarray(0, eocdStart + 20), Buffer.alloc(2), Buffer.from('hello, world')]);
    withComment.writeUInt16LE(12, eocdStart + 20);
    const result = await readCentralDirectory(rangeReaderOf(withComment), withComment.length, LIMITS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entries.map((e) => e.name)).toEqual(['scf.json']);
  });

  it('when the central directory is larger than the tail window, fetches it with a SECOND targeted range-GET rather than assuming it fits in the first', async () => {
    // Force a small tail window (well under the real central directory's size) so the "reuse the
    // tail bytes we already have" fast path can't apply, and count calls to prove a second,
    // specifically-targeted range read actually happens.
    const entries = Array.from({ length: 50 }, (_, i) => ({ name: `images/entry-${i}.png`, data: Buffer.from(`content-${i}`) }));
    const zip = buildZip(entries);

    const calls: { offset: number; length: number }[] = [];
    const countingReader: RangeReader = async (range) => {
      calls.push(range);
      if (range.offset >= zip.length) return new Uint8Array(0);
      return zip.subarray(range.offset, Math.min(zip.length, range.offset + range.length));
    };

    const result = await readCentralDirectory(countingReader, zip.length, { ...LIMITS, maxEocdSearchBytes: 200 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    expect(calls.length).toBe(2);
    expect(calls[0].length).toBeLessThanOrEqual(200); // the small tail window
    expect(calls[1].offset).toBe(result.centralDirectoryOffset); // the targeted second read
  });

  it('rejects a ZIP with more entries than the configured limit', async () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, data: Buffer.from('x') }));
    const zip = buildZip(entries);
    const result = await readCentralDirectory(rangeReaderOf(zip), zip.length, { ...LIMITS, maxEntries: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toEqual(['BUNDLE_TOO_MANY_ENTRIES']);
  });

  it("rejects a ZIP whose central directory is larger than the configured byte limit", async () => {
    const zip = buildZip([{ name: 'a'.repeat(500), data: Buffer.from('x') }]);
    const result = await readCentralDirectory(rangeReaderOf(zip), zip.length, { ...LIMITS, maxCentralDirectoryBytes: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toEqual(['BUNDLE_ZIP_INVALID']);
  });

  it('collects a symlink entry as an issue but still returns every entry (the caller decides what to skip)', async () => {
    const zip = buildZip([
      { name: 'scf.json', data: Buffer.from('{}') },
      { name: 'images/a.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), unixMode: 0o120777 },
    ]);
    const result = await readCentralDirectory(rangeReaderOf(zip), zip.length, LIMITS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.issues).toEqual([expect.objectContaining({ code: 'BUNDLE_SYMLINK_REJECTED', path: 'images/a.png' })]);
    const entry = result.entries.find((e) => e.name === 'images/a.png');
    expect(entry?.isUnixSymlink).toBe(true);
    expect(entry?.isUnixNonRegularFile).toBe(true);
  });

  it('marks a name ending in "/" as a directory entry', async () => {
    const zip = buildZip([{ name: 'images/', data: Buffer.alloc(0) }]);
    const result = await readCentralDirectory(rangeReaderOf(zip), zip.length, LIMITS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entries[0].isDirectory).toBe(true);
  });

  describe('ledger F61: symlink rejection is not bypassable by lying about the "version made by" host byte', () => {
    it('still detects a symlink when the Unix mode bits are set but the declared host is NOT Unix', async () => {
      const zip = buildZip([
        { name: 'scf.json', data: Buffer.from('{}') },
        // The exact repro: genuine S_IFLNK mode bits, but a host byte (0 = FAT/DOS) that a naive
        // `versionMadeByHost === UNIX_HOST` gate would have trusted to mean "not really Unix, so
        // don't even look at the mode bits".
        { name: 'source/evil.src.txt', data: Buffer.from('/etc/passwd'), unixMode: 0o120777, versionMadeByHost: 0 },
      ]);
      const result = await readCentralDirectory(rangeReaderOf(zip), zip.length, LIMITS);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.issues).toEqual([expect.objectContaining({ code: 'BUNDLE_SYMLINK_REJECTED', path: 'source/evil.src.txt' })]);
      const entry = result.entries.find((e) => e.name === 'source/evil.src.txt');
      expect(entry?.isUnixSymlink).toBe(true);
      expect(entry?.isUnixNonRegularFile).toBe(true);
    });

    it('also rejects a non-symlink non-regular type (e.g. a FIFO) regardless of the host byte', async () => {
      const S_IFIFO = 0o10644; // FIFO (0o1xxxx) with 0644 perms
      const zip = buildZip([{ name: 'a.txt', data: Buffer.from('x'), unixMode: S_IFIFO, versionMadeByHost: 0 }]);
      const result = await readCentralDirectory(rangeReaderOf(zip), zip.length, LIMITS);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.issues).toEqual([expect.objectContaining({ code: 'BUNDLE_NON_REGULAR_FILE', path: 'a.txt' })]);
      const entry = result.entries.find((e) => e.name === 'a.txt');
      expect(entry?.isUnixSymlink).toBe(false);
      expect(entry?.isUnixNonRegularFile).toBe(true);
    });

    it('never flags an ordinary regular file, Unix host or not', async () => {
      const zip = buildZip([
        { name: 'a.txt', data: Buffer.from('x'), versionMadeByHost: 3 },
        { name: 'b.txt', data: Buffer.from('x'), versionMadeByHost: 0 }, // DOS host, no Unix mode info at all
      ]);
      const result = await readCentralDirectory(rangeReaderOf(zip), zip.length, LIMITS);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.issues).toEqual([]);
      expect(result.entries.every((e) => !e.isUnixNonRegularFile && !e.isUnixSymlink)).toBe(true);
    });

    it('never flags a real directory entry (S_IFDIR is common and legitimate on a "/"-named entry)', async () => {
      const S_IFDIR_0755 = 0o40755;
      const zip = buildZip([{ name: 'images/', data: Buffer.alloc(0), unixMode: S_IFDIR_0755 }]);
      const result = await readCentralDirectory(rangeReaderOf(zip), zip.length, LIMITS);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.issues).toEqual([]);
      expect(result.entries[0].isUnixNonRegularFile).toBe(false);
    });
  });

  describe('ledger F62: duplicate central-directory entry names are rejected outright, not silently collapsed', () => {
    it('rejects two entries with the exact same name', async () => {
      const zip = buildZip([
        { name: 'scf.json', data: Buffer.from('{"a":1}') },
        { name: 'scf.json', data: Buffer.from('{"a":2}') },
      ]);
      const result = await readCentralDirectory(rangeReaderOf(zip), zip.length, LIMITS);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues).toEqual([expect.objectContaining({ code: 'BUNDLE_DUPLICATE_NAME', path: 'scf.json' })]);
    });

    it('rejects two names that collide only after case-folding', async () => {
      const zip = buildZip([
        { name: 'images/A.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
        { name: 'images/a.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      ]);
      const result = await readCentralDirectory(rangeReaderOf(zip), zip.length, LIMITS);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues[0].code).toBe('BUNDLE_DUPLICATE_NAME');
    });

    it('rejects two names that collide only after Unicode NFC normalisation (combining vs. precomposed)', async () => {
      const precomposed = 'images/café.png'; // é as a single code point
      const decomposed = 'images/café.png'; // e + combining acute accent — same NFC form
      expect(precomposed.normalize('NFC')).toBe(decomposed.normalize('NFC'));
      const zip = buildZip([
        { name: precomposed, data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
        { name: decomposed, data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      ]);
      const result = await readCentralDirectory(rangeReaderOf(zip), zip.length, LIMITS);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues[0].code).toBe('BUNDLE_DUPLICATE_NAME');
    });

    it('does not flag two genuinely distinct names', async () => {
      const zip = buildZip([
        { name: 'images/a.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
        { name: 'images/b.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      ]);
      const result = await readCentralDirectory(rangeReaderOf(zip), zip.length, LIMITS);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.issues).toEqual([]);
    });
  });

  describe('ledger F49: Zip64 and multi-disk archives are rejected outright, not partially supported', () => {
    it('rejects Zip64 via the EOCD\'s 0xffff "many entries" sentinel', async () => {
      const zip = buildZip([{ name: 'a.txt', data: Buffer.from('x') }]);
      const eocdStart = zip.length - 22;
      zip.writeUInt16LE(0xffff, eocdStart + 8);
      zip.writeUInt16LE(0xffff, eocdStart + 10);
      const result = await readCentralDirectory(rangeReaderOf(zip), zip.length, LIMITS);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.map((i) => i.code)).toEqual(['BUNDLE_ZIP64_UNSUPPORTED']);
    });

    it("rejects Zip64 via the EOCD's 0xffffffff central directory size/offset sentinel", async () => {
      const zip = buildZip([{ name: 'a.txt', data: Buffer.from('x') }]);
      const eocdStart = zip.length - 22;
      zip.writeUInt32LE(0xffffffff, eocdStart + 12);
      const result = await readCentralDirectory(rangeReaderOf(zip), zip.length, LIMITS);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.map((i) => i.code)).toEqual(['BUNDLE_ZIP64_UNSUPPORTED']);
    });

    it('rejects a ZIP with a Zip64 end-of-central-directory locator immediately before the EOCD', async () => {
      const zip = buildZip([{ name: 'a.txt', data: Buffer.from('x') }]);
      const eocdStart = zip.length - 22;
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      const withLocator = Buffer.concat([zip.subarray(0, eocdStart), locator, zip.subarray(eocdStart)]);
      const result = await readCentralDirectory(rangeReaderOf(withLocator), withLocator.length, LIMITS);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.map((i) => i.code)).toEqual(['BUNDLE_ZIP64_UNSUPPORTED']);
    });

    it('rejects a multi-disk archive (non-zero disk number)', async () => {
      const zip = buildZip([{ name: 'a.txt', data: Buffer.from('x') }]);
      const eocdStart = zip.length - 22;
      zip.writeUInt16LE(1, eocdStart + 4); // disk number
      const result = await readCentralDirectory(rangeReaderOf(zip), zip.length, LIMITS);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.map((i) => i.code)).toEqual(['BUNDLE_ZIP_MULTIDISK_UNSUPPORTED']);
    });

    it("rejects a per-entry Zip64 sentinel in the central directory record itself", async () => {
      const zip = buildZip([{ name: 'a.txt', data: Buffer.from('x') }]);
      // The central directory record's compressed-size field is at a fixed offset from wherever the
      // central directory starts; find it by locating the CD signature (0x02014b50).
      const cdSig = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
      const cdIndex = zip.indexOf(cdSig);
      zip.writeUInt32LE(0xffffffff, cdIndex + 20); // compressed size
      const result = await readCentralDirectory(rangeReaderOf(zip), zip.length, LIMITS);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.map((i) => i.code)).toEqual(['BUNDLE_ZIP64_UNSUPPORTED']);
    });
  });

  it('rejects a central directory with trailing bytes after the declared entry count', async () => {
    const zip = buildZip([{ name: 'a.txt', data: Buffer.from('x') }]);
    const eocdStart = zip.length - 22;
    // Insert 10 garbage bytes right before the EOCD, without updating the EOCD's central-directory
    // size field to match — the parser should notice it didn't land exactly on the EOCD after
    // consuming the declared number of records.
    const withGarbage = Buffer.concat([zip.subarray(0, eocdStart), Buffer.alloc(10, 0x41), zip.subarray(eocdStart)]);
    // Central directory offset is unaffected (garbage is between CD and EOCD, at the end), but its
    // declared size must grow to cover the garbage for this to reach the "trailing bytes" check
    // rather than the "offset/size inconsistent" one.
    const eocdStart2 = withGarbage.length - 22;
    const originalCdSize = zip.readUInt32LE(eocdStart + 12);
    withGarbage.writeUInt32LE(originalCdSize + 10, eocdStart2 + 12);
    const result = await readCentralDirectory(rangeReaderOf(withGarbage), withGarbage.length, LIMITS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toEqual(['BUNDLE_ZIP_INVALID']);
  });
});
