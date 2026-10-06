// Shared fixtures for the capture route tests (feature snip-capture). Not a test file itself.
// The storage is the real R2S3StorageService (real S3 presigner, no network) over an in-memory R2
// bucket, so the presigned URLs under test are the ones the SCF routes would hand out.
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { vi } from 'vitest';
import { app, type AppEnv } from '../app.js';
import { R2S3StorageService } from '../services/storage/storage.worker.js';
import type { ApiKeyService } from '../services/apikey/apikey.service.js';
import type { FirestoreService } from '../services/firestore/firestore.service.js';
import type { Capture, CreateCaptureData } from '../services/firestore/firestore.types.js';

export const PROJECT = 'projAAAAAAAAAAAAAAAA';
export const OTHER_PROJECT = 'projBBBBBBBBBBBBBBBB';
export const DEVICE_KEY = `scry_proj_${PROJECT}_devicesecret`;
export const REVOKED_KEY = `scry_proj_${PROJECT}_revokedsecret`;
export const OTHER_PROJECT_KEY = `scry_proj_${OTHER_PROJECT}_devicesecret`;
export const PLAIN_KEY = `scry_proj_${PROJECT}_plainsecret`;
export const CI_KEY = `scry_proj_${PROJECT}_cisecret`;
export const SECOND_DEVICE_KEY = `scry_proj_${PROJECT}_seconddevice`;

export const CAPTURE_ID = '0192f3a4-7b5c-7d2e-8f10-3a4b5c6d7e8f';
export const CAPTURE_ID_2 = '0192f3a4-7b5c-7d2e-8f10-3a4b5c6d7e90';

export class FakeR2 {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  async put(key: string, body: Uint8Array, contentType?: string) {
    this.objects.set(key, { bytes: body, contentType });
  }
  async head(key: string) {
    const o = this.objects.get(key);
    return o ? { size: o.bytes.byteLength, httpMetadata: { contentType: o.contentType } } : null;
  }
  async get(key: string, opts?: { range?: { offset: number; length: number } }) {
    const o = this.objects.get(key);
    if (!o) return null;
    const bytes = opts?.range ? o.bytes.slice(opts.range.offset, opts.range.offset + opts.range.length) : o.bytes;
    return {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          // two chunks, to exercise the streaming hash
          const mid = Math.floor(bytes.byteLength / 2);
          controller.enqueue(bytes.slice(0, mid));
          controller.enqueue(bytes.slice(mid));
          controller.close();
        },
      }),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  }
  async delete(key: string | string[]) {
    for (const k of Array.isArray(key) ? key : [key]) this.objects.delete(k);
  }
  async list() {
    return { objects: [...this.objects.keys()].map((key) => ({ key })), truncated: false };
  }
}

export class FakeFirestore {
  readonly captures = new Map<string, Capture>();
  readonly counters = new Map<string, number>();
  readonly writes: string[] = [];
  createBuild = vi.fn();
  updateBuild = vi.fn();
  getBuild = vi.fn();
  getLatestBuild = vi.fn();
  createUpload = vi.fn();
  trackEvent = vi.fn(async () => undefined);

  async createCaptureIfAbsent(projectId: string, data: CreateCaptureData) {
    const path = `${projectId}/${data.captureId}`;
    const existing = this.captures.get(path);
    if (existing) return { capture: { ...existing }, created: false };
    const { expiresAt, note, ...rest } = data;
    const capture: Capture = {
      ...rest,
      ...(note ? { note } : {}),
      status: 'pending',
      sharedWith: [],
      sharedWithOrgIds: [],
      sharedWithProject: false,
      createdAt: new Date(),
      expiresAt,
    };
    this.captures.set(path, capture);
    this.writes.push(`projects/${projectId}/captures/${data.captureId}`);
    return { capture: { ...capture }, created: true };
  }
  async getCapture(projectId: string, captureId: string) {
    const c = this.captures.get(`${projectId}/${captureId}`);
    return c ? { ...c } : null;
  }
  async markCaptureReady(projectId: string, captureId: string) {
    const c = this.captures.get(`${projectId}/${captureId}`)!;
    c.status = 'ready';
    c.receivedAt = new Date();
    this.writes.push(`projects/${projectId}/captures/${captureId}`);
    return { ...c };
  }
  async incrementCaptureCounter(projectId: string, counterId: string) {
    const id = `${projectId}/${counterId}`;
    const next = (this.counters.get(id) ?? 0) + 1;
    this.counters.set(id, next);
    this.writes.push(`projects/${projectId}/captureLimits/${counterId}`);
    return next;
  }
}

/** Key table: raw key -> what the key service answers. */
const KEYS: Record<string, { valid: boolean; apiKey?: Record<string, unknown> }> = {
  [DEVICE_KEY]: { valid: true, apiKey: { id: 'deviceKey1', name: 'Scry Sync', prefix: 'scry_proj_', kind: 'device', createdBy: 'uid-ada' } },
  [SECOND_DEVICE_KEY]: { valid: true, apiKey: { id: 'deviceKey2', name: 'Scry Sync', prefix: 'scry_proj_', kind: 'device', createdBy: 'uid-bob' } },
  [OTHER_PROJECT_KEY]: { valid: true, apiKey: { id: 'deviceKeyB', name: 'Scry Sync', prefix: 'scry_proj_', kind: 'device', createdBy: 'uid-eve' } },
  [REVOKED_KEY]: { valid: false },
  [PLAIN_KEY]: { valid: true, apiKey: { id: 'plainKey1', name: 'CI', prefix: 'scry_proj_', createdBy: 'uid-ada' } },
  [CI_KEY]: { valid: true, apiKey: { id: 'ciKey1', name: 'CI', prefix: 'scry_proj_', kind: 'ci', createdBy: 'uid-ada' } },
};

export function setup() {
  const bucket = new FakeR2();
  const storage = new R2S3StorageService(bucket as never, {
    accountId: 'acct123',
    accessKeyId: 'AKIATESTTESTTESTTEST',
    secretAccessKey: 'test-secret-access-key-not-real',
    bucketName: 'my-storybooks-test',
  });
  const firestore = new FakeFirestore();
  const queue = { send: vi.fn(async () => undefined) };
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
    c.set('firestore', firestore as unknown as FirestoreService);
    c.set('apiKeyService', apiKeyService);
    c.set('processingQueue', queue as never);
    await next();
  });
  server.route('/', app);
  return { server, bucket, storage, firestore, queue, apiKeyService };
}

// ---- image bytes -------------------------------------------------------------------------------

function filler(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
}

/** A PNG-shaped file: real signature and IHDR (so dimensions parse), filler instead of pixel data. */
export function fakePng(width: number, height: number, totalBytes = 600): Uint8Array {
  const out = new Uint8Array(totalBytes);
  out.set(filler(totalBytes, width * 31 + height), 0);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 0);
  const view = new DataView(out.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return out;
}
export function fakeJpeg(totalBytes = 300): Uint8Array {
  const out = filler(totalBytes, 7);
  out.set([0xff, 0xd8, 0xff, 0xe0], 0);
  return out;
}
export function fakeWebp(totalBytes = 200): Uint8Array {
  const out = filler(totalBytes, 9);
  out.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], 0);
  return out;
}
export const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

export function presignBody(png: Uint8Array, overrides: Record<string, unknown> = {}, width = 1200, height = 800) {
  return {
    captureId: CAPTURE_ID,
    width,
    height,
    bytes: png.byteLength,
    sha256: sha256(png),
    scale: 2,
    os: 'mac',
    mode: 'region',
    sendMode: 'review',
    ...overrides,
  };
}

export function post(server: Hono<AppEnv>, path: string, key: string | undefined, body: unknown, extraHeaders: Record<string, string> = {}) {
  return server.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'X-API-Key': key } : {}), ...extraHeaders },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** The R2 key a presigned PUT URL points at (what the client's PUT would write). */
export function keyOfPresignedUrl(url: string, project = PROJECT): string {
  const path = decodeURIComponent(new URL(url).pathname);
  return path.slice(path.indexOf(`${project}/`));
}
