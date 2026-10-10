/**
 * sync-delta-upload on the Node service: claimDeltaCommit / releaseDeltaCommit (the Worker has had them since the delta routes
 * landed; without them the Node service fell back to a plain read-then-write, so two concurrent commits could both queue).
 * `firebase-admin` is replaced by an in-memory Firestore whose transactions run one at a time, as Firestore's retry loop makes them.
 */
import { describe, expect, it, vi } from 'vitest';

const store = new Map<string, Record<string, unknown>>();
let lock: Promise<unknown> = Promise.resolve();
const DELETE = Symbol('delete');
/** Seconds of each document's last write, like Firestore's updateTime; a write with a `lastUpdateTime` precondition must match it. */
const stamps = new Map<string, number>();
let clock = 100;

const docRef = (path: string) => ({
  path,
  get: async () => ({ exists: store.has(path), id: path.split('/').pop(), data: () => store.get(path), updateTime: stamps.has(path) ? { seconds: stamps.get(path), nanoseconds: 0 } : undefined }),
  update: async (patch: Record<string, unknown>, precondition?: { lastUpdateTime: { seconds: number } }) => {
    const current = store.get(path);
    if (!current) throw Object.assign(new Error('not found'), { code: 5 });
    if (precondition && precondition.lastUpdateTime.seconds !== stamps.get(path)) throw Object.assign(new Error('changed'), { code: 9 });
    stamps.set(path, ++clock);
    for (const [k, v] of Object.entries(patch)) {
      if (v === DELETE) delete current[k];
      else current[k] = v;
    }
  },
});

vi.mock('firebase-admin', () => ({
  default: {
    firestore: Object.assign(
      () => ({
        doc: docRef,
        runTransaction: (fn: (t: unknown) => Promise<unknown>) => {
          const run = lock.then(() => fn({ get: (ref: { get: () => Promise<unknown> }) => ref.get(), update: (ref: { update: (p: Record<string, unknown>) => Promise<void> }, patch: Record<string, unknown>) => ref.update(patch) }));
          lock = run.catch(() => undefined);
          return run;
        },
      }),
      { FieldValue: { delete: () => DELETE, serverTimestamp: () => 'now', increment: (n: number) => n }, Timestamp: class { constructor(readonly seconds: number, readonly nanoseconds: number) {} } }
    ),
  },
}));

import { FirestoreServiceNode } from './firestore.node.js';

const PATH = 'projects/p1/builds/b1';

describe('FirestoreServiceNode delta commit claim', () => {
  it('of many concurrent commits exactly one claims the build', async () => {
    store.set(PATH, { delta: true });
    const svc = new FirestoreServiceNode();
    const results = await Promise.all(Array.from({ length: 5 }, () => svc.claimDeltaCommit('p1', 'b1', { lastStep: 'enqueue', outcome: 'ok' } as never)));
    expect(results.filter((r) => r === 'claimed')).toHaveLength(1);
    expect(results.filter((r) => r === 'already')).toHaveLength(4);
    expect(store.get(PATH)?.processingStatus).toBe('queued');
  });

  it('answers missing for a build that is not there', async () => {
    expect(await new FirestoreServiceNode().claimDeltaCommit('p1', 'nope')).toBe('missing');
  });

  it('release gives the claim back so the client can commit again', async () => {
    store.set(PATH, { delta: true });
    const svc = new FirestoreServiceNode();
    expect(await svc.claimDeltaCommit('p1', 'b1')).toBe('claimed');
    await svc.releaseDeltaCommit('p1', 'b1');
    expect(store.get(PATH)?.processingStatus).toBeUndefined();
    expect(await svc.claimDeltaCommit('p1', 'b1')).toBe('claimed');
  });
});

describe('FirestoreServiceNode replaceDeltaKeyIfUnchanged (exclusive takeover of a stale "same pictures" record)', () => {
  const KEY = 'projects/p1/deltaKeys/content-abc';
  const record = (buildId: string) => ({ buildId, digest: 'content-abc', createdAt: new Date(), expireAt: new Date(Date.now() + 60_000) });

  it('of many takeovers that read the same version exactly one replaces the record', async () => {
    store.set(KEY, { ...record('old') });
    stamps.set(KEY, 5);
    const svc = new FirestoreServiceNode();
    const read = await svc.getDeltaKey('p1', 'content-abc');
    expect(read?.version).toBe('5.0');
    const results = await Promise.all(['b1', 'b2', 'b3', 'b4'].map((id) => svc.replaceDeltaKeyIfUnchanged('p1', 'content-abc', record(id), read!.version!)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(['b1', 'b2', 'b3', 'b4']).toContain(store.get(KEY)?.buildId);
  });

  it('is false when the record was removed since it was read', async () => {
    store.set(KEY, { ...record('old') });
    stamps.set(KEY, 7);
    const svc = new FirestoreServiceNode();
    const read = await svc.getDeltaKey('p1', 'content-abc');
    store.delete(KEY);
    expect(await svc.replaceDeltaKeyIfUnchanged('p1', 'content-abc', record('late'), read!.version!)).toBe(false);
    expect(store.has(KEY)).toBe(false);
  });
});
