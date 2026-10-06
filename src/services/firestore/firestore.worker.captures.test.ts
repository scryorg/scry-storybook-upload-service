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
