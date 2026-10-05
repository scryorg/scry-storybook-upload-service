/**
 * log-standardization guarantee G1, UAT F47: client-controlled request values (path segments, query,
 * host, x-scry-client, ids in the path or body) never reach a log line or a Sentry tag/extra unless the
 * API key validated for the project. Same class as the CDN fix (F41).
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
import type { ApiKeyService } from './services/apikey/apikey.service.js';
import type { FirestoreService } from './services/firestore/firestore.service.js';
import type { StorageService } from './services/storage/storage.service.js';

const CP = 'CANARYPROJUATV1C';
const CF = 'CANARYFILEUATV1C';
const CQ = 'CANARYQUERYUATV1C';
const CH = 'canaryhost-uatv1c.example';
const CC = 'CANARYCLIENTUATV1C/1.0.0';
const CB = 'CANARYBUILDUATV1C';
const CR = 'CANARYRUNUATV1C';
const markers = [CP, CF, CQ, CH, 'CANARYCLIENTUATV1C', CB, CR];

const hdrs = {
  host: CH,
  'x-forwarded-host': CH,
  'x-scry-client': CC,
  'x-scry-run-id': CR,
  'x-scry-build-id': CB,
};

function setup(valid: boolean | 'throw', getBuild: unknown = null) {
  const storage = {
    upload: vi.fn(async (key: string) => ({ url: `https://r2.example/${key}`, key })),
    getPresignedUploadUrl: vi.fn(async (key: string) => ({ url: `https://signed.example/${key}?s=1`, key })),
    head: vi.fn(),
    delete: vi.fn(),
  } as unknown as StorageService;
  const build = { id: 'b1', projectId: 'realprojAAAAAAAAAAAA', versionId: 'v1', buildNumber: 1, zipUrl: 'z', status: 'active', createdAt: new Date(), createdBy: 't' };
  const firestore = {
    createBuild: vi.fn(async () => build),
    getBuild: vi.fn(async () => getBuild),
    getBuildByVersion: vi.fn(async () => build),
    updateBuild: vi.fn(async () => undefined),
    trackEvent: vi.fn(async () => undefined),
  } as unknown as FirestoreService;
  const apiKeyService = {
    validateApiKey: vi.fn(async () => {
      if (valid === 'throw') throw new Error(`backend said ${CP}`);
      return valid ? { valid: true, apiKey: { id: 'k1', name: 'ci', prefix: 'scry_proj_' } } : { valid: false, error: `no such ${CP}` };
    }),
    updateLastUsed: vi.fn(async () => undefined),
  } as unknown as ApiKeyService;
  const server = new Hono<AppEnv>();
  server.use('*', async (c, next) => {
    c.set('storage', storage);
    c.set('firestore', firestore);
    c.set('apiKeyService', apiKeyService);
    await next();
  });
  server.route('/', app);
  return server;
}

let lines: string[];
beforeEach(() => {
  vi.restoreAllMocks();
  captured.length = 0;
  lines = [];
  const grab = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  for (const m of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, m).mockImplementation(grab);
});

const requestLines = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.msg === 'request');
const post = (server: Hono<AppEnv>, path: string, headers: Record<string, string>, body: unknown = { contentType: 'application/zip' }) =>
  server.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...hdrs, ...headers }, body: JSON.stringify(body) });

function expectClean(): void {
  const all = lines.join('\n') + JSON.stringify(captured.map((x) => x.opts));
  for (const m of markers) expect(all, m).not.toContain(m);
  expect(requestLines().length).toBeGreaterThan(0);
  for (const l of requestLines()) {
    expect(l.project).toBeUndefined();
    expect(l.client).toBeUndefined();
    expect(l.build_id).toBeUndefined();
    expect(l.run_id).toBeUndefined();
  }
  for (const l of lines) {
    const j = JSON.parse(l) as Record<string, unknown>;
    expect(j.project).toBeUndefined();
    expect(j.build_id).toBeUndefined();
  }
}

describe('F47 unverified request values never reach a line', () => {
  it('unauthenticated presigned-url request (no key)', async () => {
    const res = await post(makeServer(true), `/presigned-url/${CP}/v1/${CF}.txt?q=${CQ}`, {});
    expect(res.status).toBe(401);
    expect(requestLines()[0].route).toBe('/presigned-url/:project/:version/:filename');
    expectClean();
  });

  it('malformed key format', async () => {
    const res = await post(makeServer(true), `/presigned-url/${CP}/v1/${CF}.txt?q=${CQ}`, { 'X-API-Key': `bogus_${CP}` });
    expect(res.status).toBe(401);
    expectClean();
  });

  it('unauthorized project: valid key for another project (403 mismatch)', async () => {
    const res = await post(makeServer(true), `/presigned-url/${CP}/v1/${CF}.txt?q=${CQ}`, { 'X-API-Key': 'scry_proj_otherproj_secret' });
    expect(res.status).toBe(403);
    expectClean();
  });

  it('nonexistent project: key names it but validation fails (401)', async () => {
    const res = await post(makeServer(false), `/upload/${CP}/v1/metadata?q=${CQ}`, { 'X-API-Key': `scry_proj_${CP}_secret` });
    expect(res.status).toBe(401);
    expectClean();
  });

  it('key validation backend failure (503)', async () => {
    const res = await post(makeServer('throw'), `/presigned-url/${CP}/v1/${CF}.txt`, { 'X-API-Key': `scry_proj_${CP}_secret` });
    expect(res.status).toBe(503);
    expectClean();
  });

  it('malformed / unmatched paths', async () => {
    const server = makeServer(true);
    for (const path of [`/presigned-url/${CP}`, `/${CP}/${CF}?q=${CQ}`, `/upload/${CP}/v1/x/y/z/${CF}`]) {
      const res = await post(server, path, {});
      expect([401, 404]).toContain(res.status);
    }
    expectClean();
  });

  it('cleanup route (cleanup token, no API key) never logs its path project', async () => {
    const res = await post(makeServer(true), `/cleanup/${CP}/v1?q=${CQ}`, { 'X-Cleanup-Token': 'wrong' }, {});
    expect(res.status).toBeGreaterThanOrEqual(400);
    expectClean();
  });

  it('authorized request with a body/path build id that does not exist logs no build_id', async () => {
    const server = makeServer(true, null);
    const res = await post(server, `/upload/realprojAAAAAAAAAAAA/v1/bundle/complete`, { 'X-API-Key': 'scry_proj_realprojAAAAAAAAAAAA_secret' }, { buildId: CB, zipKey: `realprojAAAAAAAAAAAA/v1/builds/${CB}/bundle.zip` });
    expect(res.status).toBe(404);
    const all = lines.join('\n');
    expect(all).not.toContain(CB);
    expect(requestLines()[0]).toMatchObject({ project: 'realprojAAAAAAAAAAAA' });
    expect(requestLines()[0].build_id).toBeUndefined();
  });

  it('ci-timings with a client path build id does not log it', async () => {
    const server = makeServer(true, null);
    const res = await post(server, `/upload/realprojAAAAAAAAAAAA/v1/builds/${CB}/ci-timings`, { 'X-API-Key': 'scry_proj_realprojAAAAAAAAAAAA_secret' }, { ciTimings: 'not-an-object' });
    expect(res.status).toBe(400);
    expect(lines.join('\n')).not.toContain(CB);
  });
});

describe('F47 a legitimate authorized upload still logs its real project id', () => {
  it('presigned-url logs project, build_id and a well-formed client', async () => {
    const res = await post(makeServer(true), `/presigned-url/realprojAAAAAAAAAAAA/v1/storybook.zip`, {
      'X-API-Key': 'scry_proj_realprojAAAAAAAAAAAA_secret',
      'x-scry-client': 'scry-deployer/1.2.3',
    });
    expect(res.status).toBe(200);
    const [line] = requestLines();
    expect(line).toMatchObject({ project: 'realprojAAAAAAAAAAAA', build_id: 'b1', client: 'scry-deployer/1.2.3', route: '/presigned-url/:project/:version/:filename' });
    const all = lines.join('\n');
    for (const m of [CH, CR, CB]) expect(all, m).not.toContain(m);
  });
});

function makeServer(valid: boolean | 'throw', getBuild: unknown = null) {
  return setup(valid, getBuild);
}
