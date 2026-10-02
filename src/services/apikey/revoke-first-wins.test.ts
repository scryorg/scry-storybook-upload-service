/**
 * scry-sync F43(a): the first revocation of an API key wins. A repeat or concurrent revoke must not
 * overwrite `revokedAt` / `revokedBy`, in both ApiKeyService implementations (Workers REST + Node SDK).
 * Guarantee-5 (revoke stops uploads) depends on the key staying revoked; the audit trail depends on
 * the first revoker staying on the record.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiKeyServiceWorker } from './apikey.worker.js';

interface FakeDoc {
  status: string;
  revokedAt?: string;
  revokedBy?: string;
  updateTime: number;
}

const noHeaders = () => ({ get: () => null });

/** A one-document Firestore REST fake: GET returns fields + updateTime; PATCH honours updateMask and currentDocument.updateTime. */
function fakeFirestore(initial: Partial<FakeDoc> = {}) {
  const doc: FakeDoc = { status: 'active', updateTime: 1, ...initial };
  const patches: Array<{ url: string; body: { fields: Record<string, { stringValue?: string; timestampValue?: string }> } }> = [];
  let bumpBeforeNextPatch = false;

  const fetchFn = vi.fn(async (input: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') {
      return {
        ok: true,
        status: 200,
        headers: noHeaders(),
        json: async () => ({
          name: 'projects/p/databases/(default)/documents/projects/proj/apiKeys/key-1',
          fields: {
            status: { stringValue: doc.status },
            ...(doc.revokedAt ? { revokedAt: { timestampValue: doc.revokedAt } } : {}),
            ...(doc.revokedBy ? { revokedBy: { stringValue: doc.revokedBy } } : {}),
          },
          updateTime: `t${doc.updateTime}`,
        }),
      };
    }
    const url = new URL(input);
    const body = JSON.parse(init?.body ?? '{}');
    patches.push({ url: input, body });
    if (bumpBeforeNextPatch) {
      bumpBeforeNextPatch = false;
      doc.updateTime++; // e.g. a fire-and-forget lastUsedAt write landed after our read
    }
    const expected = url.searchParams.get('currentDocument.updateTime');
    if (expected !== null && expected !== `t${doc.updateTime}`) {
      return {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        headers: noHeaders(),
        json: async () => ({ error: { code: 400, status: 'FAILED_PRECONDITION' } }),
      };
    }
    doc.status = body.fields.status.stringValue;
    doc.revokedAt = body.fields.revokedAt.timestampValue;
    doc.revokedBy = body.fields.revokedBy.stringValue;
    doc.updateTime++;
    return { ok: true, status: 200, headers: noHeaders(), json: async () => ({}) };
  });

  return { doc, patches, fetchFn, bumpBeforeNextPatch: () => { bumpBeforeNextPatch = true; } };
}

function workerService() {
  const svc = new ApiKeyServiceWorker({ projectId: 'p', clientEmail: 'sa@example.com', privateKey: 'k' });
  (svc as unknown as { getAccessToken: () => Promise<string> }).getAccessToken = vi.fn().mockResolvedValue('tok');
  return svc;
}

describe('ApiKeyServiceWorker.revokeApiKey: first revocation wins (F43a)', () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.unstubAllGlobals());

  it('a repeat revoke on an already-revoked key writes nothing and keeps the first revokedAt/revokedBy', async () => {
    const fs = fakeFirestore({ status: 'revoked', revokedAt: '2026-10-01T00:00:00.000Z', revokedBy: 'self' });
    vi.stubGlobal('fetch', fs.fetchFn);

    await expect(workerService().revokeApiKey('proj', 'key-1', 'admin-user')).resolves.toBeUndefined();

    expect(fs.patches).toHaveLength(0);
    expect(fs.doc.revokedBy).toBe('self');
    expect(fs.doc.revokedAt).toBe('2026-10-01T00:00:00.000Z');
  });

  it('two concurrent revokes: exactly one write lands, the first revoker stays on the record, neither call throws', async () => {
    const fs = fakeFirestore();
    vi.stubGlobal('fetch', fs.fetchFn);
    const svc = workerService();

    const results = await Promise.allSettled([
      svc.revokeApiKey('proj', 'key-1', 'first'),
      svc.revokeApiKey('proj', 'key-1', 'second'),
    ]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(fs.doc.status).toBe('revoked');
    expect(fs.doc.revokedBy).toBe('first');
    // Exactly one write applied (the loser's PATCH was refused by its precondition).
    expect(fs.doc.updateTime).toBe(2);
  });

  it('the revoke PATCH carries a currentDocument.updateTime precondition from the read', async () => {
    const fs = fakeFirestore();
    vi.stubGlobal('fetch', fs.fetchFn);

    await workerService().revokeApiKey('proj', 'key-1', 'admin');

    expect(fs.patches).toHaveLength(1);
    expect(new URL(fs.patches[0].url).searchParams.get('currentDocument.updateTime')).toBe('t1');
    expect(fs.doc.revokedBy).toBe('admin');
  });

  it('an unrelated write (lastUsedAt) between read and write re-reads and still revokes', async () => {
    const fs = fakeFirestore();
    fs.bumpBeforeNextPatch();
    vi.stubGlobal('fetch', fs.fetchFn);

    await workerService().revokeApiKey('proj', 'key-1', 'admin');

    expect(fs.doc.status).toBe('revoked');
    expect(fs.doc.revokedBy).toBe('admin');
    expect(fs.patches).toHaveLength(2);
  });

  it('a missing key document is an error, not a freshly created revoked document', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found', headers: noHeaders() }));
    vi.stubGlobal('fetch', fetchFn);

    await expect(workerService().revokeApiKey('proj', 'ghost', 'admin')).rejects.toThrow(/Failed to get document/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('a non-precondition write failure still throws', async () => {
    const fs = fakeFirestore();
    const base = fs.fetchFn;
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'PATCH') return { ok: false, status: 403, statusText: 'Forbidden', headers: noHeaders(), json: async () => ({}) };
      return base(input, init);
    }));

    await expect(workerService().revokeApiKey('proj', 'key-1', 'admin')).rejects.toThrow('Failed to patch document');
  });
});

describe('ApiKeyServiceNode.revokeApiKey: first revocation wins (F43a)', () => {
  /** Minimal Admin-SDK fake: runTransaction gets a tx whose get/update act on one in-memory doc. */
  async function nodeServiceWith(initial: Record<string, unknown>) {
    vi.resetModules();
    const state: Record<string, unknown> = { ...initial };
    const updates: Array<Record<string, unknown>> = [];
    vi.doMock('firebase-admin', () => {
      const ref = { path: 'projects/proj/apiKeys/key-1' };
      const tx = {
        get: async () => ({ exists: true, data: () => state }),
        update: (_ref: unknown, data: Record<string, unknown>) => {
          updates.push(data);
          Object.assign(state, data);
        },
      };
      const db = {
        doc: () => ref,
        runTransaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx),
      };
      return { default: { firestore: Object.assign(() => db, { FieldValue: { serverTimestamp: () => 'SERVER_TS' } }) } };
    });
    const { ApiKeyServiceNode } = await import('./apikey.node.js');
    return { svc: new ApiKeyServiceNode(), state, updates };
  }

  it('revokes an active key', async () => {
    const { svc, state } = await nodeServiceWith({ status: 'active' });
    await svc.revokeApiKey('proj', 'key-1', 'admin');
    expect(state.status).toBe('revoked');
    expect(state.revokedBy).toBe('admin');
  });

  it('a repeat revoke on an already-revoked key writes nothing and keeps the first revokedBy', async () => {
    const { svc, state, updates } = await nodeServiceWith({ status: 'revoked', revokedBy: 'self', revokedAt: 'T0' });
    await expect(svc.revokeApiKey('proj', 'key-1', 'admin')).resolves.toBeUndefined();
    expect(updates).toHaveLength(0);
    expect(state.revokedBy).toBe('self');
    expect(state.revokedAt).toBe('T0');
  });
});
