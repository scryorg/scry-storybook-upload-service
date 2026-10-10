/**
 * Two sync runs on one source at the same time (feature sync-delta-upload, fix-parallel; stage UAT F30/F10: two builds, both
 * buildNumber 1, 800 credits for 200 pictures). The routes run over the real Worker Firestore client talking to a fake
 * Firestore REST endpoint that applies preconditions and increments atomically, and makes concurrent requests interleave.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/cloudflare', () => ({
  captureException: () => undefined,
  getCurrentScope: () => ({ setTag: () => undefined }),
  getTraceData: () => ({}),
}));

import { FirestoreServiceWorker } from '../services/firestore/firestore.worker.js';
import type { FirestoreService } from '../services/firestore/firestore.service.js';
import { FakeFirestoreRest } from './delta.rest-fake.js';
import { contentKeyHash, scfPrint } from './delta-build.js';
import { DEVICE_KEY, PROJECT, manifestBody, openAndUpload, pictures, postCommit, postManifest, putBlob, scfFor, setup, type ManifestAnswer } from './delta.test-support.js';

let rest: FakeFirestoreRest;
let restore: () => void;

function workerFirestore(): FirestoreServiceWorker {
  const svc = new FirestoreServiceWorker({
    projectId: 'firebase-proj',
    clientEmail: 'test@example.com',
    privateKey: '-----BEGIN PRIVATE KEY-----\\nZm9v\\n-----END PRIVATE KEY-----',
    serviceAccountId: 'upload-service',
  });
  (svc as unknown as { accessToken: string }).accessToken = 'test-token';
  (svc as unknown as { tokenExpiry: number }).tokenExpiry = Date.now() + 60_000;
  return svc;
}

const buildDocs = () => rest.collection(`projects/${PROJECT}/builds`);
const numberOf = (fields: Record<string, unknown>) => Number((fields.buildNumber as { integerValue: string }).integerValue);

beforeEach(() => {
  rest = new FakeFirestoreRest();
  restore = rest.install();
});
afterEach(() => {
  restore();
  vi.restoreAllMocks();
});

describe('build numbers under concurrency', () => {
  it('two delta builds created at the same moment get different numbers', async () => {
    const svc = workerFirestore();
    const data = { versionId: 'sync-1', zipUrl: '', delta: true as const, deltaDeadline: new Date(Date.now() + 3_600_000), source: { kind: 'x-scry-sync', platform: 'other' } };
    const [a, b, c] = await Promise.all([svc.createBuild(PROJECT, data), svc.createBuild(PROJECT, data), svc.createBuild(PROJECT, data)]);
    expect([a.buildNumber, b.buildNumber, c.buildNumber].sort()).toEqual([1, 2, 3]);
    expect(buildDocs().map((d) => numberOf(d.fields)).sort()).toEqual([1, 2, 3]);
  });

  it('the zip path (createBuild without delta) still repeats a number when two uploads race: pre-existing, not changed here', async () => {
    // Evidence for the followup: app.ts calls this same createBuild from the zip routes (upload, presign, bundle presign).
    const svc = workerFirestore();
    const data = { versionId: 'v1', zipUrl: 'https://example.test/storybook.zip' };
    const [a, b] = await Promise.all([svc.createBuild(PROJECT, data), svc.createBuild(PROJECT, data)]);
    expect([a.buildNumber, b.buildNumber]).toEqual([1, 1]);
  });
});

describe('guarantee-6 the same pictures from one source at the same time are one build and one charge', () => {
  it('two manifests and two commits at once make one build, one queue message, one number', async () => {
    const { server, queue } = setup({ firestore: workerFirestore() as unknown as FirestoreService });
    const pics = pictures(6);

    const [first, second] = await Promise.all([
      openAndUpload(server, PROJECT, DEVICE_KEY, pics, 'harness-instance-a'),
      openAndUpload(server, PROJECT, DEVICE_KEY, pics, 'harness-instance-b'),
    ]);
    expect(first.answer.buildId).toBe(second.answer.buildId);
    // The number is the one build's (a build that lost the race gave its number up).
    expect(second.answer.buildNumber).toBe(first.answer.buildNumber);

    const commits = await Promise.all([postCommit(server, PROJECT, DEVICE_KEY, first.answer.buildId), postCommit(server, PROJECT, DEVICE_KEY, second.answer.buildId)]);
    expect(commits.map((r) => r.status).sort()).toEqual([200, 202]);

    expect(buildDocs().map((d) => d.id)).toEqual([first.answer.buildId]);
    expect(queue.send).toHaveBeenCalledTimes(1);
    // The loser path really ran (not "the second manifest simply saw the first's record"): exactly one build row was created and
    // removed again. A regression in the atomic claim (both builds kept) leaves no DELETE and fails here.
    expect(rest.requests.filter((r) => r.startsWith('DELETE ') && r.includes('/builds/'))).toHaveLength(1);
  });

  it('the second manifest is not asked for pictures the first one already stored', async () => {
    const { server, bucket } = setup({ firestore: workerFirestore() as unknown as FirestoreService });
    const pics = pictures(4);
    const one = await openAndUpload(server, PROJECT, DEVICE_KEY, pics, 'harness-instance-a');
    const putsAfterFirst = bucket.puts.length;
    const two = await openAndUpload(server, PROJECT, DEVICE_KEY, pics, 'harness-instance-b');
    expect(two.answer.buildId).toBe(one.answer.buildId);
    expect(two.answer.objects.every((o) => !o.actions)).toBe(true);
    // Only the bookkeeping marker may be written again, never a picture or a second set of build files.
    expect(bucket.puts.slice(putsAfterFirst).filter((k) => /[0-9a-f]{64}$|\/builds\//.test(k))).toEqual([]);
  });

  it('a retry of the joining manifest (same Idempotency-Key) answers with the same build', async () => {
    const { server } = setup({ firestore: workerFirestore() as unknown as FirestoreService });
    const pics = pictures(3);
    const one = await openAndUpload(server, PROJECT, DEVICE_KEY, pics, 'harness-instance-a');
    const joined = await openAndUpload(server, PROJECT, DEVICE_KEY, pics, 'harness-instance-b');
    const again = await openAndUpload(server, PROJECT, DEVICE_KEY, pics, 'harness-instance-b');
    expect(joined.answer.buildId).toBe(one.answer.buildId);
    expect(again.answer.buildId).toBe(one.answer.buildId);
    expect(again.status).toBe(200);
    expect(buildDocs()).toHaveLength(1);
  });

  it('different pictures at the same time are separate builds with different numbers', async () => {
    const { server } = setup({ firestore: workerFirestore() as unknown as FirestoreService });
    const [a, b] = await Promise.all([
      openAndUpload(server, PROJECT, DEVICE_KEY, pictures(3, 1), 'harness-instance-a'),
      openAndUpload(server, PROJECT, DEVICE_KEY, pictures(3, 100), 'harness-instance-b'),
    ]);
    expect(a.answer.buildId).not.toBe(b.answer.buildId);
    expect([a.answer.buildNumber, b.answer.buildNumber].sort()).toEqual([1, 2]);
  });

  it('once the first build has finished, the same pictures open a new build', async () => {
    const { server } = setup({ firestore: workerFirestore() as unknown as FirestoreService });
    const pics = pictures(3);
    const one = await openAndUpload(server, PROJECT, DEVICE_KEY, pics, 'harness-instance-a');
    expect((await postCommit(server, PROJECT, DEVICE_KEY, one.answer.buildId)).status).toBe(202);
    const path = `projects/${PROJECT}/builds/${one.answer.buildId}`;
    rest.docs.get(path)!.fields.processingStatus = { stringValue: 'completed' };
    const two = await openAndUpload(server, PROJECT, DEVICE_KEY, pics, 'harness-instance-b');
    expect(two.answer.buildId).not.toBe(one.answer.buildId);
    expect(two.answer.buildNumber).toBe(2);
  });
});

/** The same pictures with the SCF edited in `keywords`: a different piece of work. */
const withKeyword = (pics: ReturnType<typeof pictures>, keyword: string) => {
  const scf = scfFor(pics);
  (scf.captures[0] as Record<string, unknown>)['x-scry-sync'] = { keywords: [keyword] };
  return { scf };
};

describe('P2-1 the SCF is part of the content key', () => {
  it('same pictures, different SCF at the same moment: two builds with two numbers', async () => {
    const { server } = setup({ firestore: workerFirestore() as unknown as FirestoreService });
    const pics = pictures(3);
    const [a, b] = await Promise.all([
      openAndUpload(server, PROJECT, DEVICE_KEY, pics, 'harness-instance-a', withKeyword(pics, 'spring')),
      openAndUpload(server, PROJECT, DEVICE_KEY, pics, 'harness-instance-b', withKeyword(pics, 'summer')),
    ]);
    expect(a.answer.buildId).not.toBe(b.answer.buildId);
    expect([a.answer.buildNumber, b.answer.buildNumber].sort()).toEqual([1, 2]);
    expect(buildDocs()).toHaveLength(2);
  });

  it('a keyword edited while the first sync of the same pictures is in flight is not dropped: it gets its own build', async () => {
    const { server } = setup({ firestore: workerFirestore() as unknown as FirestoreService });
    const pics = pictures(3);
    const one = await openAndUpload(server, PROJECT, DEVICE_KEY, pics, 'sync-run-first', withKeyword(pics, 'spring'));
    const two = await openAndUpload(server, PROJECT, DEVICE_KEY, pics, 'sync-run-second', withKeyword(pics, 'summer'));
    expect(two.status).toBe(201);
    expect(two.answer.buildId).not.toBe(one.answer.buildId);
    // The pictures are held already, so the edit costs no upload.
    expect(two.answer.objects.every((o) => !o.actions)).toBe(true);
  });

  it('same pictures, same SCF: one build (no regression of the join)', async () => {
    const { server } = setup({ firestore: workerFirestore() as unknown as FirestoreService });
    const pics = pictures(3);
    const [a, b] = await Promise.all([
      openAndUpload(server, PROJECT, DEVICE_KEY, pics, 'harness-instance-a', withKeyword(pics, 'spring')),
      openAndUpload(server, PROJECT, DEVICE_KEY, pics, 'harness-instance-b', withKeyword(pics, 'spring')),
    ]);
    expect(a.answer.buildId).toBe(b.answer.buildId);
    expect(buildDocs()).toHaveLength(1);
  });

  it('two runs of the same content differ only in the SCF createdAt (scry-node stamps new Date() per run): still one build', async () => {
    const { server } = setup({ firestore: workerFirestore() as unknown as FirestoreService });
    const pics = pictures(3);
    const stamped = (createdAt: string) => ({ scf: { ...scfFor(pics), createdAt } });
    const one = await openAndUpload(server, PROJECT, DEVICE_KEY, pics, 'harness-instance-a', stamped('2026-10-10T15:00:00.000Z'));
    const two = await openAndUpload(server, PROJECT, DEVICE_KEY, pics, 'harness-instance-b', stamped('2026-10-10T15:00:07.123Z'));
    expect(two.answer.buildId).toBe(one.answer.buildId);
    expect(buildDocs()).toHaveLength(1);
  });

  it('scfPrint ignores key order and the top-level createdAt only', () => {
    const pics = pictures(2);
    const scf = scfFor(pics);
    const reordered = Object.fromEntries(Object.entries(scf).reverse());
    expect(scfPrint(reordered)).toBe(scfPrint(scf));
    expect(scfPrint({ ...scf, createdAt: 'later' })).toBe(scfPrint(scf));
    const { createdAt: _gone, ...without } = scf;
    expect(scfPrint(without)).toBe(scfPrint(scf));
    // A createdAt nested in a capture is content, not a run stamp.
    const nested = { ...scf, captures: scf.captures.map((c, i) => (i === 0 ? { ...c, createdAt: 'x' } : c)) };
    expect(scfPrint(nested)).not.toBe(scfPrint(scf));
    // Array order is meaningful.
    expect(scfPrint({ ...scf, captures: [...scf.captures].reverse() })).not.toBe(scfPrint(scf));
    const key = (s: Record<string, unknown>) => contentKeyHash({ version: 'v', source: { kind: 'x-scry-sync', platform: 'other' }, images: {}, scf: s });
    expect(key(scf)).not.toBe(key({ ...scf, defaults: {} }));
  });
});

describe('P2-2 a joiner whose pictures arrive after the other client committed', () => {
  const answerOf = async (res: Response) => (await res.json()) as ManifestAnswer;

  it('A manifests, B joins, A uploads and commits, B PUTs and commits: 200s, nothing stored twice, one build, one queue message', async () => {
    const { server, bucket, queue } = setup({ firestore: workerFirestore() as unknown as FirestoreService });
    const pics = pictures(3);
    const body = manifestBody(pics);
    const a = await answerOf(await postManifest(server, PROJECT, DEVICE_KEY, body, { 'Idempotency-Key': 'sync-client-a' }));
    const bRes = await postManifest(server, PROJECT, DEVICE_KEY, body, { 'Idempotency-Key': 'sync-client-b' });
    const b = await answerOf(bRes);
    expect(bRes.status).toBe(200);
    expect(b.buildId).toBe(a.buildId);
    expect(b.objects.every((o) => o.actions)).toBe(true); // both were told to send everything

    for (const p of pics) expect((await putBlob(server, PROJECT, DEVICE_KEY, p.oid, p.bytes, a.buildId)).status).toBe(201);
    expect((await postCommit(server, PROJECT, DEVICE_KEY, a.buildId)).status).toBe(202);
    const storedBefore = bucket.puts.length;
    const deadlineBefore = rest.docs.get(`projects/${PROJECT}/builds/${a.buildId}`)!.fields.deltaDeadline;

    // B's pictures now arrive at a build that was committed meanwhile.
    for (const p of pics) {
      const res = await putBlob(server, PROJECT, DEVICE_KEY, p.oid, p.bytes, b.buildId);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ oid: p.oid, size: p.bytes.byteLength });
    }
    expect(bucket.puts).toHaveLength(storedBefore); // not stored again
    expect(rest.docs.get(`projects/${PROJECT}/builds/${a.buildId}`)!.fields.deltaDeadline).toEqual(deadlineBefore);

    const commitB = await postCommit(server, PROJECT, DEVICE_KEY, b.buildId);
    expect(commitB.status).toBe(200);
    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(buildDocs()).toHaveLength(1);
  });

  it('a client that does renegotiate after the committed build refused nothing ends in success with no picture re-sent (same Idempotency-Key)', async () => {
    const { server, queue } = setup({ firestore: workerFirestore() as unknown as FirestoreService });
    const pics = pictures(2);
    const body = manifestBody(pics);
    const a = await answerOf(await postManifest(server, PROJECT, DEVICE_KEY, body, { 'Idempotency-Key': 'sync-client-a' }));
    await answerOf(await postManifest(server, PROJECT, DEVICE_KEY, body, { 'Idempotency-Key': 'sync-client-b' }));
    for (const p of pics) await putBlob(server, PROJECT, DEVICE_KEY, p.oid, p.bytes, a.buildId);
    expect((await postCommit(server, PROJECT, DEVICE_KEY, a.buildId)).status).toBe(202);

    const again = await postManifest(server, PROJECT, DEVICE_KEY, body, { 'Idempotency-Key': 'sync-client-b' });
    const answer = await answerOf(again);
    expect(again.status).toBe(200);
    expect(answer.buildId).toBe(a.buildId);
    expect(answer.objects.some((o) => o.actions)).toBe(false);
    expect((await postCommit(server, PROJECT, DEVICE_KEY, answer.buildId)).status).toBe(200);
    expect(queue.send).toHaveBeenCalledTimes(1);
  });

  it('still refused: a picture the build does not list, a picture Scry does not hold, and another project\'s key', async () => {
    const { server, bucket } = setup({ firestore: workerFirestore() as unknown as FirestoreService });
    const pics = pictures(2);
    const a = await answerOf(await postManifest(server, PROJECT, DEVICE_KEY, manifestBody(pics), { 'Idempotency-Key': 'sync-client-a' }));
    for (const p of pics) await putBlob(server, PROJECT, DEVICE_KEY, p.oid, p.bytes, a.buildId);
    expect((await postCommit(server, PROJECT, DEVICE_KEY, a.buildId)).status).toBe(202);

    const stranger = pictures(1, 500)[0];
    expect((await putBlob(server, PROJECT, DEVICE_KEY, stranger.oid, stranger.bytes, a.buildId)).status).toBe(409);
    // Garbage collected between commit and the late PUT: the bytes are not held, so the PUT is not "idempotent".
    for (const key of bucket.blobKeys(PROJECT)) await bucket.delete(key);
    expect((await putBlob(server, PROJECT, DEVICE_KEY, pics[0].oid, pics[0].bytes, a.buildId)).status).toBe(409);
  });
});

describe('P3-1 taking over a finished build\'s record is exclusive', () => {
  it('two manifests for the same pictures after the first build finished make ONE new build', async () => {
    const { server, queue } = setup({ firestore: workerFirestore() as unknown as FirestoreService });
    const pics = pictures(3);
    const one = await openAndUpload(server, PROJECT, DEVICE_KEY, pics, 'sync-run-first');
    expect((await postCommit(server, PROJECT, DEVICE_KEY, one.answer.buildId)).status).toBe(202);
    rest.docs.get(`projects/${PROJECT}/builds/${one.answer.buildId}`)!.fields.processingStatus = { stringValue: 'completed' };

    const [a, b] = await Promise.all([
      openAndUpload(server, PROJECT, DEVICE_KEY, pics, 'sync-run-second-a'),
      openAndUpload(server, PROJECT, DEVICE_KEY, pics, 'sync-run-second-b'),
    ]);
    expect(a.answer.buildId).toBe(b.answer.buildId);
    expect(a.answer.buildId).not.toBe(one.answer.buildId);
    expect(buildDocs()).toHaveLength(2);
    expect((await postCommit(server, PROJECT, DEVICE_KEY, a.answer.buildId)).status).toBe(202);
    expect((await postCommit(server, PROJECT, DEVICE_KEY, b.answer.buildId)).status).toBe(200);
    expect(queue.send).toHaveBeenCalledTimes(2); // the first build and the one new build
    // The takeover is a conditional write (currentDocument.updateTime), not an unconditional PATCH.
    expect(rest.requests.some((r) => r.startsWith('PATCH /projects/') && r.includes('/deltaKeys/content-') && r.includes('currentDocument.updateTime'))).toBe(true);
  });
});
