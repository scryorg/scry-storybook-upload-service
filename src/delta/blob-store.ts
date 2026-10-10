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

/** Pages of 1,000 keys read before `has` stops listing and checks the rest one by one. */
const MAX_LIST_PAGES = 50;
/** Few hashes are cheaper to HEAD than to list, and the leftovers after the page cap are HEADed up to this many. */
const HEAD_LIMIT = 50;

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

  /** Which of `oids` this project holds. Looks only under `_blobs/<projectId>/`. */
  async has(projectId: string, oids: ReadonlyArray<string>): Promise<Set<string>> {
    const prefix = blobPrefix(projectId);
    const wanted = new Set(oids);
    for (const oid of wanted) assertOid(oid);
    const held = new Set<string>();
    if (wanted.size === 0) return held;
    if (wanted.size <= HEAD_LIMIT) {
      await this.headEach(prefix, wanted, held);
      return held;
    }

    await this.listHeld(prefix, wanted, held);
    // The listing may have been cut short: settle a small remainder one by one, report a big one as missing (the client
    // re-sends it and the PUT answers "already held", so the build is correct either way).
    const rest = [...wanted].filter((oid) => !held.has(oid));
    if (rest.length > 0 && rest.length <= HEAD_LIMIT) await this.headEach(prefix, rest, held);
    return held;
  }

  private async headEach(prefix: string, oids: Iterable<string>, held: Set<string>): Promise<void> {
    for (const oid of oids) if (await this.storage.head(`${prefix}${oid}`)) held.add(oid);
  }

  private async listHeld(prefix: string, wanted: ReadonlySet<string>, held: Set<string>): Promise<void> {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES && held.size < wanted.size; page++) {
      const result = await this.storage.listKeys(prefix, { cursor, limit: 1000 });
      for (const entry of result.keys) {
        const oid = entry.key.slice(prefix.length);
        if (wanted.has(oid)) held.add(oid);
      }
      cursor = result.cursor;
      if (!cursor) return;
    }
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
