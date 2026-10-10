/**
 * /delta routes (feature sync-delta-upload, PR 1).
 * Guarantee tests are named `guarantee-N <sentence>` so the review can find them; the acceptance rows they cover are noted on each.
 * Set SCRY_RECORD_FIXTURES=1 to (re)write the request/response fixtures under test/fixtures/delta/; without it each recorded
 * exchange is compared with the committed file, so a change in a wire shape fails here first.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/cloudflare', () => ({
  captureException: () => undefined,
  getCurrentScope: () => ({ setTag: () => undefined }),
  getTraceData: () => ({}),
}));

import { sweepOrphanBundleBuilds, type OrphanSweepStore } from '../bundle/orphan-sweep.js';
import { log } from '../lib/log.js';
import { ATTRS } from '../lib/scry-log/attrs-registry.js';
import { BlobStore } from './blob-store.js';
import { buildFileKey, keyHash } from './delta-build.js';
import { GC_BUILD_PAGE, GC_MANIFEST_GRACE_MS, GC_MARKER_RECHECK_EVERY, gcDue, runBlobGc } from './gc.js';
import { MAX_BLOB_BYTES, MAX_MANIFEST_BYTES, MAX_PICTURES } from './limits.js';
import { BLOBS_PER_MINUTE, MANIFESTS_PER_MINUTE } from './rate-limit.js';
import {
  CI_KEY,
  DEVICE_KEY,
  IDEMPOTENCY,
  OTHER_DEVICE_KEY,
  OTHER_PROJECT,
  OTHER_PROJECT_KEY,
  PLAIN_KEY,
  PROJECT,
  REVOKED_KEY,
  fakePng,
  manifestBody,
  openAndUpload,
  pictures,
  postCommit,
  postManifest,
  putBlob,
  setup,
  sha256,
  type ManifestAnswer,
} from './delta.test-support.js';

const NOW = new Date('2026-10-10T15:00:00.000Z');
const DAY = 86_400_000;
const RECORD = process.env.SCRY_RECORD_FIXTURES === '1';
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/delta');

/** Save (or check) one request/response pair. Keys, ids and times are placeholders; the shapes are the contract. */
async function record(name: string, request: { method: string; path: string; headers?: Record<string, string>; body?: unknown }, res: Response) {
  const text = await res.clone().text();
  let body: unknown = text === '' ? null : text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON: keep the text
  }
  const PLACEHOLDERS: Record<string, string> = { request_id: '<request id>', expiresAt: '<iso time>', expires_at: '<iso time>' };
  const scrub = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (k, val) => PLACEHOLDERS[k] ?? val));
  const headers: Record<string, string> = {};
  for (const h of ['x-scry-request-id', 'retry-after']) {
    const v = res.headers.get(h);
    if (v) headers[h] = h === 'x-scry-request-id' ? '<request id>' : v;
  }
  const fixture = scrub({ name, request, response: { status: res.status, ...(Object.keys(headers).length ? { headers } : {}), body } });
  const file = join(FIXTURE_DIR, `${name}.json`);
  if (RECORD) {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(fixture, null, 2) + '\n');
  } else {
    expect(fixture, `fixture ${name} drifted; re-record with SCRY_RECORD_FIXTURES=1`).toEqual(JSON.parse(readFileSync(file, 'utf8')));
  }
}

const reqOf = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => ({ method, path, ...(headers ? { headers } : {}), ...(body === undefined ? {} : { body }) });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('guarantees', () => {
  // Acceptance row 8
  it('guarantee-1 a picture stored for one project is never reported present to, readable by, or committable from another project', async () => {
    const { server, bucket } = setup();
    const pics = pictures(3);
    const first = await openAndUpload(server, PROJECT, PLAIN_KEY, pics, 'project-a-attempt');
    expect(first.answer.objects.filter((o) => o.actions)).toHaveLength(3);
    expect(bucket.blobKeys(PROJECT)).toHaveLength(3);

    // The same fingerprints from project B: all missing (B holds nothing), and nothing of A's is named in the answer.
    const res = await postManifest(server, OTHER_PROJECT, OTHER_PROJECT_KEY, manifestBody(pics), { 'Idempotency-Key': 'project-b-attempt' });
    const answer = (await res.json()) as ManifestAnswer;
    expect(res.status).toBe(201);
    expect(answer.objects.every((o) => o.actions)).toBe(true);
    expect(JSON.stringify(answer)).not.toContain(PROJECT);
    expect(bucket.blobKeys(OTHER_PROJECT)).toHaveLength(0);

    // B cannot commit it (the picture is not B's), cannot commit A's build, and cannot PUT against A's build.
    const commitB = await postCommit(server, OTHER_PROJECT, OTHER_PROJECT_KEY, answer.buildId);
    expect(commitB.status).toBe(409);
    expect(((await commitB.json()) as { missing: string[] }).missing).toHaveLength(3);
    const commitA = await postCommit(server, OTHER_PROJECT, OTHER_PROJECT_KEY, first.answer.buildId);
    expect(commitA.status).toBe(404);
    const putAcrossBuilds = await putBlob(server, OTHER_PROJECT, OTHER_PROJECT_KEY, pics[0].oid, pics[0].bytes, first.answer.buildId);
    expect(putAcrossBuilds.status).toBe(409);
    // Project B's key against project A's URL is refused outright.
    const wrongUrl = await postManifest(server, PROJECT, OTHER_PROJECT_KEY, manifestBody(pics));
    expect(wrongUrl.status).toBe(403);
  });

  // Acceptance row 9
  it('guarantee-2 every delta route checks the key against the project and the pinned source, and says nothing about pictures when it refuses', async () => {
    const { server } = setup();
    const pics = pictures(1);
    const opened = await openAndUpload(server, PROJECT, PLAIN_KEY, pics, 'for-guarantee-2');
    const buildId = opened.answer.buildId;
    const other = pictures(1, 50)[0];

    const calls: Array<[string, (key: string | undefined) => Promise<Response>]> = [
      ['manifest', (key) => postManifest(server, PROJECT, key, manifestBody(pics))],
      ['blob', (key) => putBlob(server, PROJECT, key, pics[0].oid, pics[0].bytes, buildId)],
      ['commit', (key) => postCommit(server, PROJECT, key, buildId)],
    ];
    for (const [route, call] of calls) {
      for (const [label, key, status] of [
        ['no key', undefined, 401],
        ['revoked key', REVOKED_KEY, 401],
        ["another project's plain key", OTHER_PROJECT_KEY, 403],
        ["another project's device key", OTHER_DEVICE_KEY, 403],
      ] as const) {
        const res = await call(key);
        expect(res.status, `${route}: ${label}`).toBe(status);
        const text = await res.text();
        expect(text, `${route}: ${label} body`).not.toContain(pics[0].oid);
        expect(text.toLowerCase(), `${route}: ${label} body`).not.toMatch(/blob|held|picture|oid/);
      }
    }

    // A device key works only for its pinned source: a build made for another source is refused to it on every route.
    const foreign = await postManifest(server, PROJECT, PLAIN_KEY, manifestBody([other], { source: 'storybook:web', scf: { ...manifestBody([other]).scf, source: { kind: 'storybook', platform: 'web' } } }), {
      'Idempotency-Key': 'foreign-source-1',
    });
    expect(foreign.status).toBe(201);
    const foreignBuild = ((await foreign.json()) as ManifestAnswer).buildId;
    expect((await putBlob(server, PROJECT, DEVICE_KEY, other.oid, other.bytes, foreignBuild)).status).toBe(403);
    expect((await postCommit(server, PROJECT, DEVICE_KEY, foreignBuild)).status).toBe(403);
    const asDevice = await postManifest(server, PROJECT, DEVICE_KEY, manifestBody([other], { source: 'storybook:web' }), { 'Idempotency-Key': 'foreign-source-2' });
    expect(asDevice.status).toBe(403);
    // The manifest's own source must also match the pinned one.
    const lying = await postManifest(server, PROJECT, DEVICE_KEY, manifestBody([other], { scf: { ...manifestBody([other]).scf, source: { kind: 'storybook', platform: 'web' } } }), { 'Idempotency-Key': 'foreign-source-3' });
    expect(lying.status).toBe(403);
    // And the pinned source works with a device key.
    const ok = await postManifest(server, PROJECT, DEVICE_KEY, manifestBody([other]), { 'Idempotency-Key': 'device-source-ok' });
    expect(ok.status).toBe(201);
  });

  // Acceptance row 10
  it('guarantee-3 a picture is stored only under the fingerprint of its actual bytes; a mismatched upload stores nothing', async () => {
    const { server, bucket } = setup();
    const [wanted] = pictures(1, 1);
    const impostor = fakePng(999); // same size as `wanted`, different bytes
    expect(impostor.byteLength).toBe(wanted.bytes.byteLength);
    const res = await postManifest(server, PROJECT, PLAIN_KEY, manifestBody([wanted]));
    const { buildId } = (await res.json()) as ManifestAnswer;

    const bad = await putBlob(server, PROJECT, PLAIN_KEY, wanted.oid, impostor, buildId);
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: string }).error).toBe('hash_mismatch');
    expect(bucket.blobKeys(PROJECT)).toHaveLength(0);
    expect(bucket.puts.filter((k) => k.startsWith('_blobs/'))).toHaveLength(0);

    const good = await putBlob(server, PROJECT, PLAIN_KEY, wanted.oid, wanted.bytes, buildId);
    expect(good.status).toBe(201);
    expect(bucket.blobKeys(PROJECT)).toEqual([`_blobs/${PROJECT}/${wanted.oid}`]);
    expect(sha256(bucket.objects.get(`_blobs/${PROJECT}/${wanted.oid}`)!.bytes)).toBe(wanted.oid);
    // Bytes that hash correctly but are not a picture are refused too (the declared type is checked against the bytes).
    const notPicture = new TextEncoder().encode('x'.repeat(400));
    const res2 = await postManifest(server, PROJECT, PLAIN_KEY, manifestBody([{ path: 'images/text.png', bytes: notPicture, oid: sha256(notPicture) }]), { 'Idempotency-Key': 'not-a-picture' });
    const second = (await res2.json()) as ManifestAnswer;
    const refused = await putBlob(server, PROJECT, PLAIN_KEY, sha256(notPicture), notPicture, second.buildId);
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: string }).error).toBe('bad_type');
    expect(bucket.blobKeys(PROJECT)).toHaveLength(1);
  });

  // Acceptance row 4 (server half)
  it('guarantee-4 every build carries the full picture list: a picture without an entry is refused, and one left out of the list is gone from the build', async () => {
    const { server, bucket, queue } = setup();
    const pics = pictures(3);

    // A capture whose picture has no entry in the list: 400, no build.
    const incomplete = manifestBody(pics, { images: Object.fromEntries(pics.slice(0, 2).map((p) => [p.path, { oid: p.oid, size: p.bytes.byteLength }])) });
    const refused = await postManifest(server, PROJECT, PLAIN_KEY, incomplete);
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as { error: string; errors: Array<{ code: string }> };
    expect(body.error).toBe('invalid_manifest');
    expect(body.errors.map((e) => e.code)).toContain('IMAGE_FILE_MISSING');
    // A picture nothing refers to is refused as well (the list is the build, not a store of extras).
    const extra = manifestBody(pics.slice(0, 2), { images: Object.fromEntries(pics.map((p) => [p.path, { oid: p.oid, size: p.bytes.byteLength }])) });
    expect((await postManifest(server, PROJECT, PLAIN_KEY, extra, { 'Idempotency-Key': 'extra-picture-1' })).status).toBe(400);

    // Sync 1 sends three pictures; sync 2 lists two. The second build shows exactly two and sends nothing.
    const one = await openAndUpload(server, PROJECT, PLAIN_KEY, pics, 'full-list-1');
    expect((await postCommit(server, PROJECT, PLAIN_KEY, one.answer.buildId)).status).toBe(202);
    const two = await openAndUpload(server, PROJECT, PLAIN_KEY, pics.slice(0, 2), 'full-list-2');
    expect(two.answer.objects.every((o) => !o.actions && !o.error)).toBe(true);
    expect((await postCommit(server, PROJECT, PLAIN_KEY, two.answer.buildId)).status).toBe(202);

    const message = queue.send.mock.calls[1][0] as { manifestKey: string; imagesKey: string };
    const scf = JSON.parse(bucket.text(message.manifestKey)!) as { captures: Array<{ image: string }>; counts: { captured: number } };
    const images = JSON.parse(bucket.text(message.imagesKey)!) as Record<string, unknown>;
    expect(scf.captures.map((c) => c.image)).toEqual(pics.slice(0, 2).map((p) => p.path));
    expect(Object.keys(images)).toEqual(pics.slice(0, 2).map((p) => p.path));
    expect(scf.counts.captured).toBe(2);
  });

  // Acceptance row 11, 18
  it('guarantee-7 the limits hold: 10,000 pictures, 16 MiB list, 20 MiB per picture, 1 GiB new bytes, a rate limit per key; one oversized picture is refused alone', async () => {
    const { server } = setup();
    const pics = pictures(2);

    // 10,001 pictures
    const many = Object.fromEntries(Array.from({ length: MAX_PICTURES + 1 }, (_, i) => [`images/p${i}.png`, { oid: sha256(String(i)), size: 10 }]));
    const tooMany = await postManifest(server, PROJECT, PLAIN_KEY, manifestBody(pics, { images: many }), { 'Idempotency-Key': 'limits-many' });
    expect(tooMany.status).toBe(413);
    await record('manifest-413-too-many-pictures', reqOf('POST', `/delta/<project>/manifest`, '<10,001 pictures>'), tooMany);

    // 17 MiB list
    const huge = JSON.stringify({ ...manifestBody(pics), pad: 'x'.repeat(MAX_MANIFEST_BYTES + 1024) });
    const tooBig = await postManifest(server, PROJECT, PLAIN_KEY, huge, { 'Idempotency-Key': 'limits-huge' });
    expect(tooBig.status).toBe(413);

    // More than 1 GiB declared new bytes
    const heavy = pictures(60, 100);
    const heavyImages = Object.fromEntries(heavy.map((p) => [p.path, { oid: p.oid, size: MAX_BLOB_BYTES }]));
    const overBudget = await postManifest(server, PROJECT, PLAIN_KEY, manifestBody(heavy, { images: heavyImages }), { 'Idempotency-Key': 'limits-bytes' });
    expect(overBudget.status).toBe(413);
    expect(((await overBudget.json()) as { error: string }).error).toBe('too_many_new_bytes');

    // One picture over 20 MiB is refused alone: the others upload, the build commits without it.
    const three = pictures(3, 200);
    const oversized = manifestBody(three, { images: { ...Object.fromEntries(three.map((p) => [p.path, { oid: p.oid, size: p.bytes.byteLength }])), [three[1].path]: { oid: three[1].oid, size: 21 * 1024 * 1024 } } });
    const res = await postManifest(server, PROJECT, PLAIN_KEY, oversized, { 'Idempotency-Key': 'limits-one-big' });
    expect(res.status).toBe(201);
    const answer = (await res.json()) as ManifestAnswer;
    const byOid = new Map(answer.objects.map((o) => [o.oid, o]));
    expect(byOid.get(three[1].oid)?.error?.code).toBe('too_big');
    expect(byOid.get(three[1].oid)?.actions).toBeUndefined();
    expect(byOid.get(three[0].oid)?.actions).toBeDefined();
    expect(byOid.get(three[2].oid)?.actions).toBeDefined();

    // A single PUT over 20 MiB is refused on its length alone.
    const bigPut = await server.request(`/delta/${PROJECT}/blobs/${three[0].oid}?build=${answer.buildId}`, {
      method: 'PUT',
      headers: { 'X-API-Key': PLAIN_KEY, 'Content-Length': String(MAX_BLOB_BYTES + 1) },
      body: three[0].bytes as BodyInit,
    });
    expect(bigPut.status).toBe(413);
    // No Content-Length: refused.
    const noLength = await server.request(`/delta/${PROJECT}/blobs/${three[0].oid}?build=${answer.buildId}`, { method: 'PUT', headers: { 'X-API-Key': PLAIN_KEY } });
    expect([411, 400]).toContain(noLength.status);

    // A burst of manifests: the 31st in a minute is refused with Retry-After.
    const burst = setup();
    let last: Response | undefined;
    for (let i = 0; i <= MANIFESTS_PER_MINUTE; i++) {
      last = await postManifest(burst.server, PROJECT, PLAIN_KEY, manifestBody(pics), { 'Idempotency-Key': 'burst-attempt-1' });
    }
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    await record('manifest-429-rate-limited', reqOf('POST', `/delta/<project>/manifest`, '<manifest>'), last!);
    // Blob PUTs have their own, higher limit.
    const blobBurst = setup();
    const opened = await postManifest(blobBurst.server, PROJECT, PLAIN_KEY, manifestBody(pics));
    const { buildId } = (await opened.json()) as ManifestAnswer;
    let lastPut: Response | undefined;
    for (let i = 0; i <= BLOBS_PER_MINUTE; i++) lastPut = await putBlob(blobBurst.server, PROJECT, PLAIN_KEY, pics[0].oid, pics[0].bytes, buildId);
    expect(lastPut!.status).toBe(429);

    // The oversized-picture build commits without the refused picture (row 18).
    for (const p of [three[0], three[2]]) expect((await putBlob(server, PROJECT, PLAIN_KEY, p.oid, p.bytes, answer.buildId)).status).toBe(201);
    expect((await postCommit(server, PROJECT, PLAIN_KEY, answer.buildId)).status).toBe(202);
  });

  // Acceptance row 15
  it('guarantee-8 clean-up keeps every picture a recent build or a source\'s latest build uses, and deletes old unreferenced ones', async () => {
    const { bucket, firestore, storage } = setup();
    const old = new Date(NOW.getTime() - 40 * DAY);
    const referenced = (n: number) => sha256(`blob-${n}`);
    const blob = (n: number, uploaded: Date) => bucket.seed(`_blobs/${PROJECT}/${referenced(n)}`, `bytes-${n}`, uploaded);
    const build = (id: string, number: number, ageDays: number, extra: Record<string, unknown>, oids: number[]) => {
      const row = { id, projectId: PROJECT, versionId: 'v', buildNumber: number, zipUrl: '', status: 'active', createdAt: new Date(NOW.getTime() - ageDays * DAY), createdBy: '', delta: true, source: { kind: 'x-scry-sync', platform: 'other' }, ...extra };
      firestore.builds.set(`${PROJECT}/${id}`, row as never);
      bucket.seed(buildFileKey(PROJECT, 'v', number, 'images.json'), JSON.stringify(Object.fromEntries(oids.map((n) => [`images/${n}.png`, { oid: referenced(n), size: 5 }]))), new Date());
    };
    // 1: used by a 5-day-old build; 2: used only by an old build that is not the latest; 3: used by the latest build (45 days old);
    // 4: unreferenced; 5: unreferenced but young.
    build('b1', 3, 5, { processingStatus: 'completed' }, [1, 3]);
    build('b0', 1, 50, { processingStatus: 'completed' }, [2]);
    build('b2', 2, 45, { processingStatus: 'completed' }, [3]);
    [1, 2, 3, 4].forEach((n) => blob(n, old));
    blob(5, new Date(NOW.getTime() - 2 * DAY));

    const result = await runBlobGc({ firestore: firestore as never, storage, now: NOW });
    const left = bucket.blobKeys(PROJECT).map((k) => k.split('/')[2]);
    expect(left.sort()).toEqual([referenced(1), referenced(3), referenced(5)].sort());
    expect(result).toMatchObject({ deleted: 2, errors: 0 });

    // The latest build of a source is kept even when it is older than the window and everything newer failed.
    const { bucket: b2, firestore: f2, storage: s2 } = setup();
    b2.seed(`_blobs/${PROJECT}/${referenced(7)}`, 'x', old);
    f2.builds.set(`${PROJECT}/only`, { id: 'only', projectId: PROJECT, versionId: 'v', buildNumber: 1, zipUrl: '', status: 'active', createdAt: new Date(NOW.getTime() - 90 * DAY), createdBy: '', delta: true, processingStatus: 'completed', source: { kind: 'x-scry-sync', platform: 'other' } } as never);
    b2.seed(buildFileKey(PROJECT, 'v', 1, 'images.json'), JSON.stringify({ 'images/7.png': { oid: referenced(7), size: 1 } }), new Date());
    f2.builds.set(`${PROJECT}/newer-failed`, { id: 'newer-failed', projectId: PROJECT, versionId: 'v', buildNumber: 2, zipUrl: '', status: 'active', createdAt: new Date(NOW.getTime() - 60 * DAY), createdBy: '', delta: true, processingStatus: 'failed', source: { kind: 'x-scry-sync', platform: 'other' } } as never);
    await runBlobGc({ firestore: f2 as never, storage: s2, now: NOW });
    expect(b2.blobKeys(PROJECT)).toHaveLength(1);

    // Fail safe: when the build list cannot be read, or may be cut short, or an accepted build's list is missing, nothing in that project is deleted.
    for (const [label, mutate] of [
      ['build list fails', (f: typeof firestore) => { f.listDeltaBuilds = async () => { throw new Error('boom'); }; }],
      ['build list is full', (f: typeof firestore) => { f.listDeltaBuilds = async () => Array.from({ length: GC_BUILD_PAGE }, (_, i) => ({ id: `x${i}`, projectId: PROJECT, versionId: 'v', buildNumber: i, createdAt: NOW, source: { kind: 'k', platform: 'p' } }) as never); }],
    ] as const) {
      const t = setup();
      t.bucket.seed(`_blobs/${PROJECT}/${referenced(9)}`, 'x', old);
      mutate(t.firestore);
      const out = await runBlobGc({ firestore: t.firestore as never, storage: t.storage, now: NOW });
      expect(t.bucket.blobKeys(PROJECT), label).toHaveLength(1);
      expect(out.deleted, label).toBe(0);
      expect(out.skippedProjects, label).toHaveLength(1);
    }
    const missingList = setup();
    missingList.bucket.seed(`_blobs/${PROJECT}/${referenced(9)}`, 'x', old);
    missingList.firestore.builds.set(`${PROJECT}/acc`, { id: 'acc', projectId: PROJECT, versionId: 'v', buildNumber: 1, zipUrl: '', status: 'active', createdAt: new Date(NOW.getTime() - 1 * DAY), createdBy: '', delta: true, processingStatus: 'queued', source: { kind: 'x-scry-sync', platform: 'other' } } as never);
    const out = await runBlobGc({ firestore: missingList.firestore as never, storage: missingList.storage, now: NOW });
    expect(out.skippedProjects[0].reason).toBe('picture-list-missing');
    expect(missingList.bucket.blobKeys(PROJECT)).toHaveLength(1);
    // The daily pass runs in the 03:00 UTC hour of the hourly cron only.
    expect(gcDue(new Date('2026-10-10T03:00:00Z'))).toBe(true);
    expect(gcDue(new Date('2026-10-10T04:00:00Z'))).toBe(false);
  });
});

describe('build deadline and idempotency', () => {
  // Acceptance row 17
  it('a picture upload keeps the build open past 60 minutes; after a forced sweep the same key opens a new build and re-sends nothing stored', async () => {
    const { server, bucket, firestore } = setup();
    const pics = pictures(3);
    const res = await postManifest(server, PROJECT, PLAIN_KEY, manifestBody(pics), { 'Idempotency-Key': 'slow-upload-1' });
    const first = (await res.json()) as ManifestAnswer;
    expect(res.status).toBe(201);
    expect(new Date(first.expiresAt).getTime()).toBe(NOW.getTime() + 60 * 60_000);

    // 50 minutes in, one picture arrives: the deadline moves to 50 + 60 minutes.
    vi.setSystemTime(new Date(NOW.getTime() + 50 * 60_000));
    expect((await putBlob(server, PROJECT, PLAIN_KEY, pics[0].oid, pics[0].bytes, first.buildId)).status).toBe(201);
    const row = firestore.builds.get(`${PROJECT}/${first.buildId}`)!;
    expect(row.deltaDeadline!.getTime()).toBe(NOW.getTime() + 110 * 60_000);

    // The sweep, 70 minutes in, leaves the build alone (it is older than 60 minutes but its deadline has not passed).
    const candidate = (deadline: Date) => ({ buildId: first.buildId, projectId: PROJECT, versionId: 'v', buildNumber: 1, createdAt: NOW, hasSource: true, hasProcessingStatus: false, deltaDeadline: deadline });
    const marked: string[] = [];
    const sweepStore = (deadline: Date): OrphanSweepStore => ({
      findCandidates: async () => [candidate(deadline)],
      bundleObjectExists: async () => false,
      getFreshState: async () => ({ updateTime: 't', hasProcessingStatus: false }) as never,
      markUploadNeverCompletedIfUnchanged: async (c) => {
        marked.push(c.buildId);
        return 'marked';
      },
    });
    const at70 = new Date(NOW.getTime() + 70 * 60_000);
    const kept = await sweepOrphanBundleBuilds(sweepStore(row.deltaDeadline!), { now: at70 });
    expect(kept.skipped).toEqual([{ projectId: PROJECT, buildId: first.buildId, reason: 'delta-open' }]);
    expect(marked).toEqual([]);
    // Once the deadline has passed the sweep fails it like any orphan.
    const at120 = new Date(NOW.getTime() + 120 * 60_000);
    await sweepOrphanBundleBuilds(sweepStore(row.deltaDeadline!), { now: at120 });
    expect(marked).toEqual([first.buildId]);

    // The machine slept: the build is failed. The same Idempotency-Key opens a NEW build and the stored picture is not asked for again.
    row.processingStatus = 'failed';
    vi.setSystemTime(at120);
    const again = await postManifest(server, PROJECT, PLAIN_KEY, manifestBody(pics), { 'Idempotency-Key': 'slow-upload-1' });
    const second = (await again.json()) as ManifestAnswer;
    expect(again.status).toBe(201);
    expect(second.buildId).not.toBe(first.buildId);
    expect(second.objects.filter((o) => o.actions).map((o) => o.oid).sort()).toEqual([pics[1].oid, pics[2].oid].sort());
    expect(bucket.blobKeys(PROJECT)).toHaveLength(1);
    // Nothing can be PUT against the failed build any more.
    expect((await putBlob(server, PROJECT, PLAIN_KEY, pics[1].oid, pics[1].bytes, first.buildId)).status).toBe(409);
  });

  it('a capture that carries structure or sourceText is refused at manifest time with delta_pictures_only, and no build is opened', async () => {
    const { server, firestore } = setup();
    const pics = pictures(2, 300);
    for (const extra of [{ structure: { file: 'structure/a.json' } }, { sourceText: { file: 'source/a.txt' } }]) {
      const base = manifestBody(pics);
      const scf = { ...base.scf, captures: base.scf.captures.map((c: object, i: number) => (i === 0 ? { ...c, ...extra } : c)) };
      const res = await postManifest(server, PROJECT, PLAIN_KEY, manifestBody(pics, { scf }), { 'Idempotency-Key': 'pictures-only-1' });
      expect(res.status).toBe(400);
      const body = (await res.clone().json()) as { error: string; captures: string[] };
      expect(body.error).toBe('delta_pictures_only');
      expect(body.captures).toEqual(['pic-0']);
      if ('structure' in extra) await record('manifest-400-delta-pictures-only', reqOf('POST', '/delta/<project>/manifest', '<a capture with structure>'), res);
    }
    expect(firestore.builds.size).toBe(0);
    // Explicit nulls mean "none" and are accepted.
    const base = manifestBody(pics);
    const scf = { ...base.scf, captures: base.scf.captures.map((c: object) => ({ ...c, structure: null, sourceText: null })) };
    expect((await postManifest(server, PROJECT, PLAIN_KEY, manifestBody(pics, { scf }), { 'Idempotency-Key': 'pictures-only-2' })).status).toBe(201);
  });

  it('the same Idempotency-Key and manifest while the build is open answers the same build; a different manifest is a conflict', async () => {
    const { server, firestore } = setup();
    const pics = pictures(2);
    const a = await postManifest(server, PROJECT, PLAIN_KEY, manifestBody(pics), { 'Idempotency-Key': 'retry-key-0001' });
    const b = await postManifest(server, PROJECT, PLAIN_KEY, manifestBody(pics), { 'Idempotency-Key': 'retry-key-0001' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    const [first, second] = [(await a.json()) as ManifestAnswer, (await b.json()) as ManifestAnswer];
    expect(second.buildId).toBe(first.buildId);
    expect(second.objects.filter((o) => o.actions)).toHaveLength(2);
    expect(firestore.builds.size).toBe(1);
    const conflict = await postManifest(server, PROJECT, PLAIN_KEY, manifestBody(pictures(3)), { 'Idempotency-Key': 'retry-key-0001' });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: string }).error).toBe('idempotency_conflict');
    expect(firestore.keys.get(`${PROJECT}/${keyHash('retry-key-0001')}`)?.buildId).toBe(first.buildId);
    for (const bad of [undefined, 'short', 'has space in it!!']) {
      const res = await postManifest(server, PROJECT, PLAIN_KEY, manifestBody(pics), bad === undefined ? {} : { 'Idempotency-Key': bad });
      expect(res.status).toBe(400);
    }
  });

  it('a picture is accepted only for an open build of this project that lists it', async () => {
    const { server } = setup();
    const [listed] = pictures(1);
    const [unlisted] = pictures(1, 77);
    const { buildId } = (await (await postManifest(server, PROJECT, PLAIN_KEY, manifestBody([listed]))).json()) as ManifestAnswer;
    expect((await putBlob(server, PROJECT, PLAIN_KEY, unlisted.oid, unlisted.bytes, buildId)).status).toBe(409);
    expect((await putBlob(server, PROJECT, PLAIN_KEY, listed.oid, listed.bytes)).status).toBe(409);
    expect((await putBlob(server, PROJECT, PLAIN_KEY, 'not-a-hash', listed.bytes, buildId)).status).toBe(400);
    // A wrong size for a listed oid is refused before anything is stored.
    const padded = new Uint8Array(listed.bytes.byteLength + 1);
    padded.set(listed.bytes);
    expect((await putBlob(server, PROJECT, PLAIN_KEY, listed.oid, padded, buildId)).status).toBe(422);
  });
});

describe('versioning and flag', () => {
  // Acceptance row 19
  it('an unknown protocol or hash answers 400 unsupported_protocol so the client uses the zip', async () => {
    const { server } = setup();
    const pics = pictures(1);
    for (const override of [{ protocol: 2 }, { hash: 'md5' }, { protocol: undefined }, { hash: undefined }]) {
      const res = await postManifest(server, PROJECT, PLAIN_KEY, manifestBody(pics, override));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('unsupported_protocol');
    }
    const res = await postManifest(server, PROJECT, PLAIN_KEY, manifestBody(pics, { protocol: 2 }));
    await record('manifest-400-unsupported-protocol', reqOf('POST', '/delta/<project>/manifest', manifestBody(pics, { protocol: 2 }), { 'Idempotency-Key': IDEMPOTENCY }), res);
  });

  it('with the flag off every route answers 503 delta_disabled (the client uses the zip) and nothing is written', async () => {
    const { server, bucket, firestore } = setup({ syncDelta: false });
    const pics = pictures(1);
    const responses = [
      await postManifest(server, PROJECT, PLAIN_KEY, manifestBody(pics)),
      await putBlob(server, PROJECT, PLAIN_KEY, pics[0].oid, pics[0].bytes, 'b'),
      await postCommit(server, PROJECT, PLAIN_KEY, 'b'),
    ];
    for (const res of responses) {
      expect(res.status).toBe(503);
      expect(((await res.clone().json()) as { error: string }).error).toBe('delta_disabled');
    }
    expect(bucket.objects.size).toBe(0);
    expect(firestore.builds.size).toBe(0);
    await record('manifest-503-delta-disabled', reqOf('POST', '/delta/<project>/manifest', '<manifest>'), responses[0]);
    // A key check still comes first: no key is a 401, not a 503.
    expect((await postManifest(server, PROJECT, undefined, manifestBody(pics))).status).toBe(401);
  });

  it('error bodies carry the minted x-scry-request-id (an inbound id from an API-key client is not adopted)', async () => {
    const { server } = setup();
    const res = await postManifest(server, PROJECT, PLAIN_KEY, manifestBody(pictures(1), { protocol: 3 }), { 'Idempotency-Key': IDEMPOTENCY, 'x-scry-request-id': 'req_from_client_1' });
    const id = res.headers.get('x-scry-request-id');
    expect(id).toBeTruthy();
    expect(id).not.toBe('req_from_client_1');
    expect(((await res.json()) as { request_id?: string }).request_id).toBe(id);
    expect((await postCommit(server, PROJECT, undefined, 'b')).headers.get('x-scry-request-id')).toBeTruthy();
  });
});

describe('the build the processing service reads', () => {
  it('commit queues exactly the shared fixture message shape and writes exactly the shared images.json shape', async () => {
    const { server, bucket, queue, firestore } = setup();
    const sharedMessage = JSON.parse(readFileSync(join(FIXTURE_DIR, 'delta-queue-message.json'), 'utf8')) as Record<string, unknown>;
    const sharedImages = JSON.parse(readFileSync(join(FIXTURE_DIR, 'delta-images.json'), 'utf8')) as Record<string, { oid: string; size: number }>;
    const pics = pictures(2);
    const { answer } = await openAndUpload(server, PROJECT, DEVICE_KEY, pics);
    const committed = await postCommit(server, PROJECT, DEVICE_KEY, answer.buildId);
    expect(committed.status).toBe(202);

    expect(queue.send).toHaveBeenCalledTimes(1);
    const sent = queue.send.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(Object.keys(sharedMessage).sort());
    expect(sent).toMatchObject({
      projectId: PROJECT,
      versionId: 'sync-1760000000000',
      buildId: answer.buildId,
      format: 'scf-delta',
      manifestKey: `${PROJECT}/sync-1760000000000/builds/1/scf.json`,
      imagesKey: `${PROJECT}/sync-1760000000000/builds/1/images.json`,
    });
    expect(typeof sent.timestamp).toBe(typeof sharedMessage.timestamp);
    expect(Object.keys(sent)).toContain('trace');
    // manifestKey / imagesKey are the shared fixtures' key layout.
    expect(String(sharedMessage.manifestKey).replace(/^[^/]+\/[^/]+\//, '')).toBe('builds/7/scf.json');
    expect(String(sent.manifestKey).replace(/^[^/]+\/[^/]+\//, '')).toBe('builds/1/scf.json');

    const images = JSON.parse(bucket.text(String(sent.imagesKey))!) as Record<string, Record<string, unknown>>;
    for (const entry of [...Object.values(images), ...Object.values(sharedImages)]) expect(Object.keys(entry).sort()).toEqual(['oid', 'size']);
    expect(Object.keys(images)).toEqual(pics.map((p) => p.path));
    expect(Object.keys(sharedImages).every((p) => /^images\/.+\.png$/.test(p))).toBe(true);
    expect(firestore.builds.get(`${PROJECT}/${answer.buildId}`)?.processingStatus).toBe('queued');
    // The delta path writes no zip.
    expect([...bucket.objects.keys()].some((k) => k.endsWith('.zip'))).toBe(false);
  });

  it('commit lists what has not arrived, accepts once everything is held, and a repeat answers 200 without queueing again', async () => {
    const { server, queue } = setup();
    const pics = pictures(2);
    const { buildId } = (await (await postManifest(server, PROJECT, CI_KEY, manifestBody(pics))).json()) as ManifestAnswer;
    expect((await putBlob(server, PROJECT, CI_KEY, pics[0].oid, pics[0].bytes, buildId)).status).toBe(201);
    const early = await postCommit(server, PROJECT, CI_KEY, buildId);
    expect(early.status).toBe(409);
    expect(((await early.json()) as { missing: string[] }).missing).toEqual([pics[1].oid]);
    expect(queue.send).not.toHaveBeenCalled();
    // Already held: 200, no write.
    expect((await putBlob(server, PROJECT, CI_KEY, pics[0].oid, pics[0].bytes, buildId)).status).toBe(200);
    expect((await putBlob(server, PROJECT, CI_KEY, pics[1].oid, pics[1].bytes, buildId)).status).toBe(201);
    expect((await postCommit(server, PROJECT, CI_KEY, buildId)).status).toBe(202);
    const repeat = await postCommit(server, PROJECT, CI_KEY, buildId);
    expect(repeat.status).toBe(200);
    expect(queue.send).toHaveBeenCalledTimes(1);
    expect((await postCommit(server, PROJECT, CI_KEY, 'nope')).status).toBe(404);
  });

  it('the commit line says how much this sync moved: whole-build totals plus what was sent and what the project already held', async () => {
    const { server } = setup();
    const first = pictures(2, 1);
    await openAndUpload(server, PROJECT, CI_KEY, first, 'sync-first');
    const info = vi.spyOn(log, 'info');
    const second = [...first, ...pictures(1, 50)];
    const { buildId } = (await (await postManifest(server, PROJECT, CI_KEY, manifestBody(second), { 'Idempotency-Key': 'sync-second' })).json()) as ManifestAnswer;
    await putBlob(server, PROJECT, CI_KEY, second[2].oid, second[2].bytes, buildId);
    expect((await postCommit(server, PROJECT, CI_KEY, buildId)).status).toBe(202);
    const attrsOf = (msg: string) => (info.mock.calls.filter((c) => c[0] === msg).at(-1)?.[1] as { attrs: Record<string, number> }).attrs;
    const newBytes = second[2].bytes.byteLength;
    expect(attrsOf('delta manifest')).toEqual({ 'delta.bytes': newBytes, 'delta.items': 3, 'delta.items_skipped': 2 });
    expect(attrsOf('delta commit')).toEqual({
      'delta.bytes': second.reduce((sum, p) => sum + p.bytes.byteLength, 0),
      'delta.items': 3,
      'delta.bytes_sent': newBytes,
      'delta.items_sent': 1,
      'delta.items_skipped': 2,
    });
    info.mockRestore();
  });

  it('the delta log attrs are registered for the upload service as integers, so a line carries counts and never names or ids', () => {
    for (const name of ['delta.bytes', 'delta.items', 'delta.items_skipped', 'delta.bytes_sent', 'delta.items_sent']) {
      expect(ATTRS[name], name).toMatchObject({ type: 'int' });
      expect(ATTRS[name].services).toContain('upload');
    }
  });
});

describe('storage additions', () => {
  it('putObject refuses bytes that do not hash to the declared sha256, and listKeys pages with sizes and upload times', async () => {
    const { bucket, storage } = setup();
    const bytes = fakePng(5);
    await expect(storage.putObject('_blobs/p/x', bytes, { contentType: 'image/png', sha256: sha256(fakePng(6)) })).rejects.toThrow();
    expect(bucket.objects.size).toBe(0);
    await storage.putObject('_blobs/p/a', bytes, { contentType: 'image/png', sha256: sha256(bytes) });
    await storage.putObject('_blobs/p/b', bytes, { contentType: 'image/png' });
    await storage.putObject('other/c', bytes, { contentType: 'image/png' });
    const first = await storage.listKeys('_blobs/', { limit: 1 });
    expect(first.keys).toHaveLength(1);
    expect(first.cursor).toBeTruthy();
    const second = await storage.listKeys('_blobs/', { cursor: first.cursor, limit: 10 });
    expect([...first.keys, ...second.keys].map((k) => k.key)).toEqual(['_blobs/p/a', '_blobs/p/b']);
    expect(first.keys[0].size).toBe(bytes.byteLength);
    expect(first.keys[0].uploaded).toBeInstanceOf(Date);
  });
});

describe('recorded exchanges', () => {
  it('records a full sync: manifest, blob PUT, repeat, commit', async () => {
    const { server } = setup();
    const pics = pictures(2, 1);
    const body = manifestBody(pics);
    const headers = { 'Idempotency-Key': IDEMPOTENCY };
    const opened = await postManifest(server, PROJECT, DEVICE_KEY, body, headers);
    await record('manifest-201-new-build', reqOf('POST', '/delta/<project>/manifest', body, headers), opened.clone());
    const answer = (await opened.json()) as ManifestAnswer;

    const wrong = await putBlob(server, PROJECT, DEVICE_KEY, pics[0].oid, fakePng(321), answer.buildId);
    await record('blob-422-hash-mismatch', reqOf('PUT', `/delta/<project>/blobs/<oid>?build=<buildId>`, '<bytes that do not hash to the oid>'), wrong);
    const stored = await putBlob(server, PROJECT, DEVICE_KEY, pics[0].oid, pics[0].bytes, answer.buildId);
    await record('blob-201-stored', reqOf('PUT', `/delta/<project>/blobs/<oid>?build=<buildId>`, '<picture bytes>'), stored);
    await record('blob-200-already-held', reqOf('PUT', `/delta/<project>/blobs/<oid>?build=<buildId>`, '<picture bytes>'), await putBlob(server, PROJECT, DEVICE_KEY, pics[0].oid, pics[0].bytes, answer.buildId));
    await record('blob-409-not-requested', reqOf('PUT', `/delta/<project>/blobs/<oid>`, '<picture bytes>'), await putBlob(server, PROJECT, DEVICE_KEY, pics[0].oid, pics[0].bytes));

    await record('manifest-200-same-key-again', reqOf('POST', '/delta/<project>/manifest', body, headers), await postManifest(server, PROJECT, DEVICE_KEY, body, headers));
    await record('manifest-409-idempotency-conflict', reqOf('POST', '/delta/<project>/manifest', '<a different manifest>', headers), await postManifest(server, PROJECT, DEVICE_KEY, manifestBody(pictures(3)), headers));
    await record('manifest-401-no-key', reqOf('POST', '/delta/<project>/manifest', '<manifest>', headers), await postManifest(server, PROJECT, undefined, body, headers));
    await record('manifest-403-other-project', reqOf('POST', '/delta/<project>/manifest', '<manifest>', headers), await postManifest(server, PROJECT, OTHER_PROJECT_KEY, body, headers));
    const invalid = manifestBody(pics, { images: { [pics[0].path]: { oid: pics[0].oid, size: pics[0].bytes.byteLength } } });
    await record('manifest-400-invalid-manifest', reqOf('POST', '/delta/<project>/manifest', '<a picture with no entry>', { 'Idempotency-Key': 'invalid-manifest-1' }), await postManifest(server, PROJECT, DEVICE_KEY, invalid, { 'Idempotency-Key': 'invalid-manifest-1' }));

    await record('commit-409-missing-blobs', reqOf('POST', '/delta/<project>/builds/<buildId>/commit', {}), await postCommit(server, PROJECT, DEVICE_KEY, answer.buildId));
    await putBlob(server, PROJECT, DEVICE_KEY, pics[1].oid, pics[1].bytes, answer.buildId);
    await record('commit-202-queued', reqOf('POST', '/delta/<project>/builds/<buildId>/commit', {}), await postCommit(server, PROJECT, DEVICE_KEY, answer.buildId));
    await record('commit-200-already-accepted', reqOf('POST', '/delta/<project>/builds/<buildId>/commit', {}), await postCommit(server, PROJECT, DEVICE_KEY, answer.buildId));
    await record('commit-404-no-such-build', reqOf('POST', '/delta/<project>/builds/<buildId>/commit', {}), await postCommit(server, PROJECT, DEVICE_KEY, 'unknown-build'));
  });
});

// ---- fix round 1 (review of PR #58) ---------------------------------------------------------------------------------

describe('fix round 1', () => {
  const OLD = new Date(NOW.getTime() - 40 * DAY);

  it('gc-race: a picture a manifest answered "held" for after clean-up took its snapshot is not deleted, and the commit succeeds', async () => {
    const { server, bucket, firestore, storage } = setup();
    const [pic] = pictures(1);
    bucket.seed(`_blobs/${PROJECT}/${pic.oid}`, pic.bytes, OLD); // 40 days old, no build lists it
    const snapshot = firestore.listDeltaBuilds.bind(firestore);
    let opened: Response | undefined;
    firestore.listDeltaBuilds = async (project: string, limit?: number) => {
      const rows = await snapshot(project, limit); // clean-up's view of the builds is taken here ...
      opened = await postManifest(server, PROJECT, DEVICE_KEY, manifestBody([pic])); // ... and a manifest arrives right after it
      return rows;
    };

    const result = await runBlobGc({ firestore: firestore as never, storage, now: NOW });
    expect(opened?.status).toBe(201);
    const answer = (await opened!.json()) as ManifestAnswer;
    expect(answer.objects[0].actions, 'the manifest was told the picture is held').toBeUndefined();
    expect(bucket.blobKeys(PROJECT)).toEqual([`_blobs/${PROJECT}/${pic.oid}`]);
    expect(result.deleted).toBe(0);
    expect(result.skippedProjects).toEqual([{ project: PROJECT, reason: 'manifest-in-flight' }]);
    const commit = await postCommit(server, PROJECT, DEVICE_KEY, answer.buildId);
    expect(commit.status).toBe(202);
  });

  it('gc-race: a project whose last manifest is older than the grace window is still cleaned', async () => {
    const { bucket, firestore, storage } = setup();
    const [pic] = pictures(1);
    bucket.seed(`_blobs/${PROJECT}/${pic.oid}`, pic.bytes, OLD);
    bucket.seed(`_blobuse/${PROJECT}/touch`, '', new Date(NOW.getTime() - GC_MANIFEST_GRACE_MS - 1000));
    const result = await runBlobGc({ firestore: firestore as never, storage, now: NOW });
    expect(result).toMatchObject({ deleted: 1, errors: 0, skippedProjects: [] });
    expect(bucket.blobKeys(PROJECT)).toEqual([]);
  });

  describe('a project holding more than 50,000 pictures', () => {
    // 51,000 filler keys that sort before every real hash, so no capped scan from the start of the prefix can reach the real ones.
    const FILLERS = 51_000;
    const seedFillers = (bucket: ReturnType<typeof setup>['bucket']) => {
      for (let i = 0; i < FILLERS; i++) bucket.seed(`_blobs/${PROJECT}/${i.toString(16).padStart(64, '0')}`, 'x', OLD);
    };

    it('the existence check is exact at any size: manifest and commit agree on what is held', async () => {
      const { server, bucket } = setup();
      seedFillers(bucket);
      const pics = pictures(120);
      pics.slice(0, 90).forEach((p) => bucket.seed(`_blobs/${PROJECT}/${p.oid}`, p.bytes, OLD)); // 90 held, 30 new
      bucket.listCalls = 0;

      const opened = await openAndUpload(server, PROJECT, DEVICE_KEY, pics);
      expect(opened.status).toBe(201);
      expect(opened.answer.objects.filter((o) => o.actions)).toHaveLength(30);
      expect(bucket.listCalls, 'listing jumps over the filler instead of reading it').toBeLessThan(10);

      const commit = await postCommit(server, PROJECT, DEVICE_KEY, opened.answer.buildId);
      expect(commit.status).toBe(202);
    });

    it('BlobStore.has answers for hashes in the middle of the listing, past it, and absent', async () => {
      const { bucket, storage } = setup();
      seedFillers(bucket);
      const store = new BlobStore(storage);
      const fill = (n: number) => n.toString(16).padStart(64, '0');
      const heldFillers = Array.from({ length: 80 }, (_, i) => fill(i * 600));
      const absentFillers = Array.from({ length: 80 }, (_, i) => fill(FILLERS + 10 + i));
      const reals = pictures(70);
      reals.slice(0, 35).forEach((p) => bucket.seed(`_blobs/${PROJECT}/${p.oid}`, p.bytes, OLD));
      const wanted = [...heldFillers, ...absentFillers, ...reals.map((p) => p.oid), fill(0)];
      const held = await store.has(PROJECT, wanted);
      expect([...held].sort()).toEqual([...new Set([...heldFillers, ...reals.slice(0, 35).map((p) => p.oid)])].sort());
    });
  });

  it('a listing with no LastModified reads as "now", never as the epoch (clean-up cannot treat it as ancient)', async () => {
    const { R2S3StorageService: NodeStorage } = await import('../services/storage/storage.node.js');
    const node = new NodeStorage({ accountId: 'acct123', accessKeyId: 'AKIATESTTESTTESTTEST', secretAccessKey: 'test-secret-access-key-not-real', bucketName: 'b' });
    (node as unknown as { s3: { send: unknown } }).s3.send = vi.fn(async () => ({ Contents: [{ Key: '_blobs/p/' + sha256('a'), Size: 3 }], IsTruncated: false }));
    const page = await node.listKeys('_blobs/');
    expect(page.keys[0].uploaded.getTime()).toBe(NOW.getTime());
  });

  it('a manifest body is cut off at 16 MiB while it streams, with or without a Content-Length', async () => {
    const { server } = setup();
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= 40) return controller.close();
        pulled++;
        controller.enqueue(chunk);
      },
    });
    const res = await server.request(`/delta/${PROJECT}/manifest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': DEVICE_KEY, 'Idempotency-Key': IDEMPOTENCY },
      body,
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe('manifest_too_large');
    expect(pulled, 'the rest of the body was never read').toBeLessThan(40);
  });

  it('concurrent commits of one build queue it exactly once; a failed send gives the claim back', async () => {
    const { server, queue, firestore } = setup();
    const opened = await openAndUpload(server, PROJECT, DEVICE_KEY, pictures(3));
    const id = opened.answer.buildId;
    const replies = await Promise.all([1, 2, 3, 4].map(() => postCommit(server, PROJECT, DEVICE_KEY, id)));
    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(replies.map((r) => r.status).sort()).toEqual([200, 200, 200, 202]);
    expect(firestore.builds.get(`${PROJECT}/${id}`)?.processingStatus).toBe('queued');

    // A failed send releases the claim: the client's retry commits and queues.
    const second = await openAndUpload(server, PROJECT, DEVICE_KEY, pictures(2, 50), 'sync-attempt-0002');
    queue.send.mockRejectedValueOnce(new Error('queue down'));
    expect((await postCommit(server, PROJECT, DEVICE_KEY, second.answer.buildId)).status).toBe(500);
    expect(firestore.builds.get(`${PROJECT}/${second.answer.buildId}`)?.processingStatus).toBeUndefined();
    expect((await postCommit(server, PROJECT, DEVICE_KEY, second.answer.buildId)).status).toBe(202);
    expect(queue.send).toHaveBeenCalledTimes(3);
  });
});

// ---- fix round 2 (re-review of PR #58) ------------------------------------------------------------------------------

describe('fix round 2', () => {
  const OLD = new Date(NOW.getTime() - 40 * DAY);
  const MIN = 60_000;

  it('gc-race-slow-sweep: a manifest that arrived after the snapshot still stops the delete when the sweep runs minutes later', async () => {
    const { server, bucket, firestore, storage } = setup();
    const [pic] = pictures(1);
    bucket.seed(`_blobs/${PROJECT}/${pic.oid}`, pic.bytes, OLD);
    const snapshot = firestore.listDeltaBuilds.bind(firestore);
    let opened: Response | undefined;
    firestore.listDeltaBuilds = async (project: string, limit?: number) => {
      const rows = await snapshot(project, limit); // snapshot at NOW
      vi.setSystemTime(new Date(NOW.getTime() + 20_000));
      opened = await postManifest(server, PROJECT, DEVICE_KEY, manifestBody([pic])); // manifest 20 s later: told "held"
      vi.setSystemTime(new Date(NOW.getTime() + 10 * MIN)); // the sweep gets to the delete 10 minutes after the snapshot
      return rows;
    };

    // No fixed `now`: the sweep reads the (advancing) clock, as the Worker does.
    const result = await runBlobGc({ firestore: firestore as never, storage });
    expect(opened?.status).toBe(201);
    expect(bucket.blobKeys(PROJECT)).toEqual([`_blobs/${PROJECT}/${pic.oid}`]);
    expect(result.deleted).toBe(0);
    expect(result.skippedProjects).toEqual([{ project: PROJECT, reason: 'manifest-in-flight' }]);
    const answer = (await opened!.json()) as ManifestAnswer;
    expect((await postCommit(server, PROJECT, DEVICE_KEY, answer.buildId)).status).toBe(202);
  });

  it('gc-race-slow-sweep: a manifest older than the snapshot less the grace does not hold back the clean-up, however late the delete', async () => {
    const { bucket, firestore, storage } = setup();
    const [pic] = pictures(1);
    bucket.seed(`_blobs/${PROJECT}/${pic.oid}`, pic.bytes, OLD);
    bucket.seed(`_blobuse/${PROJECT}/touch`, '', new Date(NOW.getTime() - GC_MANIFEST_GRACE_MS - 1000));
    const snapshot = firestore.listDeltaBuilds.bind(firestore);
    firestore.listDeltaBuilds = async (project: string, limit?: number) => {
      const rows = await snapshot(project, limit);
      vi.setSystemTime(new Date(NOW.getTime() + 10 * MIN));
      return rows;
    };
    const result = await runBlobGc({ firestore: firestore as never, storage });
    expect(result).toMatchObject({ deleted: 1, errors: 0, skippedProjects: [] });
  });

  describe('marker re-check cadence', () => {
    const seedMany = (bucket: ReturnType<typeof setup>['bucket'], n: number) => {
      for (const p of pictures(n)) bucket.seed(`_blobs/${PROJECT}/${p.oid}`, p.bytes, OLD);
    };
    const markerReads = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((c) => String(c[0]).startsWith('_blobuse/')).length;

    it('reads the marker before the first delete and then once per 50 deletes, not per delete', async () => {
      const { bucket, firestore, storage } = setup();
      seedMany(bucket, 120);
      const listKeys = vi.spyOn(storage, 'listKeys');
      const result = await runBlobGc({ firestore: firestore as never, storage, now: NOW });
      expect(result).toMatchObject({ deleted: 120, errors: 0, skippedProjects: [] });
      expect(GC_MARKER_RECHECK_EVERY).toBe(50);
      expect(markerReads(listKeys)).toBe(3); // before delete 1, 51 and 101
    });

    it('a manifest that arrives mid-sweep stops the project at the next re-check', async () => {
      const { bucket, firestore, storage } = setup();
      seedMany(bucket, 120);
      const del = storage.delete.bind(storage);
      let deletes = 0;
      storage.delete = async (key: string) => {
        await del(key);
        if (++deletes === 10) bucket.seed(`_blobuse/${PROJECT}/touch`, '', new Date(NOW.getTime() + 1000));
      };
      const result = await runBlobGc({ firestore: firestore as never, storage, now: NOW });
      expect(result.deleted).toBe(GC_MARKER_RECHECK_EVERY);
      expect(result.skippedProjects).toEqual([{ project: PROJECT, reason: 'manifest-in-flight' }]);
    });
  });

  it('commit-release-failure: a claim that cannot be given back after a failed send is logged, with ids only', async () => {
    const { server, firestore, queue } = setup();
    const opened = await openAndUpload(server, PROJECT, DEVICE_KEY, pictures(2, 70), 'sync-attempt-release');
    queue.send.mockRejectedValueOnce(new Error('queue down'));
    firestore.releaseDeltaCommit = async () => {
      throw new Error('firestore down secret-detail');
    };
    const logged = vi.spyOn(log, 'error');
    const reply = await postCommit(server, PROJECT, DEVICE_KEY, opened.answer.buildId);
    expect(reply.status).toBe(500);
    const call = logged.mock.calls.find((c) => c[0] === 'delta commit release failed');
    expect(call, 'release failure logged').toBeDefined();
    expect(call![1]).toMatchObject({ project: PROJECT, build_id: opened.answer.buildId, err_code: 'delta_commit_release_failed' });
    const text = JSON.stringify(call);
    for (const clientValue of ['sync-attempt-release', DEVICE_KEY, 'secret-detail', 'firestore down']) expect(text).not.toContain(clientValue);
  });
});
