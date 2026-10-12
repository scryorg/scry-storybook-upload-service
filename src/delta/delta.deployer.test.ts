// Slice 2 (feature content-hash-identity): the CI deployer sends only changed pictures through /delta with a project key.
//   - a storybook build with a project upload key works; another project's key, or a device key, is refused (G6)
//   - "transfers": ["r2-presigned"] is opt-in: links go straight to R2 with a signed SHA-256 checksum; without it the answer is what it was (Scry Sync 0.1.7)
//   - the commit proves every listed picture is held by this project before queueing (409 missing_blobs with a count)
//   - counts only in log lines, a request id on every line, the transfer kind as a field; a foreign key or project never reaches a line or a stored field
// The request/response bodies are recorded to test/fixtures/deployer-delta/ (RECORD_FIXTURES=1) and compared with the committed copy otherwise;
// scry-node builds its own requests from a copy of them.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OTHER_PROJECT,
  OTHER_PROJECT_KEY,
  DEVICE_KEY,
  PLAIN_KEY,
  PROJECT,
  manifestBody,
  pictures,
  postCommit,
  postManifest,
  putBlob,
  scfFor,
  setup,
  type ManifestAnswer,
} from './delta.test-support.js';

const FIXTURES = new URL('../../test/fixtures/deployer-delta/', import.meta.url);
const LEGACY = new URL('../../test/fixtures/delta-legacy/manifest-response.json', import.meta.url);
const RECORD = process.env.RECORD_FIXTURES === '1';
/** The service mints its own request id (it never trusts an inbound one); the recorded 409 carries this stand-in. */
const REQUEST_ID_FIXTURE = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
const FROZEN = new Date('2026-10-12T12:00:00.000Z');
const STORYBOOK = { kind: 'storybook', platform: 'web' } as const;
const DEPLOYER_IDEMPOTENCY = 'deployer-pr-12-attempt-1';

const pics = pictures(3);
const storybookBody = (overrides: Record<string, unknown> = {}) =>
  manifestBody(pics, { version: 'pr-12-abc1234', source: 'storybook:web', scf: scfFor(pics, STORYBOOK), ...overrides });
const withTransfers = (transfers: string[]) => storybookBody({ transfers });
const idHeaders = { 'Idempotency-Key': DEPLOYER_IDEMPOTENCY };

/** Compare with the committed fixture, or write it when recording. */
function fixture(name: string, value: unknown) {
  const url = new URL(name, FIXTURES);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (RECORD) {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(url, text);
  }
  expect(existsSync(url), `fixture ${name} is missing: run with RECORD_FIXTURES=1`).toBe(true);
  expect(readFileSync(url, 'utf8'), `fixture ${name} is out of date: run with RECORD_FIXTURES=1`).toBe(text);
}

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

/** What a direct-to-R2 PUT leaves behind: the object under the project's blob prefix (the bucket checks the bytes itself). */
const landDirectly = (bucket: ReturnType<typeof setup>['bucket'], project: string, p: { oid: string; bytes: Uint8Array }) => bucket.seed(`_blobs/${project}/${p.oid}`, p.bytes, new Date());

describe('a storybook build with a project upload key', () => {
  it('is accepted for its own project and refused for another project, a device key and a missing key', async () => {
    const { server } = setup();
    const own = await postManifest(server, PROJECT, PLAIN_KEY, storybookBody(), idHeaders);
    expect(own.status).toBe(201);
    const { buildId } = (await own.json()) as ManifestAnswer;

    for (const [label, key, status] of [
      ["another project's key on this project's URL", OTHER_PROJECT_KEY, 403],
      ['a Scry Sync device key (pinned to its own source)', DEVICE_KEY, 403],
      ['no key', undefined, 401],
    ] as const) {
      expect((await postManifest(server, PROJECT, key, storybookBody(), { 'Idempotency-Key': 'deployer-other-attempt' })).status, `manifest: ${label}`).toBe(status);
      expect((await putBlob(server, PROJECT, key, pics[0].oid, pics[0].bytes, buildId)).status, `blob: ${label}`).toBe(status);
      expect((await postCommit(server, PROJECT, key, buildId)).status, `commit: ${label}`).toBe(status);
    }
    // The other project's key works on the other project's own URL, and cannot see this project's build.
    expect((await postManifest(server, OTHER_PROJECT, OTHER_PROJECT_KEY, storybookBody(), { 'Idempotency-Key': 'deployer-b-attempt-1' })).status).toBe(201);
    expect((await postCommit(server, OTHER_PROJECT, OTHER_PROJECT_KEY, buildId)).status).toBe(404);
  });
});

describe('transfers', () => {
  it('no transfers field: the answer is exactly what the server answered before this change (Scry Sync 0.1.7 unaffected)', async () => {
    const { server } = setup();
    const res = await postManifest(server, PROJECT, PLAIN_KEY, storybookBody(), idHeaders);
    expect(res.status).toBe(201);
    const text = await res.text();
    if (RECORD && process.env.RECORD_LEGACY === '1') {
      mkdirSync(new URL('./', LEGACY), { recursive: true });
      writeFileSync(LEGACY, `${text}\n`);
    }
    expect(text).toBe(readFileSync(LEGACY, 'utf8').trimEnd());
    expect(text).not.toContain('"transfer"');
    expect(text).not.toContain('r2.cloudflarestorage.com');
  });

  it('"basic" and unknown transfers answer with same-origin links and say so', async () => {
    const { server } = setup();
    const res = await postManifest(server, PROJECT, PLAIN_KEY, withTransfers(['basic']), idHeaders);
    const answer = (await res.json()) as ManifestAnswer & { transfer: string };
    expect(answer.transfer).toBe('basic');
    expect(answer.objects.every((o) => o.actions!.upload.href.startsWith(`http://localhost/delta/${PROJECT}/blobs/`))).toBe(true);
    fixture('manifest-response-basic.json', answer);

    const unknown = await postManifest(server, PROJECT, PLAIN_KEY, withTransfers(['lfs-custom']), { 'Idempotency-Key': 'deployer-unknown-1' });
    expect(((await unknown.json()) as { transfer: string }).transfer).toBe('basic');
  });

  it('"r2-presigned": one signed R2 PUT per missing picture, exact length, SHA-256 checksum signed, no Scry key on the link', async () => {
    const { server, bucket } = setup();
    const res = await postManifest(server, PROJECT, PLAIN_KEY, withTransfers(['r2-presigned', 'basic']), idHeaders);
    expect(res.status).toBe(201);
    const answer = (await res.json()) as ManifestAnswer & { transfer: string };
    expect(answer.transfer).toBe('r2-presigned');
    expect(answer.objects).toHaveLength(3);
    for (const o of answer.objects) {
      const up = o.actions!.upload;
      const url = new URL(up.href);
      expect(url.host).toBe('my-storybooks-test.acct123.r2.cloudflarestorage.com');
      expect(url.pathname).toBe(`/_blobs/${PROJECT}/${o.oid}`);
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host;x-amz-checksum-sha256');
      expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
      expect(url.searchParams.get('x-amz-checksum-sha256')).toBeNull(); // a signed header, not a query parameter
      expect(up.header['x-amz-checksum-sha256']).toBe(Buffer.from(o.oid, 'hex').toString('base64'));
      expect(up.header['Content-Type']).toBe('application/octet-stream');
      expect(up.expires_at).toBe(answer.expiresAt);
      expect(up.href).not.toContain(PLAIN_KEY);
      expect(JSON.stringify(up)).not.toContain('build=');
    }
    expect(bucket.blobKeys(PROJECT)).toHaveLength(0); // the Worker stored nothing: the bytes go to R2 directly
    fixture('manifest-request.json', withTransfers(['r2-presigned', 'basic']));
    fixture('manifest-response-r2.json', answer);
  });

  it('pictures the project already holds get no link; a manifest with nothing to send still says r2-presigned', async () => {
    const { server, bucket } = setup();
    for (const p of pics) landDirectly(bucket, PROJECT, p);
    const res = await postManifest(server, PROJECT, PLAIN_KEY, withTransfers(['r2-presigned']), idHeaders);
    const answer = (await res.json()) as ManifestAnswer & { transfer: string };
    expect(answer.objects.every((o) => !o.actions && !o.error)).toBe(true);
    expect(answer.transfer).toBe('r2-presigned');
  });

  it('a link is only made for the picture the manifest declared: the declared size is the signed length', async () => {
    const { server } = setup();
    const answer = (await (await postManifest(server, PROJECT, PLAIN_KEY, withTransfers(['r2-presigned']), idHeaders)).json()) as ManifestAnswer;
    const o = answer.objects[0];
    const size = pics.find((p) => p.oid === o.oid)!.bytes.byteLength;
    expect(o.size).toBe(size);
    expect(new URL(o.actions!.upload.href).searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
  });

  it('when the store cannot sign, the whole answer falls back to same-origin links and says basic', async () => {
    const { server, storage } = setup();
    vi.spyOn(storage, 'getPresignedBlobUploadUrl').mockRejectedValue(new Error('no signing keys'));
    const res = await postManifest(server, PROJECT, PLAIN_KEY, withTransfers(['r2-presigned', 'basic']), idHeaders);
    const answer = (await res.json()) as ManifestAnswer & { transfer: string };
    expect(res.status).toBe(201);
    expect(answer.transfer).toBe('basic');
    expect(answer.objects.every((o) => o.actions!.upload.href.startsWith('http://localhost/delta/'))).toBe(true);
  });

  it('a repeat of the same manifest (same Idempotency-Key) gets fresh links with the same transfer', async () => {
    const { server } = setup();
    const first = await postManifest(server, PROJECT, PLAIN_KEY, withTransfers(['r2-presigned']), idHeaders);
    const again = await postManifest(server, PROJECT, PLAIN_KEY, withTransfers(['r2-presigned']), idHeaders);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { transfer: string }).transfer).toBe('r2-presigned');
    expect(first.status).toBe(201);
  });
});

describe('the commit proves every picture is there (G6)', () => {
  it('queues only when all pictures are held; otherwise 409 missing_blobs with a count and nothing is queued', async () => {
    const { server, bucket, queue } = setup();
    const opened = await postManifest(server, PROJECT, PLAIN_KEY, withTransfers(['r2-presigned']), idHeaders);
    const { buildId } = (await opened.json()) as ManifestAnswer;

    // Nothing arrived yet.
    const none = await postCommit(server, PROJECT, PLAIN_KEY, buildId);
    expect(none.status).toBe(409);
    expect(((await none.json()) as { count: number }).count).toBe(3);

    // One of three landed directly in R2: the other two are still missing.
    landDirectly(bucket, PROJECT, pics[0]);
    const partial = await postCommit(server, PROJECT, PLAIN_KEY, buildId);
    const partialId = partial.headers.get('x-scry-request-id');
    expect(partial.status).toBe(409);
    const body = (await partial.json()) as { error: string; count: number; missing: string[]; request_id?: string };
    expect(body).toMatchObject({ error: 'missing_blobs', count: 2 });
    expect(body.missing).toHaveLength(2);
    expect(queue.send).not.toHaveBeenCalled();
    fixture('commit-request.json', {});
    expect(body.request_id).toBe(partialId); // the 409 body names the request so a failed deploy can be traced
    fixture('commit-409.json', { ...body, request_id: REQUEST_ID_FIXTURE, missing: body.missing.sort() });

    // The rest lands: the commit queues the build.
    landDirectly(bucket, PROJECT, pics[1]);
    landDirectly(bucket, PROJECT, pics[2]);
    const done = await postCommit(server, PROJECT, PLAIN_KEY, buildId);
    expect(done.status).toBe(202);
    const accepted = await done.json();
    expect(accepted).toMatchObject({ queued: true });
    expect(queue.send).toHaveBeenCalledTimes(1);
    fixture('commit-response.json', accepted);
  });

  it("a picture that only another project holds does not count: same 409, nothing queued", async () => {
    const { server, bucket, queue } = setup();
    for (const p of pics) landDirectly(bucket, OTHER_PROJECT, p);
    const opened = await postManifest(server, PROJECT, PLAIN_KEY, withTransfers(['r2-presigned']), idHeaders);
    const answer = (await opened.json()) as ManifestAnswer;
    expect(answer.objects.every((o) => o.actions)).toBe(true); // this project holds none of them
    const res = await postCommit(server, PROJECT, PLAIN_KEY, answer.buildId);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { count: number }).count).toBe(3);
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('a build that names pictures it never sent is never queued, however often it commits', async () => {
    const { server, queue } = setup();
    const opened = await postManifest(server, PROJECT, PLAIN_KEY, withTransfers(['r2-presigned']), idHeaders);
    const { buildId } = (await opened.json()) as ManifestAnswer;
    for (let i = 0; i < 3; i++) expect((await postCommit(server, PROJECT, PLAIN_KEY, buildId)).status).toBe(409);
    expect(queue.send).not.toHaveBeenCalled();
  });
});

describe('logs and stored fields', () => {
  const parsed = () =>
    lines
      .filter((l) => l.startsWith('{'))
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return {};
        }
      });

  it('counts only, a request id on every delta line, the transfer kind as a field', async () => {
    const { server, bucket } = setup();
    const opened = await postManifest(server, PROJECT, PLAIN_KEY, withTransfers(['r2-presigned']), idHeaders);
    const manifestId = opened.headers.get('x-scry-request-id');
    const { buildId } = (await opened.json()) as ManifestAnswer;
    await postCommit(server, PROJECT, PLAIN_KEY, buildId); // 409: nothing landed
    for (const p of pics) landDirectly(bucket, PROJECT, p);
    await postCommit(server, PROJECT, PLAIN_KEY, buildId);

    const delta = parsed().filter((l) => typeof l.msg === 'string' && l.msg.startsWith('delta '));
    expect(delta.length).toBeGreaterThanOrEqual(3);
    for (const l of delta) expect(l.request_id, `line "${String(l.msg)}"`).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const manifest = delta.find((l) => l.msg === 'delta manifest')!;
    expect(manifest.request_id).toBe(manifestId); // the id in the response header is the one logged
    expect(manifest.reason).toBe('transfer_r2-presigned');
    const refused = delta.find((l) => l.msg === 'delta refused')!;
    expect(refused.err_code).toBe('delta_missing_blobs');
    expect((refused.attrs as Record<string, number>)['delta.items']).toBe(3);

    const text = lines.join('\n');
    for (const p of pics) {
      expect(text).not.toContain(p.oid);
      expect(text).not.toContain(p.path);
    }
    expect(text).not.toContain('r2.cloudflarestorage.com');
    expect(text).not.toContain('X-Amz-');
    expect(text).not.toContain(PLAIN_KEY);
  });

  it('canary: a foreign key or project never reaches a log line, an answer or a stored field', async () => {
    const { server, firestore, bucket } = setup();
    const opened = await postManifest(server, PROJECT, PLAIN_KEY, withTransfers(['r2-presigned']), idHeaders);
    const { buildId } = (await opened.json()) as ManifestAnswer;
    const answers: string[] = [];
    // Another project's key on every route of this project, with an R2 opt-in, and this project's key against the other project's URL.
    answers.push(await (await postManifest(server, PROJECT, OTHER_PROJECT_KEY, withTransfers(['r2-presigned']), { 'Idempotency-Key': 'deployer-foreign-1' })).text());
    answers.push(await (await putBlob(server, PROJECT, OTHER_PROJECT_KEY, pics[0].oid, pics[0].bytes, buildId)).text());
    answers.push(await (await postCommit(server, PROJECT, OTHER_PROJECT_KEY, buildId)).text());
    answers.push(await (await postManifest(server, OTHER_PROJECT, PLAIN_KEY, withTransfers(['r2-presigned']), { 'Idempotency-Key': 'deployer-foreign-2' })).text());
    answers.push(await (await postCommit(server, OTHER_PROJECT, PLAIN_KEY, buildId)).text());
    landDirectly(bucket, PROJECT, pics[0]);
    answers.push(await (await postCommit(server, PROJECT, PLAIN_KEY, buildId)).text());

    const foreign = [OTHER_PROJECT_KEY, OTHER_PROJECT];
    const stored = JSON.stringify([...firestore.builds.values()]) + JSON.stringify([...firestore.keys.values()]);
    const everything = [lines.join('\n'), answers.join('\n'), stored];
    for (const secret of foreign) for (const where of everything) expect(where).not.toContain(secret);
    expect(lines.length).toBeGreaterThan(0);
  });
});
