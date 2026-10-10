/**
 * log-core-hardening G7 (S6 coverage), upload half.
 *   guarantee-7a  an error event, a transaction and a span keep only the SAFE_HEADERS allow-list of
 *                 request headers; X-Scry-Caller, X-Api-Key, Cookie and any custom header never leave
 *                 the Worker (flutter-capture F44: error events used a deny-list).
 *   guarantee-7b  a failure swallowed on a data-writing path is reported to Sentry through
 *                 reportError with the request id, and the customer response does not change (G8).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const captured: Array<{ err: unknown; opts?: { tags?: Record<string, string>; extra?: Record<string, unknown> } }> = [];
vi.mock('@sentry/cloudflare', () => ({
  captureException: (err: unknown, opts?: { tags?: Record<string, string>; extra?: Record<string, unknown> }) => {
    captured.push({ err, opts });
  },
  getCurrentScope: () => ({ setTag: () => undefined }),
  getTraceData: () => ({}),
}));

import { Hono } from 'hono';
import { app, type AppEnv } from './app.js';
import { scrubEvent, scrubSpan, scrubTransaction } from './sentry-scrub.js';
import { buildZip } from './bundle/__tests__/test-helpers.js';
import { MockStorageService } from './services/storage/storage.mock.js';
import type { ApiKeyService } from './services/apikey/apikey.service.js';
import type { FirestoreService } from './services/firestore/firestore.service.js';
import type { Build } from './services/firestore/firestore.types.js';

const SECRETS = ['SECRETCALLER', 'SECRETAPIKEY', 'SECRETCOOKIE', 'SECRETCUSTOM', 'SECRETFORWARD'];

function requestHeaders(): Record<string, string> {
  return {
    'X-Scry-Caller': 'SECRETCALLER',
    'X-Api-Key': 'SECRETAPIKEY',
    Cookie: 'session=SECRETCOOKIE',
    'X-Foo': 'SECRETCUSTOM',
    'X-Forwarded-For': 'SECRETFORWARD',
    'Content-Type': 'application/json',
    'User-Agent': 'scry-cli/1.0',
    Host: 'upload.example',
    Accept: 'application/json',
    'Content-Length': '12',
  };
}

const SAFE = ['content-type', 'content-length', 'accept', 'user-agent', 'host'];

describe('guarantee-7a: only SAFE_HEADERS survive on error events, transactions and spans', () => {
  it('an error event keeps none of X-Scry-Caller, X-Api-Key, Cookie, a custom header', () => {
    const event = scrubEvent({ request: { url: 'https://upload.example/x', headers: requestHeaders() } });
    expect(Object.keys(event.request.headers).map((h) => h.toLowerCase()).sort()).toEqual([...SAFE].sort());
    expect(JSON.stringify(event)).not.toMatch(new RegExp(SECRETS.join('|')));
  });

  it('header names match case-insensitively, whatever the casing', () => {
    const event = scrubEvent({ request: { headers: { 'x-scry-caller': 'SECRETCALLER', 'X-FOO': 'SECRETCUSTOM', 'CONTENT-TYPE': 'text/plain' } } });
    expect(event.request.headers).toEqual({ 'CONTENT-TYPE': 'text/plain' });
  });

  it('an error event with no request block, or no headers, still scrubs without throwing', () => {
    expect(scrubEvent({ message: 'boom' }).message).toBe('boom');
    expect(scrubEvent({ request: {} }).request).toEqual({});
  });

  it('a transaction keeps only SAFE_HEADERS', () => {
    const event = scrubTransaction({ request: { headers: requestHeaders() }, transaction: 'POST /upload' });
    expect(Object.keys(event.request.headers).map((h) => h.toLowerCase()).sort()).toEqual([...SAFE].sort());
    expect(JSON.stringify(event)).not.toMatch(new RegExp(SECRETS.join('|')));
  });

  it('a span drops request-header attributes that are not SAFE_HEADERS', () => {
    const span = scrubSpan({
      data: {
        'http.request.header.x-scry-caller': 'SECRETCALLER',
        'http.request.header.x-foo': 'SECRETCUSTOM',
        'http.request.header.content-type': 'application/json',
      },
    } as never) as { data: Record<string, unknown> };
    expect(Object.keys(span.data)).toEqual(['http.request.header.content-type']);
  });
});

const build: Build = { id: 'b1', projectId: 'projAAAAAAAAAAAAAAAA', versionId: 'v1', buildNumber: 1, zipUrl: 'z', status: 'active', createdAt: new Date(), createdBy: 't' };
const PROJECT = 'projAAAAAAAAAAAAAAAA';

function setup(opts: { updateBuildFails?: boolean; queueFails?: boolean; touchFails?: boolean; keys?: boolean; storage?: MockStorageService; getBuild?: Build } = {}) {
  const storage = opts.storage ?? new MockStorageService({ baseUrl: 'https://storage.test' });
  const firestore = {
    createBuild: vi.fn(async () => build),
    getBuild: vi.fn(async () => opts.getBuild ?? build),
    getBuildByVersion: vi.fn(async () => build),
    getLatestBuild: vi.fn(async () => build),
    updateBuild: vi.fn(async () => {
      if (opts.updateBuildFails) throw new Error('firestore write refused');
    }),
    updateBuildCoverage: vi.fn(async () => undefined),
    updateProcessingStatus: vi.fn(async () => undefined),
    trackEvent: vi.fn(async () => undefined),
  } as unknown as FirestoreService;
  const apiKeyService = {
    validateApiKey: vi.fn(async () => ({ valid: true, apiKey: { id: 'k1', name: 'ci', prefix: 'scry_proj_' } })),
    updateLastUsed: vi.fn(async () => {
      if (opts.touchFails) throw new Error('touch refused');
    }),
  } as unknown as ApiKeyService;
  const queue = {
    send: vi.fn(async () => {
      if (opts.queueFails) throw new Error('queue down');
    }),
  };
  const server = new Hono<AppEnv>();
  server.use('*', async (c, next) => {
    c.set('storage', storage);
    c.set('firestore', firestore);
    c.set('processingQueue', queue as unknown as Queue);
    if (opts.keys) c.set('apiKeyService', apiKeyService);
    await next();
  });
  server.route('/', app);
  return { server, storage, firestore, queue, apiKeyService };
}

const codes = () => captured.map((c) => c.opts?.tags?.err_code);

beforeEach(() => {
  vi.restoreAllMocks();
  captured.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('guarantee-7b: swallowed write-path failures are reported with the request id', () => {
  const ZIP_KEY = 'acme/main/builds/1/bundle.zip';

  it('a rejected bundle whose cleanup (object delete, mark failed) fails is reported twice, and still answers 422', async () => {
    const zip = buildZip([
      { name: 'scf.json', data: Buffer.from('{"scf":"1.0","source":{"kind":"storybook"},"captures":[]}') },
      { name: '../../etc/passwd', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    ]);
    const storage = new MockStorageService();
    storage.seed(ZIP_KEY, zip);
    vi.spyOn(storage, 'delete').mockRejectedValue(new Error('r2 delete refused'));
    const { server } = setup({ storage, updateBuildFails: true, getBuild: { ...build, projectId: 'acme', versionId: 'main' } });

    const res = await server.request('/upload/acme/main/bundle/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ buildId: 'b1', zipKey: ZIP_KEY }),
    });

    expect(res.status).toBe(422);
    expect(codes()).toEqual(expect.arrayContaining(['bundle_delete_failed', 'bundle_mark_failed']));
    for (const c of captured) expect(c.opts?.tags?.request_id).toBe(res.headers.get('x-scry-request-id'));
  });

  it('a queue failure whose step-summary write also fails is reported (enqueue_step_summary_failed), and still answers 500 as before', async () => {
    const { server } = setup({ queueFails: true, updateBuildFails: true });
    const res = await server.request(`/upload/${PROJECT}/v1/metadata`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(res.status).toBe(500);
    expect(codes()).toContain('enqueue_step_summary_failed');
    expect(codes()).toContain('metadata_upload_failed');
    for (const c of captured) expect(c.opts?.tags?.request_id).toBe(res.headers.get('x-scry-request-id'));
  });

  it('a provenance write whose failure marker also fails is reported (provenance_marker_failed)', async () => {
    const { server } = setup({ updateBuildFails: true });
    const res = await server.request(`/upload/${PROJECT}/v1/metadata?commitSha=abc1234&branch=main`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(codes()).toContain('provenance_write_failed');
    expect(codes()).toContain('provenance_marker_failed');
    for (const c of captured) expect(c.opts?.tags?.request_id).toBe(res.headers.get('x-scry-request-id'));
    expect(res.status).toBe(201);
  });

  it('a failed key last-used touch is reported (apikey_touch_failed), and the request still succeeds', async () => {
    const { server } = setup({ keys: true, touchFails: true });
    const res = await server.request(`/presigned-url/${PROJECT}/v1/storybook.zip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': `scry_proj_${PROJECT}_secret` },
      body: JSON.stringify({ contentType: 'application/zip' }),
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(codes()).toContain('apikey_touch_failed');
    expect(captured.find((c) => c.opts?.tags?.err_code === 'apikey_touch_failed')?.opts?.tags?.request_id).toBe(res.headers.get('x-scry-request-id'));
  });
});
