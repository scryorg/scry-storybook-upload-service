/**
 * Builds real ZIPs with the `archiver` package — the same package our own CLI (`scry-node`'s
 * `lib/scf.js`) and sbcov use to build SCF bundles (see package.json's `archiver` dependency, pinned
 * to the same `7.0.1` those two use). Ledger F49: `archiver` sets general-purpose flag bit 3 ("data
 * descriptor follows") on every entry regardless of input shape — verified below for buffer, file,
 * and directory inputs — which is exactly what `bounded-zip.ts`'s central-directory-driven reader
 * exists to accept (the old reader rejected every such entry, i.e. every real bundle).
 */
import archiver from 'archiver';

async function collectArchive(configure: (archive: ReturnType<typeof archiver>) => void, options: Parameters<typeof archiver>[1] = { zlib: { level: 9 } }): Promise<Buffer> {
  const archive = archiver('zip', options);
  const chunks: Buffer[] = [];
  archive.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    archive.on('end', resolve);
    archive.on('close', resolve);
    archive.on('error', reject);
  });
  configure(archive);
  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

export interface ArchiverBufferEntry {
  name: string;
  data: Buffer;
}

/** A real ZIP built entirely from in-memory buffer entries (`archive.append(Buffer, ...)`). */
export async function archiverZipFromBuffers(
  entries: ArchiverBufferEntry[],
  options?: Parameters<typeof archiver>[1]
): Promise<Buffer> {
  return collectArchive((archive) => {
    for (const entry of entries) archive.append(entry.data, { name: entry.name });
  }, options);
}

/** A real ZIP built by recursively zipping an on-disk directory (`archive.directory(...)`) —
 *  exercises archiver's async, `fs.stat`-driven file/directory input path, distinct from the
 *  synchronous buffer path above. */
export async function archiverZipFromDirectory(dir: string, options?: Parameters<typeof archiver>[1]): Promise<Buffer> {
  return collectArchive((archive) => {
    archive.directory(dir, false);
  }, options);
}

/** A real ZIP mixing all three input shapes `archiver` accepts (buffer, on-disk file, on-disk
 *  directory) in one archive — the exact combination ledger F49 verified sets the data-descriptor
 *  flag on every resulting entry, no matter which shape produced it. */
export async function archiverZipMixedInputs(
  bufferEntries: ArchiverBufferEntry[],
  filePath: string,
  fileEntryName: string,
  dirPath: string,
  dirEntryPrefix: string,
  options?: Parameters<typeof archiver>[1]
): Promise<Buffer> {
  return collectArchive((archive) => {
    for (const entry of bufferEntries) archive.append(entry.data, { name: entry.name });
    archive.file(filePath, { name: fileEntryName });
    archive.directory(dirPath, dirEntryPrefix);
  }, options);
}
