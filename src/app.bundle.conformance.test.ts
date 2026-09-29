/**
 * Ledger F126 / guarantee-7: EVERY conformance fixture (a copy of scryorg/scry-capture-format's
 * fixtures/, at the sha in src/vendor/scf/VERSION) goes through the real bundle/complete route
 * handler, and the route's verdict must equal the public validator's on the same directory: same
 * accept/reject, same error codes AND same messages (what the CLI prints), and the codes listed in
 * each fixture's expected.json.
 */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { app, type AppEnv } from './app.js';
import type { FirestoreService } from './services/firestore/firestore.service.js';
import type { Build } from './services/firestore/firestore.types.js';
import { MockStorageService } from './services/storage/storage.mock.js';
import { zipDirectory } from './bundle/__tests__/test-helpers.js';
import { validateBundle } from './vendor/scf/dist/index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bundle/__fixtures__/conformance');
const ZIP_KEY = 'acme/main/builds/5/bundle.zip';
const build: Build = {
  id: 'build-100', projectId: 'acme', versionId: 'main', buildNumber: 5, zipUrl: '', status: 'active',
  createdAt: new Date(), createdBy: 'test',
};

async function dirs(dir: string): Promise<string[]> {
  return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
}

async function complete(bundleDir: string): Promise<{ status: number; errors: { code: string; message: string }[] }> {
  const storage = new MockStorageService();
  storage.seed(ZIP_KEY, await zipDirectory(bundleDir));
  const firestore = {
    getBuild: vi.fn(async () => build),
    updateBuild: vi.fn(async () => undefined),
    updateProcessingStatus: vi.fn(async () => undefined),
    trackEvent: vi.fn(async () => undefined),
  } as unknown as FirestoreService;
  const server = new Hono<AppEnv>();
  server.use('*', async (c, next) => {
    c.set('storage', storage);
    c.set('firestore', firestore);
    c.set('processingQueue', { send: vi.fn(async () => undefined) } as unknown as Queue);
    await next();
  });
  server.route('/', app);
  const res = await server.request('/upload/acme/main/bundle/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ buildId: 'build-100', zipKey: ZIP_KEY }),
  });
  const body = (await res.json()) as { errors?: { code: string; message: string }[] };
  return { status: res.status, errors: body.errors ?? [] };
}

const valid = await dirs(path.join(ROOT, 'valid'));
const invalid = await dirs(path.join(ROOT, 'invalid'));
const sig = (e: { code: string; message: string }[]) => e.map((x) => `${x.code}|${x.message}`).sort();

describe('conformance fixtures through POST /upload/:project/:version/bundle/complete (F126)', () => {
  it('has every fixture, including the F125 enum ones and truncated-image-header', () => {
    expect(invalid).toContain('truncated-image-header');
    expect(invalid).toContain('bad-capture-method');
    expect(invalid.length).toBeGreaterThanOrEqual(26);
  });

  it.each(valid)('valid/%s is accepted (200)', async (name) => {
    const dir = path.join(ROOT, 'valid', name);
    const r = await complete(dir);
    expect(r.status, JSON.stringify(r.errors)).toBe(200);
  });

  it.each(invalid)('invalid/%s: 422 with the validator\'s exact codes and messages', async (name) => {
    const dir = path.join(ROOT, 'invalid', name);
    const expected = JSON.parse(await readFile(path.join(dir, 'expected.json'), 'utf8')) as { errors: string[] };
    const r = await complete(path.join(dir, 'bundle'));
    expect(r.status).toBe(422);
    expect(new Set(r.errors.map((e) => e.code))).toEqual(new Set(expected.errors));
    const direct = await validateBundle(path.join(dir, 'bundle'));
    expect(sig(r.errors)).toEqual(sig(direct.errors));
  });

  it('truncated-image-header is IMAGE_HEADER_UNREADABLE with the CLI message, not IMAGE_FORMAT_INVALID', async () => {
    const r = await complete(path.join(ROOT, 'invalid', 'truncated-image-header', 'bundle'));
    expect(r.errors.map((e) => e.code)).toEqual(['IMAGE_HEADER_UNREADABLE']);
    expect(r.errors[0]!.message).toContain('Could not read image dimensions from the header');
  });
});
