/**
 * Minimal ambient types for the `archiver` package (pinned to `7.0.1` here, matching our own CLI's
 * and sbcov's real dependency — see package.json). `archiver` ships no types of its own, and the
 * `@types/archiver` package on npm targets the unrelated 8.x rewrite (a totally different, class-based
 * API) — using it against our pinned 7.x runtime would just be a different flavor of wrong. This
 * covers only the handful of calls `archiver-helpers.ts` actually makes.
 */
declare module 'archiver' {
  import type { Readable } from 'node:stream';

  interface ArchiverZlibOptions {
    level?: number;
  }

  interface ArchiverOptions {
    zlib?: ArchiverZlibOptions;
    store?: boolean;
  }

  interface ArchiverEntryData {
    name: string;
  }

  interface Archiver extends Readable {
    append(source: Buffer | Readable | string, data: ArchiverEntryData): Archiver;
    file(filepath: string, data: ArchiverEntryData): Archiver;
    directory(dirpath: string, destpath: string | false, data?: ArchiverEntryData): Archiver;
    finalize(): Promise<void>;
  }

  function archiver(format: 'zip', options?: ArchiverOptions): Archiver;
  export = archiver;
}
