// The project-scoped picture store behind /delta (feature sync-delta-upload). One of the two modules the routes are
// thin adapters over (the swap seam: an LFS-compatible route could sit over the same two modules).
//
//   _blobs/<projectId>/<sha256 hex>   content-addressed, private bucket, never shared between projects (G1)
//
// Every key is built here from a project id that the caller's key was verified for, so a lookup can only ever
// consider that project's own prefix: there is no call that answers "does any project hold this hash".

import { VERIFIED_PROJECT } from '../middleware/auth.js';
import type { StorageService } from '../services/storage/storage.service.js';
import { SHA256_HEX } from './limits.js';

export const BLOB_ROOT = '_blobs/';
/** `_blobuse/<projectId>/touch`: written whenever a manifest of the project is being opened, read by clean-up (G8, see `touch`). */
export const USE_ROOT = '_blobuse/';

export const useMarkerPrefix = (projectId: string): string => {
  assertProject(projectId);
  return `${USE_ROOT}${projectId}/`;
};

/** Few hashes are cheaper to HEAD than to list; at most this many are HEADed one by one. */
const HEAD_LIMIT = 50;

/** The 64-hex string just below `oid` (all zeros stays all zeros: listing after the bare prefix starts at the first key). */
function hexBefore(oid: string): string {
  const n = BigInt(`0x${oid}`);
  return n === 0n ? '' : (n - 1n).toString(16).padStart(64, '0');
}

export class BlobHashMismatch extends Error {
  constructor() {
    super('bytes do not hash to the object id');
    this.name = 'BlobHashMismatch';
  }
}

/** The bytes hash correctly but are not a picture type the SCF allows; nothing was written. */
export class BlobRejected extends Error {
  constructor() {
    super('bytes are not an accepted picture type');
    this.name = 'BlobRejected';
  }
}

export function blobPrefix(projectId: string): string {
  assertProject(projectId);
  return `${BLOB_ROOT}${projectId}/`;
}

export function blobKey(projectId: string, oid: string): string {
  assertOid(oid);
  return `${blobPrefix(projectId)}${oid}`;
}

function assertProject(projectId: string): void {
  if (!VERIFIED_PROJECT.test(projectId)) throw new Error('invalid project id');
}

function assertOid(oid: string): void {
  if (!SHA256_HEX.test(oid)) throw new Error('invalid object id');
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class BlobStore {
  constructor(private readonly storage: StorageService) {}

  /**
   * Which of `oids` this project holds. Looks only under `_blobs/<projectId>/`. The answer is exact at any project size: a
   * few hashes are HEADed, many are found by listing pages that start just before the next wanted hash (the keys are sorted,
   * so the stretch between two wanted hashes is never read).
   */
  async has(projectId: string, oids: ReadonlyArray<string>): Promise<Set<string>> {
    const prefix = blobPrefix(projectId);
    const wanted = [...new Set(oids)].sort();
    for (const oid of wanted) assertOid(oid);
    const held = new Set<string>();
    if (wanted.length === 0) return held;
    if (wanted.length <= HEAD_LIMIT) {
      await this.headEach(prefix, wanted, held);
      return held;
    }
    await this.listHeld(prefix, wanted, held);
    return held;
  }

  private async headEach(prefix: string, oids: Iterable<string>, held: Set<string>): Promise<void> {
    for (const oid of oids) if (await this.storage.head(`${prefix}${oid}`)) held.add(oid);
  }

  /** `wanted` is sorted. Each round lists from just before the first hash not yet settled and settles every wanted hash the page passes. */
  private async listHeld(prefix: string, wanted: ReadonlyArray<string>, held: Set<string>): Promise<void> {
    const wantedSet = new Set(wanted);
    let next = 0;
    while (next < wanted.length) {
      if (wanted.length - next <= HEAD_LIMIT) {
        await this.headEach(prefix, wanted.slice(next), held);
        return;
      }
      const page = await this.storage.listKeys(prefix, { startAfter: `${prefix}${hexBefore(wanted[next])}`, limit: 1000 });
      for (const entry of page.keys) {
        const oid = entry.key.slice(prefix.length);
        if (wantedSet.has(oid)) held.add(oid);
      }
      if (!page.cursor) return; // the listing ended: every wanted hash past this point is not held
      const last = page.keys[page.keys.length - 1].key.slice(prefix.length);
      while (next < wanted.length && wanted[next] <= last) next++;
    }
  }

  /**
   * Marks the project as in use right now. A manifest answers "held" for old pictures before its build row exists, and clean-up
   * works from a snapshot of the build rows, so clean-up reads this marker immediately before every delete and leaves the
   * project alone while it is fresh. One tiny write per manifest; call it before `has`.
   */
  async touch(projectId: string): Promise<void> {
    await this.storage.putObject(`${useMarkerPrefix(projectId)}touch`, new Uint8Array(0), { contentType: 'application/octet-stream' });
  }

  /** True when this project already holds the object. */
  async holds(projectId: string, oid: string): Promise<boolean> {
    return (await this.storage.head(blobKey(projectId, oid))) !== null;
  }

  /**
   * Stores `bytes` under their own fingerprint. The Worker hashes them first and refuses a mismatch before anything is
   * written (G3); R2 then checks the same hash again on the write. Returns `held` without writing when the
   * object is already there.
   */
  async put(projectId: string, oid: string, bytes: Uint8Array, accept?: (bytes: Uint8Array) => boolean): Promise<'stored' | 'held'> {
    const key = blobKey(projectId, oid);
    if ((await sha256Hex(bytes)) !== oid) throw new BlobHashMismatch();
    if (accept && !accept(bytes)) throw new BlobRejected();
    if (await this.storage.head(key)) return 'held';
    await this.storage.putObject(key, bytes, { contentType: 'application/octet-stream', sha256: oid });
    return 'stored';
  }
}
