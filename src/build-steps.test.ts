/**
 * staff-builds-view: the `build.step` events the upload service emits.
 *
 * guarantee-3-no-pii-in-events: an event carries ids, a fixed step and outcome, counters and a
 * closed reason code. Never an email, never an exception message, never story or design text.
 * guarantee-4 (logging failure isolated): a logger that throws, or a console that throws, never
 * fails the upload.
 * Also: step order for a happy build, the failure path, and that the step summary rides the
 * existing status write.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { app, type AppEnv } from './app.js';
import { BUILD_STEPS, BUILD_STEP_OUTCOMES, BUILD_STEP_REASONS, classifyReason, emitBuildStep, isReasonCode } from './lib/build-steps.js';
import { isFixedText, validateLine } from './lib/scry-log/index.js';
import { log } from './lib/log.js';
import type { ApiKeyService } from './services/apikey/apikey.service.js';
import type { FirestoreService } from './services/firestore/firestore.service.js';
import type { Build } from './services/firestore/firestore.types.js';
import { MockStorageService } from './services/storage/storage.mock.js';
import { zipDirectory } from './bundle/__tests__/test-helpers.js';

const PROJECT = 'projAAAAAAAAAAAAAAAA';
const KEY = `scry_proj_${PROJECT}_secret`;
const EMAIL = 'jane.doe@example.com';
const canary = JSON.parse(readFileSync(new URL('../test-fixtures/canary.json', import.meta.url), 'utf8')) as {
  values: Record<string, string>;
  markers: string[];
};
const FIXTURES_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bundle/__fixtures__');
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const build: Build = {
  id: 'build-100',
  projectId: PROJECT,
  versionId: 'main',
  buildNumber: 5,
  zipUrl: '',
  status: 'active',
  createdAt: new Date(),
  createdBy: 'test',
};

type Queue = { send: (payload: unknown) => Promise<void> };

function setup(opts: { queue?: Queue; storage?: MockStorageService; firestore?: Partial<FirestoreService> } = {}) {
  const storage = opts.storage ?? new MockStorageService({ baseUrl: 'https://storage.test' });
  const firestore: FirestoreService = {
    createBuild: vi.fn(async () => build),
    getBuild: vi.fn(async () => build),
    getProjectBuilds: vi.fn(async () => []),
    getBuildByVersion: vi.fn(async () => null),
    getLatestBuild: vi.fn(async () => build),
    updateBuild: vi.fn(async () => undefined),
    updateBuildCoverage: vi.fn(async () => undefined),
    updateProcessingStatus: vi.fn(async () => undefined),
    archiveBuild: vi.fn(async () => undefined),
    deleteBuild: vi.fn(async () => undefined),
    trackEvent: vi.fn(async () => undefined),
    ...opts.firestore,
  };
  const apiKeyService = {
    validateApiKey: vi.fn(async () => ({ valid: true, apiKey: { id: 'k1', name: 'ci', prefix: 'scry_proj_' } })),
    updateLastUsed: vi.fn(async () => undefined),
  } as unknown as ApiKeyService;
  const queue: Queue = opts.queue ?? { send: vi.fn(async () => undefined) };
  const server = new Hono<AppEnv>();
  server.use('*', async (c, next) => {
    c.set('storage', storage);
    c.set('firestore', firestore);
    c.set('apiKeyService', apiKeyService);
    c.set('processingQueue', queue as unknown as globalThis.Queue);
    await next();
  });
  server.route('/', app);
  return { server, storage, firestore, queue };
}

let lines: string[];
beforeEach(() => {
  vi.restoreAllMocks();
  lines = [];
  const grab = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  for (const m of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, m).mockImplementation(grab);
});
afterEach(() => vi.restoreAllMocks());

const parsed = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
const steps = () => parsed().filter((l) => l.msg === 'build.step');
const post = (server: Hono<AppEnv>, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  server.request(p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('build.step: step order for a happy build (upload service)', () => {
  it('storybook flow emits presign, upload_received, enqueue, in that order, each with ids and no timing guesses', async () => {
    const { server, firestore } = setup();
    expect((await post(server, `/presigned-url/${PROJECT}/main/storybook.zip`, { contentType: 'application/zip' })).status).toBe(200);
    const meta = await server.request(`/upload/${PROJECT}/main/metadata`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip', 'X-API-Key': KEY },
      body: new Uint8Array([80, 75, 3, 4]),
    });
    expect(meta.status).toBe(201);

    const got = steps();
    expect(got.map((l) => l.step)).toEqual(['presign', 'upload_received', 'enqueue']);
    for (const l of got) {
      expect(l).toMatchObject({ v: 1, service: 'upload', outcome: 'ok', build_id: 'build-100', project: PROJECT });
      expect(l.request_id).toMatch(ULID);
      expect(validateLine(l)).toEqual({ ok: true, errors: [] });
    }
    // the presign line and the creation write carry the same request id
    const createArgs = vi.mocked(firestore.createBuild).mock.calls[0][1];
    expect(createArgs).toMatchObject({ firstStep: 'presign', requestId: got[0].request_id });
    // the summary rides the existing status write: no extra Firestore write for it
    expect(firestore.updateProcessingStatus).toHaveBeenCalledTimes(1);
    expect(firestore.updateProcessingStatus).toHaveBeenCalledWith(PROJECT, 'build-100', 'queued', expect.objectContaining({ lastStep: 'enqueue', outcome: 'ok' }));
    expect(firestore.updateBuild).not.toHaveBeenCalled();
  });

  it('bundle flow emits presign, complete, enqueue', async () => {
    const storage = new MockStorageService({ baseUrl: 'https://storage.test' });
    storage.seed(`${PROJECT}/main/builds/5/bundle.zip`, await zipDirectory(path.join(FIXTURES_ROOT, 'valid-basic')));
    const { server, firestore } = setup({ storage });
    expect((await post(server, `/presigned-url/${PROJECT}/main/bundle.zip?source=storybook-rn:ios`)).status).toBe(200);
    const res = await post(server, `/upload/${PROJECT}/main/bundle/complete`, { buildId: 'build-100', zipKey: `${PROJECT}/main/builds/5/bundle.zip` });
    expect(res.status).toBe(200);
    expect(steps().map((l) => [l.step, l.outcome])).toEqual([
      ['presign', 'ok'],
      ['complete', 'ok'],
      ['enqueue', 'ok'],
    ]);
    expect(firestore.updateProcessingStatus).toHaveBeenCalledWith(PROJECT, 'build-100', 'queued', expect.objectContaining({ lastStep: 'enqueue' }));
  });
});

describe('build.step: failure paths', () => {
  it('a rejected bundle emits complete/fail with the issue code and moves the summary in the same failed write', async () => {
    const storage = new MockStorageService({ baseUrl: 'https://storage.test' });
    storage.seed(`${PROJECT}/main/builds/5/bundle.zip`, await zipDirectory(path.join(FIXTURES_ROOT, 'invalid-duplicate-ids', 'bundle')));
    const { server, firestore, queue } = setup({ storage });
    const res = await post(server, `/upload/${PROJECT}/main/bundle/complete`, { buildId: 'build-100', zipKey: `${PROJECT}/main/builds/5/bundle.zip` });
    expect(res.status).toBe(422);
    const [fail] = steps();
    expect(fail).toMatchObject({ level: 'warn', step: 'complete', outcome: 'fail', build_id: 'build-100' });
    expect(fail.reason).toBe('validation');
    expect(queue.send).not.toHaveBeenCalled();
    expect(firestore.updateBuild).toHaveBeenCalledTimes(1);
    expect(firestore.updateBuild).toHaveBeenCalledWith(
      PROJECT,
      'build-100',
      expect.objectContaining({ processingStatus: 'failed', stepSummary: expect.objectContaining({ lastStep: 'complete', outcome: 'fail' }) })
    );
  });

  it('a failed queue send emits enqueue/fail with a fixed reason, never the error text, and still answers 500', async () => {
    const queue: Queue = {
      send: vi.fn(async () => {
        throw new Error(`queue said no for ${EMAIL}`);
      }),
    };
    const { server, firestore } = setup({ queue });
    const res = await server.request(`/upload/${PROJECT}/main/metadata`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip', 'X-API-Key': KEY },
      body: new Uint8Array([80, 75, 3, 4]),
    });
    expect(res.status).toBe(500);
    expect(steps().map((l) => [l.step, l.outcome])).toEqual([
      ['upload_received', 'ok'],
      ['enqueue', 'fail'],
    ]);
    expect(steps()[1].reason).toBe('queue_send_failed');
    expect(firestore.updateBuild).toHaveBeenCalledWith(PROJECT, 'build-100', { stepSummary: expect.objectContaining({ lastStep: 'enqueue', outcome: 'fail' }) });
  });
});

describe('guarantee-3-no-pii-in-events', () => {
  it('the reason list is closed: every code is valid fixed text and the README lists them all', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    for (const code of BUILD_STEP_REASONS) {
      expect(code).toMatch(/^[a-z][a-z0-9_.]{0,47}$/);
      expect(isFixedText('err_code', code), code).toBe(true);
      expect(readme).toContain(`\`${code}\``);
    }
    expect(new Set(BUILD_STEP_REASONS).size).toBe(BUILD_STEP_REASONS.length);
    expect(isReasonCode('queue send failed')).toBe(false);
  });

  it('a reason outside the closed set is emitted as unknown, never as text (emails, story title, design text, even through a cast)', () => {
    for (const text of [EMAIL, canary.values.story_title, canary.values.design_text, Object.values(canary.values).join(' ')]) {
      emitBuildStep(undefined, { step: 'enqueue', outcome: 'fail', buildId: 'build-100', reason: text as never });
    }
    emitBuildStep(undefined, { step: 'enqueue', outcome: 'fail', buildId: 'build-100', reason: 'queue_send_failed' });
    expect(steps().map((l) => l.reason)).toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'queue_send_failed']);
    const text = lines.join('\n');
    expect(text).not.toContain(EMAIL);
    for (const marker of canary.markers) expect(text).not.toContain(marker);
    for (const value of Object.values(canary.values)) expect(text).not.toContain(value);
  });

  it('story and design text in the thrown error of a failed queue send never reaches the line', async () => {
    const queue: Queue = {
      send: vi.fn(async () => {
        throw new Error(`${canary.values.story_title} ${canary.values.design_text} ${EMAIL}`);
      }),
    };
    const { server } = setup({ queue });
    await server.request(`/upload/${PROJECT}/main/metadata`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip', 'X-API-Key': KEY },
      body: new Uint8Array([80, 75, 3, 4]),
    });
    expect(steps().length).toBeGreaterThan(0);
    const text = lines.join('\n');
    for (const marker of canary.markers) expect(text).not.toContain(marker);
    expect(text).not.toContain(EMAIL);
    for (const l of steps()) if (l.reason !== undefined) expect(isReasonCode(l.reason)).toBe(true);
  });

  it('classifyReason returns only codes, whatever it is given', () => {
    expect(classifyReason(Object.assign(new Error('x'), { status: 429 }))).toBe('http_429');
    expect(classifyReason(new Error('Milvus HTTP error 500'))).toBe('http_5xx');
    expect(classifyReason('The operation timed out')).toBe('ai_timeout');
    for (const input of [canary.values.story_title, new Error(canary.values.design_text), undefined, 7]) {
      expect(isReasonCode(classifyReason(input))).toBe(true);
    }
  });

  it('F80: content_policy is a member of the closed list, survives emitBuildStep, and is named before the generic 4xx', () => {
    expect(BUILD_STEP_REASONS).toContain('content_policy');
    expect(isReasonCode('content_policy')).toBe(true);
    emitBuildStep(undefined, { step: 'enqueue', outcome: 'fail', buildId: 'build-100', reason: 'content_policy' });
    expect(steps().map((l) => l.reason)).toEqual(['content_policy']);
    expect(classifyReason('content_policy')).toBe('content_policy');
    expect(classifyReason(Object.assign(new Error('OpenAI API error 403: content_policy (the provider rejected the input)'), { status: 403 }))).toBe('content_policy');
    expect(classifyReason(Object.assign(new Error('Forbidden'), { status: 403 }))).toBe('http_4xx');
  });

  it('F88: inspect_refusal_storm is in the closed list, survives emitBuildStep, and wins over content_policy in the classifier', () => {
    expect(BUILD_STEP_REASONS).toContain('inspect_refusal_storm');
    expect(BUILD_STEP_REASONS).toHaveLength(23);
    expect(isReasonCode('inspect_refusal_storm')).toBe(true);
    emitBuildStep(undefined, { step: 'enqueue', outcome: 'fail', buildId: 'build-100', reason: 'inspect_refusal_storm' });
    expect(steps().map((l) => l.reason)).toEqual(['inspect_refusal_storm']);
    expect(classifyReason('inspect_refusal_storm')).toBe('inspect_refusal_storm');
    expect(classifyReason('RefusalStormError: inspect_refusal_storm: 12 of 30 stories refused by the provider')).toBe('inspect_refusal_storm');
    expect(classifyReason('OpenAI API error 403: content_policy (the provider rejected the input)')).toBe('content_policy');
  });

  it('an email in a header or in the error text never reaches a build.step line', async () => {
    const queue: Queue = {
      send: vi.fn(async () => {
        throw new Error(`rejected ${EMAIL}`);
      }),
    };
    const { server } = setup({ queue });
    await server.request(`/upload/${PROJECT}/main/metadata`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip', 'X-API-Key': KEY, 'x-scry-client': EMAIL, 'x-forwarded-for': EMAIL },
      body: new Uint8Array([80, 75, 3, 4]),
    });
    expect(steps().length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(EMAIL);
    expect(lines.join('\n')).not.toContain('jane.doe');
  });

  it('an unauthorized request carries no project or build_id on a build.step line', () => {
    emitBuildStep(undefined, { step: 'presign', outcome: 'ok', buildId: 'build-100' });
    const [l] = steps();
    expect(l).toMatchObject({ step: 'presign', outcome: 'ok' });
    expect(l.build_id).toBeUndefined();
    expect(l.project).toBeUndefined();
  });

  it('every step and outcome in the enum is valid fixed text, so none is ever replaced by [invalid]', () => {
    for (const v of [...BUILD_STEPS, ...BUILD_STEP_OUTCOMES]) expect(isFixedText('err_code', v), v).toBe(true);
    expect(isFixedText('msg', 'build.step')).toBe(true);
  });
});

describe('guarantee-4-logging-failure-isolated', () => {
  it('emitBuildStep never throws when the logger throws', () => {
    vi.spyOn(log, 'info').mockImplementation(() => {
      throw new Error('logger down');
    });
    vi.spyOn(log, 'warn').mockImplementation(() => {
      throw new Error('logger down');
    });
    expect(() => emitBuildStep(undefined, { step: 'enqueue', outcome: 'ok' })).not.toThrow();
    expect(() => emitBuildStep(undefined, { step: 'enqueue', outcome: 'fail', reason: 'x' })).not.toThrow();
  });

  it('an upload still succeeds, and the summary is still written, when the console sink throws on every build.step line', async () => {
    // (Only build.step lines fail: other lines, such as the auth middleware's own console output, are not this feature's.)
    const grab = (...args: unknown[]) => {
      const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      if (text.includes('"msg":"build.step"')) throw new Error('console down');
      lines.push(text);
    };
    for (const m of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, m).mockImplementation(grab);
    const { server, firestore } = setup();
    const res = await server.request(`/upload/${PROJECT}/main/metadata`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip', 'X-API-Key': KEY },
      body: new Uint8Array([80, 75, 3, 4]),
    });
    expect(res.status).toBe(201);
    expect(steps()).toEqual([]); // every build.step line was lost, the upload was not
    expect(firestore.updateProcessingStatus).toHaveBeenCalledWith(PROJECT, 'build-100', 'queued', expect.objectContaining({ lastStep: 'enqueue' }));
  });
});

describe('README documents the step enum', () => {
  it('lists every step and outcome, and one example build.step line', () => {
    const readme = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'README.md'), 'utf8');
    for (const v of [...BUILD_STEPS, ...BUILD_STEP_OUTCOMES]) expect(readme, v).toContain(`\`${v}\``);
    expect(readme).toContain('"msg":"build.step"');
  });
});
