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
import { DEVICE_KEY, PROJECT, openAndUpload, pictures, postCommit, setup } from './delta.test-support.js';

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
