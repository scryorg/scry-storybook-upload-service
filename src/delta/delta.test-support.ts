// Shared fakes for the /delta tests (feature sync-delta-upload). Not a test file itself.
// The storage is the real R2S3StorageService over an in-memory bucket that behaves like R2 where it matters here:
// put() refuses a body that does not hash to options.sha256, list() pages by prefix with `uploaded`, head() answers null when absent.
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { vi } from 'vitest';
import { app, type AppEnv } from '../app.js';
import { R2S3StorageService } from '../services/storage/storage.worker.js';
import type { ApiKeyService } from '../services/apikey/apikey.service.js';
import type { FirestoreService } from '../services/firestore/firestore.service.js';
import type { Build, CreateBuildData, DeltaKey, UpdateBuildData } from '../services/firestore/firestore.types.js';

export const PROJECT = 'projAAAAAAAAAAAAAAAA';
export const OTHER_PROJECT = 'projBBBBBBBBBBBBBBBB';
export const DEVICE_KEY = `scry_proj_${PROJECT}_devicesecret`;
export const OTHER_DEVICE_KEY = `scry_proj_${OTHER_PROJECT}_devicesecret`;
export const OTHER_PROJECT_KEY = `scry_proj_${OTHER_PROJECT}_plainsecret`;
export const REVOKED_KEY = `scry_proj_${PROJECT}_revokedsecret`;
export const PLAIN_KEY = `scry_proj_${PROJECT}_plainsecret`;
export const CI_KEY = `scry_proj_${PROJECT}_cisecret`;
export const IDEMPOTENCY = 'sync-attempt-0001';
export const SOURCE = 'x-scry-sync:other';
export const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

type Stored = { bytes: Uint8Array; contentType?: string; uploaded: Date };

export class FakeR2 {
  readonly objects = new Map<string, Stored>();
  now: () => Date = () => new Date();
  readonly puts: string[] = [];
  async put(key: string, body: Uint8Array, options?: { httpMetadata?: { contentType?: string }; sha256?: string }) {
    if (options?.sha256 && sha256(body) !== options.sha256) throw new Error('checksum mismatch');
    this.puts.push(key);
    this.objects.set(key, { bytes: body, contentType: options?.httpMetadata?.contentType, uploaded: this.now() });
  }
  async head(key: string) {
    const o = this.objects.get(key);
    return o ? { size: o.bytes.byteLength, httpMetadata: { contentType: o.contentType } } : null;
  }
  async get(key: string) {
    const o = this.objects.get(key);
    if (!o) return null;
    return {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(o.bytes);
          controller.close();
        },
      }),
      arrayBuffer: async () => o.bytes.buffer.slice(o.bytes.byteOffset, o.bytes.byteOffset + o.bytes.byteLength),
    };
  }
  async delete(key: string | string[]) {
    for (const k of Array.isArray(key) ? key : [key]) this.objects.delete(k);
  }
  /** Number of list() calls so far (a test asserts a big existence check stays cheap). */
  listCalls = 0;
  async list(opts: { prefix?: string; cursor?: string; startAfter?: string; limit?: number } = {}) {
    this.listCalls++;
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(opts.prefix ?? '')).sort();
    // Like R2: `cursor` (here: the last key of the previous page) continues a listing, `startAfter` starts one after a key.
    const after = opts.cursor ?? opts.startAfter;
    const start = after === undefined ? 0 : keys.findIndex((k) => k > after);
    const limit = opts.limit ?? 1000;
    const slice = start < 0 ? [] : keys.slice(start, start + limit);
    const truncated = start >= 0 && start + limit < keys.length;
    return {
      objects: slice.map((key) => ({ key, size: this.objects.get(key)!.bytes.byteLength, uploaded: this.objects.get(key)!.uploaded })),
      truncated,
      cursor: truncated ? slice[slice.length - 1] : undefined,
    };
  }
  /** Seed an object with a chosen upload time (for clean-up tests). */
  seed(key: string, bytes: Uint8Array | string, uploaded: Date) {
    this.objects.set(key, { bytes: typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes, uploaded });
  }
  text(key: string): string | undefined {
    const o = this.objects.get(key);
    return o ? new TextDecoder().decode(o.bytes) : undefined;
  }
  blobKeys(project: string): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(`_blobs/${project}/`));
  }
}

export class FakeFirestore {
  readonly builds = new Map<string, Build>();
  readonly keys = new Map<string, DeltaKey>();
  readonly counters = new Map<string, number>();
  private seq = new Map<string, number>();
  now: () => Date = () => new Date();
  trackEvent = vi.fn(async () => undefined);

  async createBuild(projectId: string, data: CreateBuildData): Promise<Build> {
    const n = (this.seq.get(projectId) ?? 0) + 1;
    this.seq.set(projectId, n);
    const build = {
      id: `build_${projectId.slice(4, 5)}_${n}`,
      projectId,
      versionId: data.versionId,
      buildNumber: n,
      zipUrl: data.zipUrl,
      status: 'active',
      createdAt: this.now(),
      createdBy: '',
      source: data.source,
      ...(data.delta ? { delta: true as const, deltaDeadline: data.deltaDeadline } : {}),
    } as Build;
    this.builds.set(`${projectId}/${build.id}`, build);
    return { ...build };
  }
  async deleteBuild(projectId: string, buildId: string) {
    this.builds.delete(`${projectId}/${buildId}`);
  }
  async getBuild(projectId: string, buildId: string) {
    const b = this.builds.get(`${projectId}/${buildId}`);
    return b ? { ...b } : null;
  }
  updateBuild = vi.fn(async (projectId: string, buildId: string, data: UpdateBuildData) => {
    const b = this.builds.get(`${projectId}/${buildId}`);
    if (b) Object.assign(b, data);
    return b ? { ...b } : null;
  });
  updateProcessingStatus = vi.fn(async (projectId: string, buildId: string, status: Build['processingStatus']) => {
    const b = this.builds.get(`${projectId}/${buildId}`);
    if (b) b.processingStatus = status;
  });
  async listDeltaBuilds(projectId: string, limit = 100) {
    return [...this.builds.values()]
      .filter((b) => b.projectId === projectId && b.delta)
      .sort((a, b) => b.buildNumber - a.buildNumber)
      .slice(0, limit)
      .map((b) => ({ ...b }));
  }
  async getDeltaKey(projectId: string, hash: string) {
    const k = this.keys.get(`${projectId}/${hash}`);
    return k ? { ...k } : null;
  }
  async createDeltaKeyIfAbsent(projectId: string, hash: string, data: DeltaKey) {
    const id = `${projectId}/${hash}`;
    if (this.keys.has(id)) return false;
    this.keys.set(id, data);
    return true;
  }
  async putDeltaKey(projectId: string, hash: string, data: DeltaKey) {
    this.keys.set(`${projectId}/${hash}`, data);
  }
  /** Atomic like the Firestore precondition: JS runs this check-and-set without yielding. */
  async claimDeltaCommit(projectId: string, buildId: string): Promise<'claimed' | 'already' | 'missing'> {
    const b = this.builds.get(`${projectId}/${buildId}`);
    if (!b) return 'missing';
    if (b.processingStatus) return 'already';
    b.processingStatus = 'queued';
    return 'claimed';
  }
  async releaseDeltaCommit(projectId: string, buildId: string) {
    const b = this.builds.get(`${projectId}/${buildId}`);
    if (b) delete b.processingStatus;
  }
  async incrementCaptureCounter(projectId: string, counterId: string) {
    const id = `${projectId}/${counterId}`;
    const next = (this.counters.get(id) ?? 0) + 1;
    this.counters.set(id, next);
    return next;
  }
}

/** Key table: raw key -> what the key service answers. */
const KEYS: Record<string, { valid: boolean; apiKey?: Record<string, unknown> }> = {
  [DEVICE_KEY]: { valid: true, apiKey: { id: 'deviceKey1', name: 'Scry Sync', prefix: 'scry_proj_', kind: 'device', createdBy: 'uid-ada' } },
  [OTHER_DEVICE_KEY]: { valid: true, apiKey: { id: 'deviceKeyB', name: 'Scry Sync', prefix: 'scry_proj_', kind: 'device', createdBy: 'uid-eve' } },
  [OTHER_PROJECT_KEY]: { valid: true, apiKey: { id: 'plainKeyB', name: 'CI', prefix: 'scry_proj_', createdBy: 'uid-eve' } },
  [REVOKED_KEY]: { valid: false },
  [PLAIN_KEY]: { valid: true, apiKey: { id: 'plainKey1', name: 'CI', prefix: 'scry_proj_', createdBy: 'uid-ada' } },
  [CI_KEY]: { valid: true, apiKey: { id: 'ciKey1', name: 'CI', prefix: 'scry_proj_', kind: 'ci', createdBy: 'uid-ada' } },
};

/** `firestore` swaps in another implementation (for example the real REST client over a fake Firestore) for the routes only. */
export function setup(opts: { syncDelta?: boolean; firestore?: FirestoreService } = {}) {
  const bucket = new FakeR2();
  const storage = new R2S3StorageService(bucket as never, {
    accountId: 'acct123',
    accessKeyId: 'AKIATESTTESTTESTTEST',
    secretAccessKey: 'test-secret-access-key-not-real',
    bucketName: 'my-storybooks-test',
  });
  const firestore = new FakeFirestore();
  const queue = { send: vi.fn(async (_message: unknown) => undefined) };
  const apiKeyService = {
    validateApiKey: vi.fn(async (_project: string, key: string) => {
      const hit = KEYS[key];
      if (!hit) return { valid: false, error: 'Invalid API key' };
      return hit.valid ? { valid: true, apiKey: hit.apiKey } : { valid: false, error: 'API key has been revoked' };
    }),
    updateLastUsed: vi.fn(async () => undefined),
  } as unknown as ApiKeyService;
  const server = new Hono<AppEnv>();
  server.use('*', async (c, next) => {
    c.set('storage', storage);
    c.set('firestore', opts.firestore ?? (firestore as unknown as FirestoreService));
    c.set('apiKeyService', apiKeyService);
    c.set('processingQueue', queue as never);
    c.set('syncDelta', opts.syncDelta ?? true);
    await next();
  });
  server.route('/', app);
  return { server, bucket, storage, firestore, queue };
}

// ---- pictures and manifests ---------------------------------------------------------------------

/** A PNG-shaped file: real signature and IHDR (so dimensions parse), filler instead of pixel data. */
export function fakePng(seed: number, width = 64, height = 48, totalBytes = 400): Uint8Array {
  const out = new Uint8Array(totalBytes);
  let x = seed * 7919 + 13;
  for (let i = 0; i < totalBytes; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 0);
  const view = new DataView(out.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return out;
}

export interface Picture {
  path: string;
  bytes: Uint8Array;
  oid: string;
}

export function pictures(n: number, firstSeed = 1): Picture[] {
  return Array.from({ length: n }, (_, i) => {
    const bytes = fakePng(firstSeed + i);
    return { path: `images/pic-${firstSeed + i}.png`, bytes, oid: sha256(bytes) };
  });
}

export function scfFor(pics: ReadonlyArray<Picture>, source = { kind: 'x-scry-sync', platform: 'other' }) {
  return {
    scf: '1.0',
    source,
    createdAt: '2026-10-10T00:00:00Z',
    counts: { declared: pics.length, captured: pics.length, skipped: [] as unknown[] },
    captures: pics.map((p, i) => ({
      id: `pic-${i}`,
      image: p.path,
      kind: 'component',
      title: ['Folder'],
      name: `Picture ${i}`,
      capture: { method: 'manual', viewport: { width: 64, height: 48 }, scale: 1 },
    })),
  };
}

export function manifestBody(pics: ReadonlyArray<Picture>, overrides: Record<string, unknown> = {}) {
  return {
    protocol: 1,
    hash: 'sha256',
    version: 'sync-1760000000000',
    source: SOURCE,
    scf: scfFor(pics),
    images: Object.fromEntries(pics.map((p) => [p.path, { oid: p.oid, size: p.bytes.byteLength }])),
    ...overrides,
  };
}

type Server = Hono<AppEnv>;

export function postManifest(server: Server, project: string, key: string | undefined, body: unknown, headers: Record<string, string> = { 'Idempotency-Key': IDEMPOTENCY }) {
  return server.request(`/delta/${project}/manifest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'X-API-Key': key } : {}), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export function putBlob(server: Server, project: string, key: string | undefined, oid: string, bytes: Uint8Array, buildId?: string, headers: Record<string, string> = {}) {
  const query = buildId ? `?build=${buildId}` : '';
  return server.request(`/delta/${project}/blobs/${oid}${query}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.byteLength), ...(key ? { 'X-API-Key': key } : {}), ...headers },
    body: bytes as BodyInit,
  });
}

export function postCommit(server: Server, project: string, key: string | undefined, buildId: string) {
  return server.request(`/delta/${project}/builds/${buildId}/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'X-API-Key': key } : {}) },
    body: '{}',
  });
}

export interface ManifestAnswer {
  buildId: string;
  buildNumber: number;
  expiresAt: string;
  maxBlobBytes: number;
  objects: Array<{ oid: string; size: number; actions?: { upload: { href: string; header: Record<string, string>; expires_at: string } }; error?: { code: string; message: string } }>;
}

/** Open a build and send every missing picture, the way the client does (PUT to the href as given). */
export async function openAndUpload(server: Server, project: string, key: string, pics: ReadonlyArray<Picture>, idempotency = IDEMPOTENCY) {
  const res = await postManifest(server, project, key, manifestBody(pics), { 'Idempotency-Key': idempotency });
  const answer = (await res.json()) as ManifestAnswer;
  const byOid = new Map(pics.map((p) => [p.oid, p]));
  for (const o of answer.objects) {
    if (!o.actions) continue;
    const href = new URL(o.actions.upload.href);
    const put = await server.request(href.pathname + href.search, {
      method: 'PUT',
      headers: { ...o.actions.upload.header, 'Content-Length': String(byOid.get(o.oid)!.bytes.byteLength), 'X-API-Key': key },
      body: byOid.get(o.oid)!.bytes as BodyInit,
    });
    if (put.status !== 201 && put.status !== 200) throw new Error(`blob PUT answered ${put.status}`);
  }
  return { status: res.status, answer };
}
