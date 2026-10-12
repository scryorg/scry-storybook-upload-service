// PR #72 round 1: one deploy = one build (F42) and R2-sent pictures pass the picture checks (F38).
// The CI deployer's first call (the Storybook zip presign) opens build B. Its delta manifest names B (`buildId`) and the delta
// attaches to B instead of opening a second build, so a deploy is one row, one charge and one search result set.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEASURE_IMAGE_MAX_PREFIX_BYTES } from '../vendor/scf/dist/image-dimensions.js';
import { R2_DEADLINE_MARGIN_MS } from './limits.js';
import {
  COMMIT_SHA,
  OTHER_PROJECT,
  OTHER_PROJECT_KEY,
  DEVICE_KEY,
  PLAIN_KEY,
  PROJECT,
  STORYBOOK_VERSION,
  attachBody,
  deployerFixture,
  fakePng,
  manifestBody,
  pictures,
  postCommit,
  postManifest,
  putBlob,
  scfFor,
  seedStorybookBuild,
  setup,
  sha256,
  type ManifestAnswer,
  type Picture,
} from './delta.test-support.js';

const FROZEN = new Date('2026-10-12T12:00:00.000Z');
const REQUEST_ID_FIXTURE = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
const ATTACH_IDEMPOTENCY = 'deployer-pr-12-attempt-1';
const idHeaders = { 'Idempotency-Key': ATTACH_IDEMPOTENCY };
const STORYBOOK = { kind: 'storybook', platform: 'web' } as const;
const pics = pictures(3);

let lines: string[];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FROZEN);
  lines = [];
  const grab = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  for (const m of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(grab);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Env = ReturnType<typeof setup>;

const withTransfers = (p: ReadonlyArray<Picture>, buildId: string, transfers = ['r2-presigned', 'basic']) => attachBody(p, buildId, { transfers });

/** What a direct-to-R2 PUT leaves behind: the object under the project's blob prefix. */
const landDirectly = (env: Env, p: { oid: string; bytes: Uint8Array }, project = PROJECT) => env.bucket.seed(`_blobs/${project}/${p.oid}`, p.bytes, new Date());

async function openAttached(env: Env, p: ReadonlyArray<Picture> = pics, transfers?: string[]) {
  const b = await seedStorybookBuild(env.firestore, PROJECT);
  const body = transfers ? withTransfers(p, b.id, transfers) : attachBody(p, b.id);
  const res = await postManifest(env.server, PROJECT, PLAIN_KEY, body, idHeaders);
  return { b, res, answer: (await res.json()) as ManifestAnswer & { transfer?: string } };
}

describe('F42: the manifest attaches to the deploy\'s own build', () => {
  it('opens no second build: the answer names B, B becomes the delta build, and its files sit under B\'s own prefix', async () => {
    const env = setup();
    const { b, res, answer } = await openAttached(env);
    expect(res.status).toBe(201);
    expect(env.firestore.builds.size).toBe(1);
    expect(answer.buildId).toBe(b.id);
    expect(answer.buildNumber).toBe(b.buildNumber);

    const row = env.firestore.builds.get(`${PROJECT}/${b.id}`)!;
    expect(row.delta).toBe(true);
    expect(row.deltaDeadline?.toISOString()).toBe(answer.expiresAt);
    expect(row.zipUrl).toBe(b.zipUrl); // the Storybook zip stays what the build points at
    expect(row.commitSha).toBe(COMMIT_SHA);
    expect(row.branch).toBe('feature/login');

    const prefix = `${PROJECT}/${STORYBOOK_VERSION}/builds/${b.buildNumber}`;
    expect(env.bucket.objects.has(`${prefix}/scf.json`)).toBe(true);
    expect(env.bucket.objects.has(`${prefix}/images.json`)).toBe(true);
    expect(JSON.parse(env.bucket.text(`${prefix}/images.json`)!)).toEqual(Object.fromEntries(pics.map((p) => [p.path, { oid: p.oid, size: p.bytes.byteLength }])));
    deployerFixture('manifest-request.json', withTransfers(pics, b.id));
  });

  it('PUT then commit queues the SAME build with format scf-delta and a manifest key BPS accepts for that build', async () => {
    const env = setup();
    const { b, answer } = await openAttached(env);
    for (const p of pics) expect((await putBlob(env.server, PROJECT, PLAIN_KEY, p.oid, p.bytes, answer.buildId)).status).toBe(201);
    const done = await postCommit(env.server, PROJECT, PLAIN_KEY, b.id);
    expect(done.status).toBe(202);
    expect(await done.json()).toMatchObject({ buildId: b.id, buildNumber: b.buildNumber, queued: true });
    expect(env.queue.send).toHaveBeenCalledTimes(1);
    const message = env.queue.send.mock.calls[0][0] as Record<string, string>;
    const prefix = `${PROJECT}/${STORYBOOK_VERSION}/builds/${b.buildNumber}`;
    expect(message).toMatchObject({ projectId: PROJECT, versionId: STORYBOOK_VERSION, buildId: b.id, format: 'scf-delta', manifestKey: `${prefix}/scf.json`, imagesKey: `${prefix}/images.json` });
    expect(env.firestore.builds.size).toBe(1);
    expect(env.firestore.builds.get(`${PROJECT}/${b.id}`)!.processingStatus).toBe('queued');
  });

  it('a repeat with the same Idempotency-Key and manifest answers the same build (200), before and after the commit', async () => {
    const env = setup();
    const { b, res } = await openAttached(env);
    expect(res.status).toBe(201);
    const again = await postManifest(env.server, PROJECT, PLAIN_KEY, attachBody(pics, b.id), idHeaders);
    expect(again.status).toBe(200);
    expect(((await again.json()) as ManifestAnswer).buildId).toBe(b.id);
    for (const p of pics) await putBlob(env.server, PROJECT, PLAIN_KEY, p.oid, p.bytes, b.id);
    expect((await postCommit(env.server, PROJECT, PLAIN_KEY, b.id)).status).toBe(202);
    const afterCommit = await postManifest(env.server, PROJECT, PLAIN_KEY, attachBody(pics, b.id), idHeaders);
    expect(afterCommit.status).toBe(200);
    expect(((await afterCommit.json()) as ManifestAnswer).buildId).toBe(b.id);
    expect(env.firestore.builds.size).toBe(1);
    expect(env.queue.send).toHaveBeenCalledTimes(1);
  });

  it('the same Idempotency-Key with another manifest is still idempotency_conflict', async () => {
    const env = setup();
    const { b } = await openAttached(env);
    const other = await postManifest(env.server, PROJECT, PLAIN_KEY, attachBody(pictures(2, 50), b.id), idHeaders);
    expect(other.status).toBe(409);
    expect(((await other.json()) as { error: string }).error).toBe('idempotency_conflict');
  });

  it('git provenance is validated like the zip path: a commitSha that is not hex is a 400 and nothing is attached', async () => {
    const env = setup();
    const b = await seedStorybookBuild(env.firestore, PROJECT);
    const res = await postManifest(env.server, PROJECT, PLAIN_KEY, attachBody(pics, b.id, { commitSha: 'not-a-sha' }), idHeaders);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: string[] }).fields).toContain('commitSha');
    expect(env.firestore.builds.get(`${PROJECT}/${b.id}`)!.delta).toBeUndefined();
  });

  it('a manifest without buildId is today\'s behaviour: a new delta build next to the Storybook build, no provenance written', async () => {
    const env = setup();
    const b = await seedStorybookBuild(env.firestore, PROJECT);
    const res = await postManifest(env.server, PROJECT, PLAIN_KEY, manifestBody(pics, { version: STORYBOOK_VERSION, source: 'storybook:web', scf: scfFor(pics, STORYBOOK) }), idHeaders);
    expect(res.status).toBe(201);
    const answer = (await res.json()) as ManifestAnswer;
    expect(answer.buildId).not.toBe(b.id);
    expect(env.firestore.builds.size).toBe(2);
    expect(env.firestore.builds.get(`${PROJECT}/${b.id}`)!.delta).toBeUndefined();
  });
});

describe('F42: when B cannot be attached to', () => {
  const refusedBody = async (res: Response) => (await res.json()) as { error: string; message: string; request_id?: string };

  async function expectRefused(env: Env, buildId: string, key = PLAIN_KEY, project = PROJECT, idem = 'deployer-refused-1') {
    const res = await postManifest(env.server, project, key, attachBody(pics, buildId), { 'Idempotency-Key': idem });
    expect(res.status).toBe(409);
    const body = await refusedBody(res);
    expect(body.error).toBe('build_not_attachable');
    return body;
  }

  it.each([
    ['a build that does not exist', async () => 'nosuchbuild1'],
    ['a build of another project', async (env: Env) => (await seedStorybookBuild(env.firestore, OTHER_PROJECT)).id],
    ['a delta build (Scry Sync or an earlier attach)', async (env: Env) => {
      const b = await seedStorybookBuild(env.firestore, PROJECT);
      await env.firestore.updateBuild(PROJECT, b.id, { delta: true, deltaDeadline: new Date(FROZEN.getTime() + 60_000) });
      return b.id;
    }],
    ['a build that is already committed or queued', async (env: Env) => {
      const b = await seedStorybookBuild(env.firestore, PROJECT);
      await env.firestore.updateBuild(PROJECT, b.id, { processingStatus: 'queued' });
      return b.id;
    }],
    ['a build that has been processed', async (env: Env) => {
      const b = await seedStorybookBuild(env.firestore, PROJECT);
      await env.firestore.updateBuild(PROJECT, b.id, { processingStatus: 'completed' });
      return b.id;
    }],
    ['a build whose metadata ZIP is already there', async (env: Env) => {
      const b = await seedStorybookBuild(env.firestore, PROJECT);
      env.bucket.seed(`${PROJECT}/${STORYBOOK_VERSION}/builds/${b.buildNumber}/metadata-screenshots.zip`, 'zip', new Date());
      return b.id;
    }],
    ['a bundle build (it has a source)', async (env: Env) => {
      const b = await env.firestore.createBuild(PROJECT, { versionId: 'bundle-1', zipUrl: '', source: { kind: 'storybook', platform: 'web' }, uploadedByKeyProject: PROJECT, firstStep: 'presign' } as never);
      return b.id;
    }],
    ['a build made through the dashboard door', async (env: Env) => {
      const b = await env.firestore.createBuild(PROJECT, { versionId: STORYBOOK_VERSION, zipUrl: 'https://x/y.zip', channel: 'dashboard', firstStep: 'presign' } as never);
      return b.id;
    }],
  ])('%s: 409 build_not_attachable, nothing is written, and the log has no id', async (_label, make) => {
    const env = setup();
    const buildId = await make(env);
    const before = env.bucket.puts.length;
    const rowBefore = JSON.stringify(env.firestore.builds.get(`${PROJECT}/${buildId}`) ?? null);
    const body = await expectRefused(env, buildId);
    expect(body.message).not.toContain(buildId);
    expect(env.bucket.puts).toHaveLength(before);
    expect(JSON.stringify(env.firestore.builds.get(`${PROJECT}/${buildId}`) ?? null)).toBe(rowBefore);
    expect(lines.join('\n')).not.toContain(buildId);
    expect(lines.join('\n')).toContain('delta_build_not_attachable');
    expect(env.queue.send).not.toHaveBeenCalled();
  });

  it('another project\'s key cannot attach to this project\'s build: its own URL says build_not_attachable, this project\'s URL says 403', async () => {
    const env = setup();
    const b = await seedStorybookBuild(env.firestore, PROJECT);
    await expectRefused(env, b.id, OTHER_PROJECT_KEY, OTHER_PROJECT, 'deployer-b-attempt-1');
    expect((await postManifest(env.server, PROJECT, OTHER_PROJECT_KEY, attachBody(pics, b.id), idHeaders)).status).toBe(403);
    expect(env.firestore.builds.get(`${PROJECT}/${b.id}`)!.delta).toBeUndefined();
  });

  it('a Scry Sync device key never attaches to a Storybook build', async () => {
    const env = setup();
    const b = await seedStorybookBuild(env.firestore, PROJECT);
    expect((await postManifest(env.server, PROJECT, DEVICE_KEY, attachBody(pics, b.id), idHeaders)).status).toBe(403);
    expect(env.firestore.builds.get(`${PROJECT}/${b.id}`)!.delta).toBeUndefined();
  });

  it('two different manifests racing for one build: exactly one attaches, the other is refused', async () => {
    const env = setup();
    const b = await seedStorybookBuild(env.firestore, PROJECT);
    const other = pictures(2, 60);
    const [one, two] = await Promise.all([
      postManifest(env.server, PROJECT, PLAIN_KEY, attachBody(pics, b.id), { 'Idempotency-Key': 'deployer-race-aaaa' }),
      postManifest(env.server, PROJECT, PLAIN_KEY, attachBody(other, b.id), { 'Idempotency-Key': 'deployer-race-bbbb' }),
    ]);
    expect([one.status, two.status].sort()).toEqual([201, 409]);
    const loser = one.status === 409 ? one : two;
    expect(((await loser.json()) as { error: string }).error).toBe('build_not_attachable');
  });

  it('records the refusal fixture', async () => {
    const env = setup();
    const b = await seedStorybookBuild(env.firestore, PROJECT);
    await env.firestore.updateBuild(PROJECT, b.id, { processingStatus: 'queued' });
    const res = await postManifest(env.server, PROJECT, PLAIN_KEY, attachBody(pics, b.id), idHeaders);
    const body = await refusedBody(res);
    expect(body.request_id).toBe(res.headers.get('x-scry-request-id'));
    deployerFixture('manifest-response-attach-refused.json', { ...body, request_id: REQUEST_ID_FIXTURE });
  });
});

describe('F42: r2-presigned deadline', () => {
  it('the build stays open for the whole life of the links plus a margin; without r2 the deadline is unchanged', async () => {
    const env = setup();
    const { b, answer } = await openAttached(env, pics, ['r2-presigned', 'basic']);
    const row = env.firestore.builds.get(`${PROJECT}/${b.id}`)!;
    expect(answer.transfer).toBe('r2-presigned');
    expect(new Date(answer.objects[0].actions!.upload.expires_at).getTime()).toBe(new Date(answer.expiresAt).getTime());
    expect(row.deltaDeadline!.getTime()).toBe(new Date(answer.expiresAt).getTime() + R2_DEADLINE_MARGIN_MS);

    const plain = setup();
    const { b: b2, answer: a2 } = await openAttached(plain);
    expect(plain.firestore.builds.get(`${PROJECT}/${b2.id}`)!.deltaDeadline!.getTime()).toBe(new Date(a2.expiresAt).getTime());
  });
});

// ---- F38 ------------------------------------------------------------------------------------------------

const textPicture = (seed: number): Picture => {
  const bytes = new TextEncoder().encode(`this is not a picture ${seed}`.repeat(10));
  return { path: `images/text-${seed}.png`, bytes, oid: sha256(bytes) };
};
const hugePicture = (seed: number): Picture => {
  const bytes = fakePng(seed, 30000, 30000);
  return { path: `images/huge-${seed}.png`, bytes, oid: sha256(bytes) };
};

describe('F38: pictures sent straight to R2 pass the picture checks at commit', () => {
  async function openR2(env: Env, p: ReadonlyArray<Picture>) {
    const { b, answer } = await openAttached(env, p, ['r2-presigned', 'basic']);
    expect(answer.transfer).toBe('r2-presigned');
    return { b, answer };
  }

  it.each([
    ['bytes that are not a picture', textPicture],
    ['a picture over the dimension limit', hugePicture],
  ])('%s: 422 invalid_picture with a count, the blob is deleted, the build is not queued, the log names nothing', async (_label, bad) => {
    const env = setup();
    const good = pictures(2, 70);
    const evil = bad(9);
    const all = [...good, evil];
    const { b } = await openR2(env, all);
    for (const p of all) landDirectly(env, p);

    const res = await postCommit(env.server, PROJECT, PLAIN_KEY, b.id);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; count: number; request_id?: string; missing?: unknown };
    expect(body).toMatchObject({ error: 'invalid_picture', count: 1 });
    expect(body).not.toHaveProperty('missing');
    expect(env.queue.send).not.toHaveBeenCalled();
    expect(env.firestore.builds.get(`${PROJECT}/${b.id}`)!.processingStatus).toBeUndefined();
    expect(env.bucket.blobKeys(PROJECT).sort()).toEqual(good.map((p) => `_blobs/${PROJECT}/${p.oid}`).sort()); // only the bad one went
    const text = lines.join('\n');
    expect(text).toContain('delta_invalid_picture');
    for (const p of all) {
      expect(text).not.toContain(p.oid);
      expect(text).not.toContain(p.path);
    }
    if (bad === textPicture) deployerFixture('commit-422.json', { ...body, request_id: REQUEST_ID_FIXTURE });

    // The client sends it again (with a good picture this time) and the commit now answers like any other.
    const retry = await postCommit(env.server, PROJECT, PLAIN_KEY, b.id);
    expect(retry.status).toBe(409);
    expect(((await retry.json()) as { error: string; count: number }).count).toBe(1);
  });

  it('good R2 pictures commit; only the first bytes of the pictures offered through r2-presigned are read, and a picture held earlier is not read at all', async () => {
    const env = setup();
    const held = pictures(1, 90)[0];
    landDirectly(env, held); // already in the project before the manifest: no link, no check
    const all = [held, ...pictures(3, 80)];
    const { b, answer } = await openR2(env, all);
    expect(answer.objects.filter((o) => o.actions)).toHaveLength(3);
    for (const p of all) landDirectly(env, p);

    const res = await postCommit(env.server, PROJECT, PLAIN_KEY, b.id);
    expect(res.status).toBe(202);
    const reads = env.bucket.rangeReads;
    expect(reads.map((r) => r.key).sort()).toEqual(all.filter((p) => p !== held).map((p) => `_blobs/${PROJECT}/${p.oid}`).sort());
    for (const r of reads) {
      expect(r.offset).toBe(0);
      expect(r.length).toBeLessThanOrEqual(MEASURE_IMAGE_MAX_PREFIX_BYTES);
    }
    expect(env.queue.send).toHaveBeenCalledTimes(1);
  });

  it('pictures sent through the Worker (basic) were checked at the PUT: the commit reads none of them', async () => {
    const env = setup();
    const { b, answer } = await openAttached(env);
    expect(answer.transfer).toBeUndefined();
    for (const p of pics) await putBlob(env.server, PROJECT, PLAIN_KEY, p.oid, p.bytes, b.id);
    expect((await postCommit(env.server, PROJECT, PLAIN_KEY, b.id)).status).toBe(202);
    expect(env.bucket.rangeReads).toHaveLength(0);
  });

  it('a bad picture that only some other build offered through R2 is not this build\'s to reject', async () => {
    const env = setup();
    const { b } = await openAttached(env, pics, ['basic']);
    const planted = textPicture(3);
    landDirectly(env, planted); // sits in the project, but this build never referenced it
    for (const p of pics) await putBlob(env.server, PROJECT, PLAIN_KEY, p.oid, p.bytes, b.id);
    expect((await postCommit(env.server, PROJECT, PLAIN_KEY, b.id)).status).toBe(202);
    expect(env.bucket.blobKeys(PROJECT)).toContain(`_blobs/${PROJECT}/${planted.oid}`);
  });

  it('the checks run with bounded concurrency', async () => {
    const env = setup();
    const many = pictures(40, 200);
    const { b } = await openR2(env, many);
    for (const p of many) landDirectly(env, p);
    let inFlight = 0;
    let peak = 0;
    const original = env.bucket.get.bind(env.bucket);
    env.bucket.get = (async (...args: Parameters<typeof original>) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      try {
        return await original(...args);
      } finally {
        inFlight--;
      }
    }) as typeof original;
    const res = await postCommit(env.server, PROJECT, PLAIN_KEY, b.id);
    expect(res.status).toBe(202);
    expect(env.bucket.rangeReads).toHaveLength(40);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });
});
