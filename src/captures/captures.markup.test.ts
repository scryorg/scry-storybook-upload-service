/**
 * Optional `markup` on POST /captures/:project/presign (feature snip-markup, upload PR 1).
 * Valid and invalid cases are driven from the shared contract (test/fixtures/snip-markup-contract.json).
 * Guarantee tests are named `guarantee-N-...` so the review can find them; guarantee-4 (the canary) lives
 * beside the other log canaries in captures.test.ts.
 * Set SCRY_RECORD_FIXTURES=1 to rewrite test/fixtures/presign-with-markup.json (Sync and the UAT seed read it).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/cloudflare', () => ({
  captureException: () => undefined,
  getCurrentScope: () => ({ setTag: () => undefined }),
  getTraceData: () => ({}),
}));

import { CAPTURE_ID, DEVICE_KEY, PROJECT, fakeJpeg, fakePng, fakeWebp, post, presignBody, setup } from './captures.test-support.js';

type Markup = { v: number; notes: Array<Record<string, unknown>>; marks?: Record<string, unknown> };
type ValidCase = { markup: Markup; note?: string };
type InvalidCase = { name: string; why: string; markup: unknown };
type Contract = {
  limits: { maxNotes: number; maxTextChars: number; maxMarksEach: number; presignBodyMaxChars: number; noteMaxChars: number };
  picture: { width: number; height: number };
  valid: Record<string, ValidCase>;
  invalid: InvalidCase[];
};

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '../../test/fixtures');
const contract = JSON.parse(readFileSync(join(FIXTURES, 'snip-markup-contract.json'), 'utf8')) as Contract;
const RECORD = process.env.SCRY_RECORD_FIXTURES === '1';

const { width: W, height: H } = contract.picture;
const PNG = fakePng(W, H, 600);
const presignPath = `/captures/${PROJECT}/presign`;
const completePath = `/captures/${PROJECT}/complete`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-13T10:00:00.000Z') });
  vi.restoreAllMocks();
  for (const m of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, m).mockImplementation(() => undefined);
});
afterEach(() => vi.useRealTimers());

type Env = ReturnType<typeof setup>;
const bodyWith = (overrides: Record<string, unknown>) => presignBody(PNG, overrides, W, H);
async function send(env: Env, overrides: Record<string, unknown>) {
  const res = await post(env.server, presignPath, DEVICE_KEY, bodyWith(overrides));
  return { res, json: (await res.clone().json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
const stored = (env: Env) => env.firestore.captures.get(`${PROJECT}/${CAPTURE_ID}`);

describe('markup validation from the shared contract (switch on)', () => {
  for (const [name, c] of Object.entries(contract.valid)) {
    it(`valid case "${name}": 200 and ${name === 'empty-normalised-away' ? 'stored as absent' : 'stored as sent'}`, async () => {
      const env = setup({ snipMarkup: true });
      const { res } = await send(env, { markup: c.markup, ...(c.note ? { note: c.note } : {}) });
      expect(res.status).toBe(200);
      if (name === 'empty-normalised-away') {
        expect(stored(env)).toBeDefined();
        expect(stored(env)).not.toHaveProperty('markup');
      } else {
        // stored as sent, except that note text is trimmed (the contract's "largest" texts end in a space)
        const trimmed = { ...c.markup, notes: c.markup.notes.map((n) => ({ ...n, text: String(n.text).trim() })) };
        expect(stored(env)?.markup).toEqual(trimmed);
      }
    });
  }

  for (const c of contract.invalid) {
    it(`invalid case "${c.name}" (${c.why}): 400 invalid_request naming only the field, nothing stored`, async () => {
      const env = setup({ snipMarkup: true });
      const { res, json } = await send(env, { markup: c.markup });
      expect(res.status).toBe(400);
      expect(json.error).toBe('invalid_request');
      expect(json.fields).toEqual(['markup']);
      // the error body carries field names only, never what the client wrote
      for (const note of ((c.markup as Markup).notes ?? [])) {
        if (typeof note.text === 'string' && note.text.length > 4) expect(JSON.stringify(json)).not.toContain(note.text);
      }
      expect(stored(env)).toBeUndefined();
      // only the rate counters are written, never a capture document
      expect(env.firestore.writes.filter((w) => w.includes('/captures/'))).toEqual([]);
    });
  }

  it('contract limits match the code (30 notes, 300 chars, 500 marks, 24,576-char body)', () => {
    expect(contract.limits).toMatchObject({ maxNotes: 30, maxTextChars: 300, maxMarksEach: 500, presignBodyMaxChars: 24576, noteMaxChars: 2000 });
  });
});

describe('markup edge cases (switch on)', () => {
  const note = (extra: Record<string, unknown> = {}) => ({ n: 1, x: 10, y: 20, text: 'hi', ...extra });
  const mk = (notes: Array<Record<string, unknown>>, marks?: Record<string, unknown>) => ({ v: 1, notes, ...(marks ? { marks } : {}) });

  it('drops unknown keys in notes, marks and the markup itself (bx/by, colour...)', async () => {
    const env = setup({ snipMarkup: true });
    const { res } = await send(env, {
      markup: { ...mk([note({ bx: 5, by: 6, colour: 'red', w: 30, h: 40 })], { arrows: 1, boxes: 0, pens: 2, stroke: 'ink' }), editor: 'x' },
    });
    expect(res.status).toBe(200);
    expect(stored(env)?.markup).toEqual({
      v: 1,
      notes: [{ n: 1, x: 10, y: 20, w: 30, h: 40, text: 'hi' }],
      marks: { arrows: 1, boxes: 0, pens: 2 },
    });
  });

  it('trims note text before checking the length and stores the trimmed text', async () => {
    const env = setup({ snipMarkup: true });
    const padded = `  \t${'a'.repeat(300)}  `;
    const { res } = await send(env, { markup: mk([note({ text: padded })]) });
    expect(res.status).toBe(200);
    expect(stored(env)?.markup?.notes[0].text).toBe('a'.repeat(300));
    const tooLong = await send(setup({ snipMarkup: true }), { markup: mk([note({ text: 'a'.repeat(301) })]) });
    expect(tooLong.res.status).toBe(400);
  });

  it('a missing marks object counts as 0 and a note with only drawn marks is kept', async () => {
    const env = setup({ snipMarkup: true });
    const { res } = await send(env, { markup: mk([note()]) });
    expect(res.status).toBe(200);
    expect(stored(env)?.markup?.marks).toEqual({ arrows: 0, boxes: 0, pens: 0 });
    const drawn = setup({ snipMarkup: true });
    expect((await send(drawn, { markup: mk([], { pens: 1 }) })).res.status).toBe(200);
    expect(stored(drawn)?.markup).toEqual({ v: 1, notes: [], marks: { arrows: 0, boxes: 0, pens: 1 } });
  });

  it('accepts the picture edges (x = width, x + w = width) and refuses one past them', async () => {
    const ok = await send(setup({ snipMarkup: true }), { markup: mk([note({ x: W, y: H }), { n: 2, x: 0, y: 0, w: W, h: H, text: '' }])});
    expect(ok.res.status).toBe(200);
    for (const bad of [note({ x: W + 1 }), note({ y: H + 1 }), note({ x: 1, w: W, h: 1 }), note({ y: 1, w: 1, h: H }), note({ w: 0, h: 5 }), note({ w: 5 }), note({ h: 5 }), note({ x: -1 })]) {
      expect((await send(setup({ snipMarkup: true }), { markup: mk([bad]) })).res.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it.each([
    ['DEL', 'a\u007fb'],
    ['C0 (NUL)', 'a\u0000b'],
    ['C0 (tab inside)', 'a\tb'],
    ['C1', 'a\u0085b'],
  ])('refuses a control character: %s', async (_name, text) => {
    expect((await send(setup({ snipMarkup: true }), { markup: mk([note({ text })]) })).res.status).toBe(400);
  });

  it('refuses mark counts above 500, non-integers and a non-object markup', async () => {
    for (const marks of [{ arrows: 501 }, { boxes: 1.5 }, { pens: '2' }]) {
      expect((await send(setup({ snipMarkup: true }), { markup: mk([note()], marks) })).res.status).toBe(400);
    }
    for (const markup of ['yes', 7, [], null]) {
      expect((await send(setup({ snipMarkup: true }), { markup })).res.status, JSON.stringify(markup)).toBe(400);
    }
  });

  it('a retry of the same presign still answers 200 and keeps the first markup', async () => {
    const env = setup({ snipMarkup: true });
    const first = mk([note({ text: 'first' })]);
    expect((await send(env, { markup: first })).res.status).toBe(200);
    const again = await send(env, { markup: mk([note({ text: 'second' })]) });
    expect(again.res.status).toBe(200);
    expect(again.json.created).toBe(false);
    expect(stored(env)?.markup?.notes[0].text).toBe('first');
  });
});

describe('body size cap', () => {
  const largest = contract.valid.largest;

  it('the contract "largest" case is under the 24,576-char cap and gets 200 with the switch on', async () => {
    const env = setup({ snipMarkup: true });
    const body = bodyWith({ markup: largest.markup, note: largest.note });
    const chars = JSON.stringify(body).length;
    expect(chars).toBeLessThan(contract.limits.presignBodyMaxChars);
    expect(chars).toBeGreaterThan(8192);
    const res = await post(env.server, presignPath, DEVICE_KEY, body);
    expect(res.status).toBe(200);
    expect(stored(env)?.markup?.notes).toHaveLength(30);
    expect(stored(env)?.note).toHaveLength(contract.limits.noteMaxChars);
  });

  it('a body over 24,576 chars is still a 400', async () => {
    const env = setup({ snipMarkup: true });
    const pad = 'x'.repeat(contract.limits.presignBodyMaxChars);
    const res = await post(env.server, presignPath, DEVICE_KEY, JSON.stringify({ ...bodyWith({}), pad }));
    expect(res.status).toBe(400);
  });
});

describe('switch off (SNIP_MARKUP unset or not "on")', () => {
  it.each([
    ['unset', undefined],
    ['off', false],
  ])('%s: a valid, an invalid and the largest markup get 200 and nothing is stored', async (_label, flag) => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['valid', { markup: contract.valid.anatomy3.markup }],
      ['invalid', { markup: contract.invalid[0].markup }],
      ['garbage', { markup: 'not even an object' }],
      ['largest', { markup: contract.valid.largest.markup, note: contract.valid.largest.note }],
    ];
    for (const [label, overrides] of cases) {
      const env = setup(flag === undefined ? {} : { snipMarkup: flag });
      const { res } = await send(env, overrides);
      expect(res.status, label).toBe(200);
      expect(stored(env), label).toBeDefined();
      expect(stored(env), label).not.toHaveProperty('markup');
    }
  });
});

describe('guarantee-2-original-sha256-unchanged-with-markup', () => {
  it('complete still checks the original sha256 exactly as before when markup is present', async () => {
    const env = setup({ snipMarkup: true });
    const { json } = await send(env, { markup: contract.valid.anatomy3.markup });
    await env.bucket.put(json.uploads.original.key, PNG, 'image/png');
    await env.bucket.put(json.uploads.preview.key, fakeJpeg(), 'image/jpeg');
    await env.bucket.put(json.uploads.agent.key, fakeWebp(), 'image/webp');
    const ok = await post(env.server, completePath, DEVICE_KEY, { captureId: CAPTURE_ID });
    expect(ok.status).toBe(200);
    expect(stored(env)?.markup).toEqual(contract.valid.anatomy3.markup);

    // a wrong declared sha256 is still a 422 hash_mismatch, markup or not
    const bad = setup({ snipMarkup: true });
    const wrong = await send(bad, { markup: contract.valid.anatomy3.markup, sha256: 'a'.repeat(64) });
    await bad.bucket.put(wrong.json.uploads.original.key, PNG, 'image/png');
    await bad.bucket.put(wrong.json.uploads.preview.key, fakeJpeg(), 'image/jpeg');
    await bad.bucket.put(wrong.json.uploads.agent.key, fakeWebp(), 'image/webp');
    const refused = await post(bad.server, completePath, DEVICE_KEY, { captureId: CAPTURE_ID });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: string }).error).toBe('hash_mismatch');
  });
});

describe('guarantee-7-unmarked-snip-unchanged', () => {
  /** What origin/stage stores and answers for a presign without `markup` (declared values in `presignBody`). */
  const LEGACY_DOC_KEYS = [
    'agentBytes', 'bytes', 'captureId', 'capturedByUid', 'createdAt', 'deviceId', 'expiresAt', 'height', 'mode', 'note',
    'os', 'previewBytes', 'scale', 'sendMode', 'sha256', 'sharedWith', 'sharedWithOrgIds', 'sharedWithProject', 'status', 'width',
  ];

  it.each([
    ['switch on', { snipMarkup: true }],
    ['switch off', { snipMarkup: false }],
    ['switch unset', {}],
  ])('a presign without markup stores the same fields and answers the same (%s)', async (_label, opts) => {
    const env = setup(opts);
    const { res, json } = await send(env, { note: 'plain note' });
    expect(res.status).toBe(200);
    expect(Object.keys(stored(env)!).sort()).toEqual(LEGACY_DOC_KEYS);
    expect(stored(env)).toMatchObject({
      captureId: CAPTURE_ID, capturedByUid: 'uid-ada', deviceId: 'deviceKey1', status: 'pending', width: W, height: H,
      note: 'plain note', sharedWith: [], sharedWithOrgIds: [], sharedWithProject: false,
    });
    expect(Object.keys(json).sort()).toEqual(['capture', 'created', 'uploads']);
    expect(Object.keys(json.capture).sort()).toEqual(['bytes', 'captureId', 'expiresAt', 'height', 'sha256', 'status', 'width']);
    expect(Object.keys(json.uploads).sort()).toEqual(['agent', 'original', 'preview']);
    expect(json.created).toBe(true);
  });

  it('with the switch on, the response to a marked presign has exactly the same shape as an unmarked one', async () => {
    const plain = await send(setup({ snipMarkup: true }), {});
    const marked = await send(setup({ snipMarkup: true }), { markup: contract.valid.anatomy3.markup });
    expect(Object.keys(marked.json).sort()).toEqual(Object.keys(plain.json).sort());
    expect(Object.keys(marked.json.capture).sort()).toEqual(Object.keys(plain.json.capture).sort());
    expect(JSON.stringify(marked.json)).not.toContain('header is too tall');
  });

  it('with the switch off a request carrying markup (valid or invalid) gets 200 and stores no markup', async () => {
    for (const markup of [contract.valid.anatomy3.markup, contract.invalid[1].markup]) {
      const env = setup({ snipMarkup: false });
      const { res } = await send(env, { markup });
      expect(res.status).toBe(200);
      expect(stored(env)).not.toHaveProperty('markup');
    }
  });

  it('with the switch on the largest case gets 200', async () => {
    const { res } = await send(setup({ snipMarkup: true }), { markup: contract.valid.largest.markup, note: contract.valid.largest.note });
    expect(res.status).toBe(200);
  });
});

describe('recorded fixture for Sync and the UAT seed', () => {
  it('test/fixtures/presign-with-markup.json matches what the server answers (SCRY_RECORD_FIXTURES=1 rewrites it)', async () => {
    const env = setup({ snipMarkup: true });
    const anatomy = contract.valid.anatomy3;
    const request = bodyWith({ markup: anatomy.markup, note: anatomy.note });
    const res = await post(env.server, presignPath, DEVICE_KEY, request);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { capture: unknown; created: boolean; uploads: Record<string, { url: string; key: string; contentType: string }> };
    for (const upload of Object.values(body.uploads!)) upload.url = '<presigned PUT url for the key; 15 minutes>';
    const largest = contract.valid.largest;
    const recorded = {
      request: { method: 'POST', path: '/captures/{project}/presign', body: request },
      response: { status: 200, body },
      largestRequestChars: JSON.stringify(bodyWith({ markup: largest.markup, note: largest.note })).length,
    };
    const file = join(FIXTURES, 'presign-with-markup.json');
    const text = JSON.stringify(recorded, null, 2) + '\n';
    if (RECORD) writeFileSync(file, text);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(text));
  });
});
