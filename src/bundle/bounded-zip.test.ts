import { describe, expect, it } from 'vitest';
import { readBoundedZip } from './bounded-zip.js';
import { buildZip } from './__tests__/test-helpers.js';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // just the magic bytes

describe('readBoundedZip', () => {
  it('reads a well-formed ZIP into a bundle-relative path -> bytes map', () => {
    const zip = buildZip([
      { name: 'scf.json', data: Buffer.from('{}') },
      { name: 'images/a.png', data: png },
    ]);
    const result = readBoundedZip(zip);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files.size).toBe(2);
      expect(new TextDecoder().decode(result.files.get('scf.json'))).toBe('{}');
      expect(result.files.get('images/a.png')).toEqual(new Uint8Array(png));
    }
  });

  it('rejects a buffer with no end-of-central-directory record', () => {
    const result = readBoundedZip(Buffer.from('not a zip'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain('BUNDLE_ZIP_INVALID');
  });

  it.each(['../../../etc/passwd', '/etc/passwd', 'a/../../b.png', 'C:\\evil.png', 'a\\b.png'])(
    'rejects the unsafe raw entry name %s (path traversal, ledger F11)',
    (name) => {
      const zip = buildZip([{ name, data: png }]);
      const result = readBoundedZip(zip);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues).toEqual([expect.objectContaining({ code: 'BUNDLE_UNSAFE_PATH', path: name })]);
      }
    }
  );

  it('rejects a unix symlink entry outright (ledger F11)', () => {
    const zip = buildZip([
      { name: 'scf.json', data: Buffer.from('{}') },
      { name: 'images/a.png', data: png, unixMode: 0o120777 }, // S_IFLNK
    ]);
    const result = readBoundedZip(zip);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([expect.objectContaining({ code: 'BUNDLE_SYMLINK_REJECTED', path: 'images/a.png' })]);
    }
  });

  it('rejects a ZIP with more entries than the configured limit', () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ name: `images/${i}.png`, data: png }));
    const zip = buildZip(entries);
    const result = readBoundedZip(zip, { maxEntries: 3, maxTotalUncompressedBytes: 1e9, maxCompressionRatio: 1e9 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toEqual(['BUNDLE_TOO_MANY_ENTRIES']);
  });

  it('rejects when the central directory\'s declared total uncompressed size exceeds the limit (zip bomb, ledger F11)', () => {
    // A tiny entry that *claims* to be enormous once "inflated" — readBoundedZip must catch this
    // from the central directory's declared size, without ever calling inflateRawSync on it.
    // (2_000_000_000 is the largest round number that still fits the ZIP format's 32-bit field.)
    const zip = buildZip([{ name: 'images/a.png', data: png, declaredUncompressedSize: 2_000_000_000 }]);
    const result = readBoundedZip(zip, { maxEntries: 1000, maxTotalUncompressedBytes: 1_000_000, maxCompressionRatio: 1e9 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toEqual(['BUNDLE_TOO_LARGE']);
  });

  it('rejects a single entry whose declared compression ratio is implausible (second zip-bomb signal)', () => {
    const zip = buildZip([{ name: 'images/a.png', data: png, declaredUncompressedSize: png.length * 10_000 }]);
    const result = readBoundedZip(zip, { maxEntries: 1000, maxTotalUncompressedBytes: 1e12, maxCompressionRatio: 200 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain('BUNDLE_COMPRESSION_RATIO');
  });

  it('skips directory entries', () => {
    const zip = buildZip([
      { name: 'images/', data: Buffer.alloc(0) },
      { name: 'images/a.png', data: png },
    ]);
    const result = readBoundedZip(zip);
    expect(result.ok).toBe(true);
    if (result.ok) expect([...result.files.keys()]).toEqual(['images/a.png']);
  });

  it('reports every unsafe/symlink entry at once, not just the first', () => {
    const zip = buildZip([
      { name: '../evil1.png', data: png },
      { name: '../evil2.png', data: png },
    ]);
    const result = readBoundedZip(zip);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toHaveLength(2);
  });
});
