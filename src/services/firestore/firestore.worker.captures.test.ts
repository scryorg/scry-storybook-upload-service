// Worker REST implementation of the Scry Snip capture documents (feature snip-capture, PR 1).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FirestoreServiceWorker } from './firestore.worker.js';

function createSvc() {
  const svc = new FirestoreServiceWorker({
    projectId: 'firebase-proj',
    clientEmail: 'test@example.com',
    privateKey: '-----BEGIN PRIVATE KEY-----\\nZm9v\\n-----END PRIVATE KEY-----',
    serviceAccountId: 'upload-service',
  });
  (svc as unknown as { accessToken: string }).accessToken = 'test-token';
  (svc as unknown as { tokenExpiry: number }).tokenExpiry = Date.now() + 60_000;
  return svc;
}

const ID = '0192f3a4-7b5c-7d2e-8f10-3a4b5c6d7e8f';
const data = {
  captureId: ID,
  capturedByUid: 'uid-ada',
  deviceId: 'deviceKey1',
  width: 1200,
  height: 800,
  bytes: 600,
  previewBytes: 300,
  agentBytes: 200,
  sha256: 'a'.repeat(64),
  scale: 2,
  os: 'mac' as const,
  mode: 'region' as const,
  sendMode: 'review' as const,
  note: 'hello',
  expiresAt: new Date('2026-11-05T00:00:00.000Z'),
};
const json = (status: number, body: unknown = {}) => ({ ok: status < 300, status, statusText: String(status), json: async () => body, text: async () => JSON.stringify(body) });

describe('FirestoreServiceWorker captures', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('createCaptureIfAbsent PATCHes with currentDocument.exists=false and the data model fields', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { calls.push({ url, init }); return json(200); }));
    const { capture, created } = await createSvc().createCaptureIfAbsent('proj1', data);
    expect(created).toBe(true);
    expect(capture).toMatchObject({ status: 'pending', sharedWith: [], sharedWithOrgIds: [], sharedWithProject: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(`/documents/projects/proj1/captures/${ID}?`);
    expect(calls[0].url).toContain('currentDocument.exists=false');
    expect(calls[0].init?.method).toBe('PATCH');
    const fields = JSON.parse(String(calls[0].init?.body)).fields;
    expect(fields.status).toEqual({ stringValue: 'pending' });
    expect(fields.capturedByUid).toEqual({ stringValue: 'uid-ada' });
    expect(fields.sharedWith).toEqual({ arrayValue: { values: [] } });
    expect(fields.sharedWithProject).toEqual({ booleanValue: false });
    expect(fields.expiresAt).toEqual({ timestampValue: '2026-11-05T00:00:00.000Z' });
    expect(fields.width).toEqual({ integerValue: '1200' });
    expect(fields.note).toEqual({ stringValue: 'hello' });
  });

  it.each([[409, '{"error":{"status":"ALREADY_EXISTS"}}'], [400, '{"error":{"status":"FAILED_PRECONDITION","message":"exists"}}']])(
    'an existing document (HTTP %i) is read back and reported as not created',
    async (status, body) => {
      const existing = {
        fields: {
          captureId: { stringValue: ID }, capturedByUid: { stringValue: 'uid-ada' }, deviceId: { stringValue: 'deviceKey1' }, status: { stringValue: 'ready' },
          width: { integerValue: '1200' }, height: { integerValue: '800' }, bytes: { integerValue: '600' }, sha256: { stringValue: 'a'.repeat(64) },
          scale: { doubleValue: 1.5 }, os: { stringValue: 'win' }, mode: { stringValue: 'window' }, sendMode: { stringValue: 'auto' },
          sharedWith: { arrayValue: { values: [{ stringValue: 'uid-bob' }] } }, sharedWithProject: { booleanValue: true },
          createdAt: { timestampValue: '2026-10-06T14:00:00.000Z' }, receivedAt: { timestampValue: '2026-10-06T14:01:00.000Z' }, expiresAt: { timestampValue: '2026-11-05T00:00:00.000Z' },
        },
      };
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => (init?.method === 'PATCH' ? { ...json(status), text: async () => body } : json(200, existing))));
      const { capture, created } = await createSvc().createCaptureIfAbsent('proj1', data);
      expect(created).toBe(false);
      expect(capture).toMatchObject({ status: 'ready', os: 'win', mode: 'window', sendMode: 'auto', scale: 1.5, sharedWith: ['uid-bob'], sharedWithProject: true, sharedWithOrgIds: [] });
      expect(capture.receivedAt?.toISOString()).toBe('2026-10-06T14:01:00.000Z');
    }
  );

  it('any other create failure throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ...json(403), text: async () => '{"error":{"status":"PERMISSION_DENIED"}}' })));
    await expect(createSvc().createCaptureIfAbsent('proj1', data)).rejects.toThrow(/Failed to create document: 403/);
  });

  it('getCapture returns null for a missing document', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(404)));
    expect(await createSvc().getCapture('proj1', ID)).toBeNull();
  });

  it('markCaptureReady patches status and receivedAt only', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const doc = { fields: { captureId: { stringValue: ID }, status: { stringValue: 'pending' }, capturedByUid: { stringValue: 'uid-ada' } } };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { calls.push({ url, init }); return json(200, doc); }));
    const ready = await createSvc().markCaptureReady('proj1', ID);
    expect(ready?.status).toBe('ready');
    expect(ready?.receivedAt).toBeInstanceOf(Date);
    const patch = calls.find((c) => c.init?.method === 'PATCH')!;
    expect(patch.url).toContain('currentDocument.exists=true');
    expect(patch.url).toContain('updateMask.fieldPaths=status');
    expect(patch.url).toContain('updateMask.fieldPaths=receivedAt');
    expect(Object.keys(JSON.parse(String(patch.init?.body)).fields).sort()).toEqual(['receivedAt', 'status']);
  });

  it('markCaptureIndexOff patches indexState=off and indexedAt only, and never creates the document', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { calls.push({ url, init }); return json(200); }));
    await createSvc().markCaptureIndexOff('proj1', ID);
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe('PATCH');
    expect(calls[0].url).toContain(`/documents/projects/proj1/captures/${ID}?`);
    expect(calls[0].url).toContain('currentDocument.exists=true');
    expect(decodeURIComponent(calls[0].url)).toContain('updateMask.fieldPaths=indexState');
    expect(decodeURIComponent(calls[0].url)).toContain('updateMask.fieldPaths=indexedAt');
    const fields = JSON.parse(String(calls[0].init?.body)).fields;
    expect(Object.keys(fields).sort()).toEqual(['indexState', 'indexedAt']);
    expect(fields.indexState).toEqual({ stringValue: 'off' });
    expect(new Date(fields.indexedAt.timestampValue).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('markCaptureReady returns null when the capture is gone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(404)));
    expect(await createSvc().markCaptureReady('proj1', ID)).toBeNull();
  });

  it.each([[404, '{"error":{"status":"NOT_FOUND"}}'], [400, '{"error":{"status":"FAILED_PRECONDITION"}}']])(
    'markCaptureReady does not recreate a document deleted after the read (PATCH answers %i): null, no second write',
    async (status, body) => {
      const doc = { fields: { captureId: { stringValue: ID }, status: { stringValue: 'pending' }, capturedByUid: { stringValue: 'uid-ada' } } };
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === 'PATCH' ? { ...json(status), text: async () => body } : json(200, doc)));
      vi.stubGlobal('fetch', fetchMock);
      expect(await createSvc().markCaptureReady('proj1', ID)).toBeNull();
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
    }
  );

  it('previewBytes and agentBytes are stored and read back', async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => { calls.push({ init }); return json(200); }));
    const { capture } = await createSvc().createCaptureIfAbsent('proj1', data);
    expect(capture).toMatchObject({ previewBytes: 300, agentBytes: 200 });
    const fields = JSON.parse(String(calls[0].init?.body)).fields;
    expect(fields.previewBytes).toEqual({ integerValue: '300' });
    expect(fields.agentBytes).toEqual({ integerValue: '200' });
  });

  it('snip-markup: markup is written as a map of arrays of maps with integerValue and reads back unchanged (serialise -> parse)', async () => {
    const markup = {
      v: 1 as const,
      notes: [
        { n: 1, x: 436, y: 96, w: 260, h: 64, text: 'header is too tall, should be 48 px' },
        { n: 2, x: 912, y: 540, text: '' },
      ],
      marks: { arrows: 1, boxes: 0, pens: 2 },
    };
    const calls: Array<{ init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => { calls.push({ init }); return json(200); }));
    const { capture } = await createSvc().createCaptureIfAbsent('proj1', { ...data, markup });
    expect(capture.markup).toEqual(markup);
    const fields = JSON.parse(String(calls[0].init?.body)).fields;
    expect(fields.markup.mapValue.fields.v).toEqual({ integerValue: '1' });
    expect(fields.markup.mapValue.fields.marks.mapValue.fields.pens).toEqual({ integerValue: '2' });
    const first = fields.markup.mapValue.fields.notes.arrayValue.values[0].mapValue.fields;
    expect(first.x).toEqual({ integerValue: '436' });
    expect(first.text).toEqual({ stringValue: 'header is too tall, should be 48 px' });
    const second = fields.markup.mapValue.fields.notes.arrayValue.values[1].mapValue.fields;
    expect(Object.keys(second).sort()).toEqual(['n', 'text', 'x', 'y']);

    // parse: the same fields come back as the same markup
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { name: 'x', fields, updateTime: '2026-10-13T00:00:00Z' })));
    const read = await createSvc().getCapture('proj1', ID);
    expect(read?.markup).toEqual(markup);
  });

  it('snip-markup: a capture without markup writes no markup field and reads back without one', async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => { calls.push({ init }); return json(200); }));
    const { capture } = await createSvc().createCaptureIfAbsent('proj1', data);
    expect(capture).not.toHaveProperty('markup');
    const fields = JSON.parse(String(calls[0].init?.body)).fields;
    expect(fields).not.toHaveProperty('markup');
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { name: 'x', fields, updateTime: '2026-10-13T00:00:00Z' })));
    expect(await createSvc().getCapture('proj1', ID)).not.toHaveProperty('markup');
  });

  it('animated-snips: animated and animation are written as a boolean and a map (integerValue, stringValue, doubleValue) and read back unchanged', async () => {
    const animation = { bytes: 22838, sha256: 'b'.repeat(64), durationMs: 3000, width: 1280, height: 800, fps: 12 };
    const calls: Array<{ init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => { calls.push({ init }); return json(200); }));
    const { capture } = await createSvc().createCaptureIfAbsent('proj1', { ...data, animated: true, animation });
    expect(capture).toMatchObject({ animated: true, animation });
    const fields = JSON.parse(String(calls[0].init?.body)).fields;
    expect(fields.animated).toEqual({ booleanValue: true });
    const mapped = fields.animation.mapValue.fields;
    expect(mapped.bytes).toEqual({ integerValue: '22838' });
    expect(mapped.durationMs).toEqual({ integerValue: '3000' });
    expect(mapped.width).toEqual({ integerValue: '1280' });
    expect(mapped.height).toEqual({ integerValue: '800' });
    expect(mapped.sha256).toEqual({ stringValue: 'b'.repeat(64) });
    expect(mapped.fps).toEqual({ doubleValue: 12 });
    expect(Object.keys(mapped).sort()).toEqual(['bytes', 'durationMs', 'fps', 'height', 'sha256', 'width']);

    // parse: a whole-number double and a fractional one both come back as numbers
    for (const [stored, fps] of [[{ doubleValue: 12 }, 12], [{ doubleValue: 7.5 }, 7.5], [{ integerValue: '10' }, 10]] as const) {
      const withFps = { ...fields, animation: { mapValue: { fields: { ...mapped, fps: stored } } } };
      vi.stubGlobal('fetch', vi.fn(async () => json(200, { name: 'x', fields: withFps, updateTime: '2026-10-15T00:00:00Z' })));
      const read = await createSvc().getCapture('proj1', ID);
      expect(read).toMatchObject({ animated: true, animation: { ...animation, fps } });
    }
  });

  it('animated-snips: a still capture writes neither animated nor animation and reads back without them', async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => { calls.push({ init }); return json(200); }));
    const { capture } = await createSvc().createCaptureIfAbsent('proj1', data);
    expect(capture).not.toHaveProperty('animated');
    expect(capture).not.toHaveProperty('animation');
    const fields = JSON.parse(String(calls[0].init?.body)).fields;
    expect(fields).not.toHaveProperty('animated');
    expect(fields).not.toHaveProperty('animation');
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { name: 'x', fields, updateTime: '2026-10-15T00:00:00Z' })));
    const read = await createSvc().getCapture('proj1', ID);
    expect(read).not.toHaveProperty('animated');
    expect(read).not.toHaveProperty('animation');
  });

  it('incrementCaptureCounter sends one atomic increment transform and returns the new count', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { calls.push({ url, init }); return json(200, { writeResults: [{ transformResults: [{ integerValue: '17' }] }] }); }));
    const n = await createSvc().incrementCaptureCounter('proj1', 'deviceKey1_m_5', new Date('2026-10-06T14:03:00.000Z'));
    expect(n).toBe(17);
    expect(calls).toHaveLength(1);
    expect(calls[0].url.endsWith('/documents:commit')).toBe(true);
    const write = JSON.parse(String(calls[0].init?.body)).writes[0];
    expect(write.update.name).toBe('projects/firebase-proj/databases/(default)/documents/projects/proj1/captureLimits/deviceKey1_m_5');
    expect(write.update.fields.expireAt).toEqual({ timestampValue: '2026-10-06T14:03:00.000Z' });
    expect(write.updateTransforms).toEqual([{ fieldPath: 'count', increment: { integerValue: '1' } }]);
  });

  it('incrementCaptureCounter is not retried on failure and rejects an answer with no value', async () => {
    const failing = vi.fn(async () => json(503));
    vi.stubGlobal('fetch', failing);
    await expect(createSvc().incrementCaptureCounter('proj1', 'k_m_1', new Date())).rejects.toThrow(/503/);
    expect(failing).toHaveBeenCalledTimes(1);
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { writeResults: [{}] })));
    await expect(createSvc().incrementCaptureCounter('proj1', 'k_m_1', new Date())).rejects.toThrow(/no value/);
  });
});
