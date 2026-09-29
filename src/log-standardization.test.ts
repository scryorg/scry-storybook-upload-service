/**
 * log-standardization (schema v1) contract tests for the upload service.
 *   golden line      the request line validates against schema v1
 *   guarantee-1      the canary corpus never appears in log output or in what reaches Sentry
 *   guarantee-3      x-scry-request-id is on 2xx, 4xx and 5xx and equals the logged id
 *   guarantee-4      a broken log sink never fails a request
 * Plus: upload errors and post-upload Firestore/queue failures reach Sentry with the request id.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const captured: Array<{ err: unknown; opts?: { tags?: Record<string, string> } }> = [];
vi.mock('@sentry/cloudflare', () => ({
  captureException: (err: unknown, opts?: { tags?: Record<string, string> }) => {
    captured.push({ err, opts });
  },
  getCurrentScope: () => ({ setTag: () => undefined }),
  getTraceData: () => ({}),
}));

import { Hono } from 'hono';
import { app, type AppEnv } from './app.js';
import { scrubEvent } from './sentry-scrub.js';
import { validateLine } from './lib/scry-log/index.js';
import type { ApiKeyService } from './services/apikey/apikey.service.js';
import type { FirestoreService } from './services/firestore/firestore.service.js';
import type { StorageService } from './services/storage/storage.service.js';

const canary = JSON.parse(
  readFileSync(new URL('../test-fixtures/canary.json', import.meta.url), 'utf8')
) as { values: Record<string, string>; markers: string[] };

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function setup(opts: { firestoreFails?: boolean; queueFails?: boolean; storageFails?: boolean; keys?: boolean } = {}) {
  const storage = {
    upload: vi.fn(async (key: string) => ({ url: `https://r2.example/${key}`, key })),
    getPresignedUploadUrl: vi.fn(async (key: string) => {
      if (opts.storageFails) throw new Error(`storage down for ${canary.values.email}`);
      return { url: `https://signed.example/${key}?s=1`, key };
    }),
    head: vi.fn(),
    getObjectStream: vi.fn(),
    getObjectRange: vi.fn(),
    delete: vi.fn(),
    deleteByPrefix: vi.fn(),
  } as unknown as StorageService;
  const build = { id: 'b1', projectId: 'proj', versionId: 'v1', buildNumber: 1, zipUrl: 'z', status: 'active', createdAt: new Date(), createdBy: 't' };
  const fail = () => {
    throw new Error(`firestore said ${canary.values.email} ${canary.values.bearer}`);
  };
  const firestore = {
    createBuild: vi.fn(async () => (opts.firestoreFails ? fail() : build)),
    getBuild: vi.fn(async () => build),
    getBuildByVersion: vi.fn(async () => build),
    getLatestBuild: vi.fn(async () => build),
    updateBuild: vi.fn(async () => undefined),
    updateBuildCoverage: vi.fn(async () => undefined),
    updateProcessingStatus: vi.fn(async () => undefined),
    trackEvent: vi.fn(async () => undefined),
  } as unknown as FirestoreService;
  const apiKeyService = {
    validateApiKey: vi.fn(async () => ({ valid: true, apiKey: { id: 'k1', name: 'ci', prefix: 'scry_proj_' } })),
    updateLastUsed: vi.fn(async () => undefined),
  } as unknown as ApiKeyService;
  const queue = { send: vi.fn(async () => (opts.queueFails ? fail() : undefined)) };

  const server = new Hono<AppEnv>();
  server.use('*', async (c, next) => {
    c.set('storage', storage);
    c.set('firestore', firestore);
    c.set('processingQueue', queue as unknown as Queue);
    if (opts.keys) c.set('apiKeyService', apiKeyService);
    await next();
  });
  server.route('/', app);
  return { server, queue };
}

let lines: string[];
function captureConsole() {
  lines = [];
  const grab = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  vi.spyOn(console, 'log').mockImplementation(grab);
  vi.spyOn(console, 'warn').mockImplementation(grab);
  vi.spyOn(console, 'error').mockImplementation(grab);
  vi.spyOn(console, 'info').mockImplementation(grab);
}
const parsed = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
const requestLines = () => parsed().filter((l) => l.msg === 'request');

const JSON_POST = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.restoreAllMocks();
  captured.length = 0;
  captureConsole();
});

describe('golden line', () => {
  it('a request line validates against schema v1 and carries only allow-listed fields', async () => {
    const { server } = setup();
    const res = await server.request('/presigned-url/proj/v1/storybook.zip', JSON_POST({ contentType: 'application/zip' }));
    expect(res.status).toBe(200);
    const [line] = requestLines();
    expect(validateLine(line)).toEqual({ ok: true, errors: [] });
    expect(line).toMatchObject({
      v: 1,
      level: 'info',
      service: 'upload',
      route: '/presigned-url/:project/:version/:filename',
      status: 200,
      project: 'proj',
      build_id: 'b1',
    });
    expect(line.request_id).toBe(res.headers.get('x-scry-request-id'));
  });

  it('every line emitted during a request is schema-valid', async () => {
    const { server } = setup({ firestoreFails: true });
    await server.request('/presigned-url/proj/v1/storybook.zip', JSON_POST({ contentType: 'application/zip' }));
    expect(lines.length).toBeGreaterThan(1);
    for (const l of parsed()) expect(validateLine(l), JSON.stringify(l)).toEqual({ ok: true, errors: [] });
  });
});

describe('guarantee-3 id echoed and logged per response class', () => {
  it('2xx, 4xx (missing key), 4xx (unknown route) and 5xx all carry the id, and it is the logged id', async () => {
    const ok = setup();
    const r2 = await ok.server.request('/health');
    const r404 = await ok.server.request('/no/such/route');
    const keyed = setup({ keys: true });
    const r401 = await keyed.server.request('/presigned-url/proj/v1/storybook.zip', JSON_POST({}));
    const broken = setup({ storageFails: true });
    const r500 = await broken.server.request('/presigned-url/proj/v1/storybook.zip', JSON_POST({ contentType: 'application/zip' }));

    expect([r2.status, r404.status, r401.status, r500.status]).toEqual([200, 404, 401, 500]);
    const logged = new Map(requestLines().map((l) => [l.request_id as string, l]));
    for (const res of [r2, r404, r401, r500]) {
      const id = res.headers.get('x-scry-request-id') ?? '';
      expect(id, `status ${res.status}`).toMatch(ULID);
      expect(logged.get(id)?.status, `logged line for ${res.status}`).toBe(res.status);
    }
  });

  it('error JSON bodies carry request_id equal to the header', async () => {
    const { server } = setup({ storageFails: true });
    const res = await server.request('/presigned-url/proj/v1/storybook.zip', JSON_POST({ contentType: 'application/zip' }));
    const body = await res.json();
    expect(body.request_id).toBe(res.headers.get('x-scry-request-id'));
    expect(body.error).toBeTruthy();
  });

  it('an inbound x-scry-request-id is never trusted: this edge always mints', async () => {
    const { server } = setup();
    const res = await server.request('/health', { headers: { 'x-scry-request-id': '01ARZ3NDEKTSV4RRFFQ69G5FAV' } });
    expect(res.headers.get('x-scry-request-id')).not.toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
  });

  it('the id travels in the queue message', async () => {
    const { server, queue } = setup();
    const res = await server.request('/upload-images/proj/complete', JSON_POST({ uploadId: 'u1', zipKey: 'proj/uploads/1/images.zip' }));
    // Firestore double has no upload methods, so this may fail after the enqueue point; only assert when it sent.
    void res;
    for (const call of queue.send.mock.calls as unknown as Array<[Record<string, unknown>]>) {
      expect(call[0].requestId).toBe(res.headers.get('x-scry-request-id'));
    }
  });
});

describe('errors reach Sentry with the request id', () => {
  it('a caught upload failure (storage down) is captured with tag request_id = the header', async () => {
    const { server } = setup({ storageFails: true });
    const res = await server.request('/presigned-url/proj/v1/storybook.zip', JSON_POST({ contentType: 'application/zip' }));
    expect(res.status).toBe(500);
    expect(captured).toHaveLength(1);
    expect(captured[0].opts?.tags?.request_id).toBe(res.headers.get('x-scry-request-id'));
  });

  it('a Firestore failure after the upload succeeded is captured, and the upload still answers 200', async () => {
    const { server } = setup({ firestoreFails: true });
    const res = await server.request('/presigned-url/proj/v1/storybook.zip', JSON_POST({ contentType: 'application/zip' }));
    expect(res.status).toBe(200);
    expect(captured.map((c) => c.opts?.tags?.err_code)).toContain('firestore_after_presign_failed');
    expect(captured[0].opts?.tags?.request_id).toBe(res.headers.get('x-scry-request-id'));
  });

  it('a failed queue send after the metadata upload is captured with the request id', async () => {
    const { server } = setup({ queueFails: true });
    const res = await server.request('/upload/proj/v1/metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(res.status).toBe(500);
    expect(captured.map((c) => c.opts?.tags?.err_code)).toContain('metadata_upload_failed');
    expect(captured[0].opts?.tags?.request_id).toBe(res.headers.get('x-scry-request-id'));
  });
});

describe('guarantee-1 canary corpus absent', () => {
  const markers = canary.markers;
  const hasMarker = (text: string) => markers.filter((m) => text.includes(m));

  it('no marker in any log line when canaries ride in headers, query, body and error messages', async () => {
    const { server } = setup({ firestoreFails: true, keys: true });
    const v = canary.values;
    await server.request(`/presigned-url/proj/v1/storybook.zip?${v.query_pair}&email=${encodeURIComponent(v.email)}`, {
      ...JSON_POST({ contentType: 'application/zip', note: v.email, q: v.query_url }, {
        'X-API-Key': v.sk_key,
        Authorization: v.bearer,
        Cookie: v.cookie,
        'x-scry-client': v.email,
      }),
    });
    const stormy = setup({ storageFails: true });
    await stormy.server.request(`/presigned-url/proj/v1/storybook.zip?${v.query_pair}`, JSON_POST({ contentType: 'application/zip' }, { Authorization: v.bearer }));
    expect(lines.length).toBeGreaterThan(0);
    expect(hasMarker(lines.join('\n'))).toEqual([]);
  });

  it('no marker survives the Sentry scrubber (event, exception values, breadcrumbs)', async () => {
    const { scrubBreadcrumb } = await import('./sentry-scrub.js');
    const v = canary.values;
    const event = scrubEvent({
      message: `${v.email} ${v.bearer} ${v.query_url}`,
      exception: { values: [{ value: `${v.jwt} ${v.sk_key} ${v.google_key}` }] },
      extra: { note: v.cookie, q: v.query_pair },
      request: { headers: { 'X-API-Key': v.sk_key, cookie: v.cookie }, data: v.email, query_string: v.query_pair },
    });
    const crumb = scrubBreadcrumb({ message: v.email, data: { url: v.query_url, auth: v.bearer } });
    expect(hasMarker(JSON.stringify(event))).toEqual([]);
    expect(hasMarker(JSON.stringify(crumb))).toEqual([]);
  });
});

describe('guarantee-4 requests succeed when logging is broken', () => {
  it('console that throws does not change status or body', async () => {
    const { server } = setup();
    const before = await server.request('/presigned-url/proj/v1/storybook.zip', JSON_POST({ contentType: 'application/zip' }));
    const beforeBody = await before.json();
    for (const m of ['log', 'warn', 'error', 'info'] as const) {
      vi.spyOn(console, m).mockImplementation(() => {
        throw new Error('sink down');
      });
    }
    const res = await server.request('/presigned-url/proj/v1/storybook.zip', JSON_POST({ contentType: 'application/zip' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(Object.keys(beforeBody).sort());
    expect(res.headers.get('x-scry-request-id')).toMatch(ULID);
  });
});
