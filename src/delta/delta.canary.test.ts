// Stage 4 requirement (feature sync-delta-upload): no customer-controlled text reaches a log line or Sentry.
// Canary strings ride in the project path segment, the object id, the Idempotency-Key, headers and the manifest body, on
// unauthenticated, wrong-key and valid-key calls; none of them may appear in any captured line.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const captured: Array<{ err: unknown; opts?: unknown }> = [];
vi.mock('@sentry/cloudflare', () => ({
  captureException: (err: unknown, opts?: unknown) => {
    captured.push({ err, opts });
  },
  getCurrentScope: () => ({ setTag: () => undefined }),
  getTraceData: () => ({}),
}));

import { scrubEvent } from '../sentry-scrub.js';
import { DEVICE_KEY, PROJECT, fakePng, manifestBody, pictures, postCommit, postManifest, putBlob, setup, sha256 } from './delta.test-support.js';

const canary = JSON.parse(readFileSync(new URL('../../test-fixtures/canary.json', import.meta.url), 'utf8')) as { values: Record<string, string>; markers: string[] };
const v = canary.values;

let lines: string[];
beforeEach(() => {
  vi.restoreAllMocks();
  captured.length = 0;
  lines = [];
  const grab = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  for (const m of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(grab);
});

/** Markers found in the log lines, or in what Sentry would send (events go through the same scrubber as `beforeSend`). */
const leaked = (): string[] => {
  const sentry = captured.map((c) => scrubEvent({ exception: { values: [{ value: String((c.err as Error)?.message ?? c.err) }] }, extra: c.opts as Record<string, unknown> }));
  const text = lines.join('\n') + '\n' + JSON.stringify(sentry);
  return canary.markers.filter((m) => text.includes(m));
};

// Both are not a valid project id / object id, so they exercise the refusal paths; the encoded form keeps them one path segment.
const badProject = encodeURIComponent(`proj-${v.story_title}-${v.email}`);
const badOid = encodeURIComponent(`${v.design_text}${v.jwt}`);
const hostileHeaders = { Authorization: v.bearer, Cookie: v.cookie, 'x-scry-client': v.email, 'x-forwarded-for': v.query_pair };

describe('canary strings never reach a log line (delta routes)', () => {
  it('unauthenticated and wrong-key calls with canaries in the path, Idempotency-Key and headers', async () => {
    const { server } = setup();
    const [pic] = pictures(1);
    const calls: Array<Promise<Response>> = [
      // no key at all
      postManifest(server, PROJECT, undefined, manifestBody([pic]), { 'Idempotency-Key': v.sk_key, ...hostileHeaders }),
      putBlob(server, PROJECT, undefined, pic.oid, pic.bytes, v.google_key, hostileHeaders),
      postCommit(server, PROJECT, undefined, v.jwt),
      // a key that does not exist (the canary key itself), in the project path and out of it
      postManifest(server, PROJECT, v.sk_key, manifestBody([pic]), { 'Idempotency-Key': v.google_key, ...hostileHeaders }),
      postManifest(server, badProject, v.sk_key, manifestBody([pic]), { 'Idempotency-Key': v.query_pair, ...hostileHeaders }),
      putBlob(server, badProject, v.sk_key, badOid, pic.bytes, v.query_url, hostileHeaders),
      server.request(`/delta/${badProject}/builds/${encodeURIComponent(v.email)}/commit`, { method: 'POST', headers: { 'X-API-Key': v.sk_key, ...hostileHeaders }, body: '{}' }),
    ];
    const statuses = (await Promise.all(calls)).map((r) => r.status);
    expect(statuses.every((s) => s >= 400 && s < 500), `statuses ${statuses}`).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    expect(leaked()).toEqual([]);
  });

  it('valid-key calls whose Idempotency-Key, object id, build id and manifest text are canaries', async () => {
    const { server } = setup();
    const [pic] = pictures(1);
    const text = `${v.story_title} ${v.design_text}`;
    const body = manifestBody([pic]);
    body.scf.captures[0].name = text;
    body.scf.captures[0].title = [v.story_title, v.design_text];
    await postManifest(server, PROJECT, DEVICE_KEY, body, { 'Idempotency-Key': v.email, ...hostileHeaders });
    await postManifest(server, PROJECT, DEVICE_KEY, body, { 'Idempotency-Key': 'sync-attempt-canary-1', ...hostileHeaders });
    await postManifest(server, PROJECT, DEVICE_KEY, '{"protocol":1,"hash":"sha256","note":"' + v.email + '"', { 'Idempotency-Key': 'sync-attempt-canary-2' });
    await postManifest(server, PROJECT, DEVICE_KEY, { ...body, source: v.story_title }, { 'Idempotency-Key': 'sync-attempt-canary-3' });
    await putBlob(server, PROJECT, DEVICE_KEY, badOid, fakePng(5), v.query_url, hostileHeaders);
    await putBlob(server, PROJECT, DEVICE_KEY, sha256('absent'), fakePng(5), v.google_key, hostileHeaders);
    await postCommit(server, PROJECT, DEVICE_KEY, v.design_text);
    expect(lines.length).toBeGreaterThan(0);
    expect(leaked()).toEqual([]);
  });

  it('a failing store (error text carrying credentials) puts nothing in a line, and the Sentry scrubber removes it', async () => {
    const { server, firestore } = setup();
    firestore.createBuild = (async () => {
      throw new Error(`firestore down for ${v.email} ${v.sk_key} ${v.bearer}`);
    }) as never;
    const res = await postManifest(server, PROJECT, DEVICE_KEY, manifestBody(pictures(1)), { 'Idempotency-Key': 'sync-attempt-canary-4', ...hostileHeaders });
    expect(res.status).toBe(500);
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(await res.json())).not.toContain('CANARY');
    expect(leaked()).toEqual([]);
  });
});
