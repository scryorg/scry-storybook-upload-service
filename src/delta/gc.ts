// Clean-up of the project-scoped picture store (feature sync-delta-upload, D2: daily, inside the hourly cron).
//
// G8: a stored picture used by any source's latest build, or by any build in the last 30 days, is never deleted.
// The pass is built to fail safe: it only ever looks at pictures older than the retention window, it deletes one only
// after reading the picture list of every build that could still use it, and whenever it cannot be sure (a build list that
// may be cut short, a picture list it cannot read, any error) it skips that project and deletes nothing there.

import { log } from '../lib/log.js';
import type { FirestoreService } from '../services/firestore/firestore.service.js';
import type { Build } from '../services/firestore/firestore.types.js';
import type { StorageService } from '../services/storage/storage.service.js';
import { BLOB_ROOT, useMarkerPrefix } from './blob-store.js';
import { buildFileKey } from './delta-build.js';
import { BLOB_RETENTION_DAYS } from './limits.js';

/** Builds read per project. A project with this many delta builds or more is skipped (it cannot be listed whole). */
export const GC_BUILD_PAGE = 500;
/** A manifest opened this recently (see `BlobStore.touch`) may have been told a picture is held that clean-up's snapshot does not know about. */
export const GC_MANIFEST_GRACE_MS = 2 * 60_000;
/** Pictures looked at per run; the rest wait for the next day. */
export const GC_MAX_BLOBS_PER_RUN = 25_000;

const BLOB_KEY = /^_blobs\/([A-Za-z0-9_-]{1,128})\/([0-9a-f]{64})$/;
const DAY_MS = 86_400_000;
const RESOLVED = new Set(['queued', 'processing', 'completed', 'partial']);

export interface GcDeps {
  firestore: Pick<FirestoreService, 'listDeltaBuilds'>;
  storage: Pick<StorageService, 'listKeys' | 'getObjectStream' | 'delete'>;
  now?: Date;
  maxBlobs?: number;
}

export interface GcResult {
  scanned: number;
  old: number;
  deleted: number;
  deletedBytes: number;
  skippedProjects: Array<{ project: string; reason: string }>;
  errors: number;
}

/** True once a day: the hourly cron runs this pass in the 03:00 UTC hour only. */
export const gcDue = (now: Date): boolean => now.getUTCHours() === 3;

const sourceOf = (b: Build): string => `${b.source?.kind ?? ''}:${b.source?.platform ?? ''}`;

/** Builds whose pictures must stay: made inside the window, plus the newest (and newest non-failed) build of every source. */
export function protectedBuilds(builds: ReadonlyArray<Build>, cutoff: Date): Build[] {
  const keep = new Set<Build>();
  const newest = new Map<string, Build>();
  const newestOk = new Map<string, Build>();
  for (const b of builds) {
    if (!b.createdAt || b.createdAt.getTime() >= cutoff.getTime()) keep.add(b);
    const src = sourceOf(b);
    if (!newest.has(src) || b.buildNumber > newest.get(src)!.buildNumber) newest.set(src, b);
    if (b.processingStatus !== 'failed' && (!newestOk.has(src) || b.buildNumber > newestOk.get(src)!.buildNumber)) newestOk.set(src, b);
  }
  for (const b of [...newest.values(), ...newestOk.values()]) keep.add(b);
  return [...keep];
}

type Referenced = { ok: true; oids: Set<string> } | { ok: false; reason: string };
type Candidates = Map<string, Array<{ key: string; oid: string; size: number }>>;

/** A build's picture list: the oids it uses, or why it cannot be read. `null` = there is no list. */
async function readPictureList(storage: GcDeps['storage'], key: string): Promise<string[] | null | 'unreadable'> {
  const stream = await storage.getObjectStream(key);
  if (!stream) return null;
  try {
    const parsed: unknown = JSON.parse(await new Response(stream).text());
    if (!parsed || typeof parsed !== 'object') return 'unreadable';
    return Object.values(parsed as Record<string, { oid?: unknown }>).flatMap((entry) => (typeof entry?.oid === 'string' ? [entry.oid] : []));
  } catch {
    return 'unreadable';
  }
}

async function referencedOids(storage: GcDeps['storage'], project: string, builds: ReadonlyArray<Build>): Promise<Referenced> {
  const oids = new Set<string>();
  for (const build of builds) {
    const list = await readPictureList(storage, buildFileKey(project, build.versionId, build.buildNumber, 'images.json'));
    if (list === 'unreadable') return { ok: false, reason: 'picture-list-unreadable' };
    if (list === null) {
      // A build that never got its list (failed or still being opened) uses nothing; an accepted one without a list is not understood.
      if (build.processingStatus && RESOLVED.has(build.processingStatus)) return { ok: false, reason: 'picture-list-missing' };
      continue;
    }
    for (const oid of list) oids.add(oid);
  }
  return { ok: true, oids };
}

/** Lists `_blobs/` and keeps the pictures older than the window, grouped by project. */
async function collectCandidates(storage: GcDeps['storage'], cutoff: Date, limit: number, result: GcResult): Promise<Candidates> {
  const candidates: Candidates = new Map();
  let cursor: string | undefined;
  do {
    const page = await storage.listKeys(BLOB_ROOT, { cursor, limit: 1000 });
    for (const entry of page.keys) {
      result.scanned++;
      const match = BLOB_KEY.exec(entry.key);
      if (!match || entry.uploaded.getTime() >= cutoff.getTime()) continue;
      result.old++;
      const list = candidates.get(match[1]) ?? [];
      list.push({ key: entry.key, oid: match[2], size: entry.size });
      candidates.set(match[1], list);
    }
    cursor = page.cursor;
  } while (cursor && result.scanned < limit);
  return candidates;
}

/** True when a manifest of the project was opened within the grace window (checked live, right before a delete). */
async function manifestInFlight(deps: GcDeps, project: string): Promise<boolean> {
  const page = await deps.storage.listKeys(useMarkerPrefix(project), { limit: 1 });
  const marker = page.keys[0];
  if (!marker) return false;
  const clock = (deps.now ?? new Date()).getTime();
  return marker.uploaded.getTime() > clock - GC_MANIFEST_GRACE_MS;
}

/** Deletes one project's unreferenced old pictures, or records why it was skipped. */
async function sweepProject(deps: GcDeps, project: string, blobs: ReadonlyArray<{ key: string; oid: string; size: number }>, cutoff: Date, result: GcResult): Promise<void> {
  const builds = await deps.firestore.listDeltaBuilds(project, GC_BUILD_PAGE);
  if (builds.length >= GC_BUILD_PAGE) {
    result.skippedProjects.push({ project, reason: 'too-many-builds' });
    return;
  }
  const refs = await referencedOids(deps.storage, project, protectedBuilds(builds, cutoff));
  if (!refs.ok) {
    result.skippedProjects.push({ project, reason: refs.reason });
    return;
  }
  for (const blob of blobs) {
    if (refs.oids.has(blob.oid)) continue;
    // The snapshot above can be minutes old: a manifest that arrived since may already have been told this picture is held.
    if (await manifestInFlight(deps, project)) {
      result.skippedProjects.push({ project, reason: 'manifest-in-flight' });
      return;
    }
    await deps.storage.delete(blob.key);
    result.deleted++;
    result.deletedBytes += blob.size;
  }
}

/** One pass over `_blobs/`: deletes pictures older than the retention window that no protected build lists. */
export async function runBlobGc(deps: GcDeps): Promise<GcResult> {
  const now = deps.now ?? new Date();
  const cutoff = new Date(now.getTime() - BLOB_RETENTION_DAYS * DAY_MS);
  const result: GcResult = { scanned: 0, old: 0, deleted: 0, deletedBytes: 0, skippedProjects: [], errors: 0 };

  const candidates = await collectCandidates(deps.storage, cutoff, deps.maxBlobs ?? GC_MAX_BLOBS_PER_RUN, result);
  for (const [project, blobs] of candidates) {
    try {
      await sweepProject(deps, project, blobs, cutoff, result);
    } catch {
      result.errors++;
      result.skippedProjects.push({ project, reason: 'error' });
    }
  }

  log.info('delta gc', {
    attrs: { 'delta.items': result.deleted, 'delta.bytes': result.deletedBytes, 'delta.items_skipped': result.old - result.deleted },
  });
  return result;
}
