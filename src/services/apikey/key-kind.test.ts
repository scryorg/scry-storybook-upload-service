/**
 * scry-sync fail-closed (ledger F39): both key services hand on a PRESENT `kind` field as a
 * non-empty string whatever its stored type, and leave `kind` out only when the field is absent.
 * (The middleware then treats any present kind as the restricted device class.)
 */
import { describe, it, expect, vi } from 'vitest';

const RAW = 'scry_proj_my-project_abcdefghijklmnopqrstuvwxyz123456';

// Keep apikey.utils' hashing deterministic without a real WebCrypto in the test.
vi.mock('./apikey.utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./apikey.utils.js')>();
  return { ...actual, hashApiKey: vi.fn(async () => 'hash') };
});

const { readKeyKind, UNRECOGNISED_KEY_KIND } = await import('./apikey.utils.js');
const { ApiKeyServiceWorker } = await import('./apikey.worker.js');

describe('readKeyKind', () => {
  it('absent field is undefined (legacy key, unchanged)', () => {
    expect(readKeyKind(false, undefined)).toBeUndefined();
    expect(readKeyKind(false, 'device')).toBeUndefined();
  });
  it('a present string is passed through, as is (no case folding)', () => {
    expect(readKeyKind(true, 'device')).toBe('device');
    expect(readKeyKind(true, 'Device')).toBe('Device');
    expect(readKeyKind(true, 'whatever')).toBe('whatever');
  });
  it('a present empty or non-string value is never dropped', () => {
    for (const v of ['', null, undefined, 0, 5, true, {}, []]) {
      expect(readKeyKind(true, v), JSON.stringify(v)).toBe(UNRECOGNISED_KEY_KIND);
    }
  });
});

describe('ApiKeyServiceWorker.validateApiKey kind', () => {
  async function validateWith(extra: Record<string, unknown>) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          document: {
            name: 'projects/x/databases/(default)/documents/projects/my-project/apiKeys/key-1',
            fields: { name: { stringValue: 'K' }, prefix: { stringValue: 'scry_proj_my' }, status: { stringValue: 'active' }, ...extra },
          },
        },
      ],
    }) as unknown as typeof fetch;
    const svc = new ApiKeyServiceWorker({ projectId: 'p', clientEmail: 'e@p.iam', privateKey: 'k' });
    (svc as unknown as { accessToken: string; tokenExpiry: number }).accessToken = 'tok';
    (svc as unknown as { tokenExpiry: number }).tokenExpiry = Date.now() + 60_000;
    const res = await svc.validateApiKey('my-project', RAW);
    expect(res.valid).toBe(true);
    return res.apiKey!;
  }

  it("no kind field: no kind property (a legacy key keeps today's behaviour)", async () => {
    const key = await validateWith({});
    expect('kind' in key).toBe(false);
  });
  it("kind 'device' is handed on", async () => {
    expect((await validateWith({ kind: { stringValue: 'device' } })).kind).toBe('device');
  });
  it('a mis-cased or unknown string is handed on, not dropped', async () => {
    expect((await validateWith({ kind: { stringValue: 'Device' } })).kind).toBe('Device');
    expect((await validateWith({ kind: { stringValue: 'robot' } })).kind).toBe('robot');
  });
  it('non-string, null and empty kinds are present-but-unrecognised, never absent', async () => {
    for (const kind of [{ integerValue: '5' }, { booleanValue: true }, { nullValue: null }, { stringValue: '' }, { arrayValue: { values: [] } }, { mapValue: { fields: {} } }]) {
      const key = await validateWith({ kind });
      expect(key.kind, JSON.stringify(kind)).toBe(UNRECOGNISED_KEY_KIND);
    }
  });
});

describe('ApiKeyServiceNode.validateApiKey kind', () => {
  async function validateWith(data: Record<string, unknown>) {
    vi.resetModules();
    vi.doMock('firebase-admin', () => {
      const doc = { id: 'key-1', data: () => ({ name: 'K', prefix: 'scry_proj_my', status: 'active', ...data }) };
      const query = { where: () => query, limit: () => query, get: async () => ({ empty: false, docs: [doc] }) };
      return { default: { firestore: () => ({ collection: () => query }) } };
    });
    const { ApiKeyServiceNode } = await import('./apikey.node.js');
    const res = await new ApiKeyServiceNode().validateApiKey('my-project', RAW);
    expect(res.valid).toBe(true);
    return res.apiKey!;
  }

  it("no kind field: no kind property (a legacy key keeps today's behaviour)", async () => {
    expect('kind' in (await validateWith({}))).toBe(false);
  });
  it("kind 'device' is handed on; mis-cased and unknown strings too", async () => {
    expect((await validateWith({ kind: 'device' })).kind).toBe('device');
    expect((await validateWith({ kind: 'Device' })).kind).toBe('Device');
    expect((await validateWith({ kind: 'robot' })).kind).toBe('robot');
  });
  it('non-string, null and empty kinds are present-but-unrecognised, never absent', async () => {
    for (const kind of [5, true, null, '', {}, ['device']]) {
      expect((await validateWith({ kind })).kind, JSON.stringify(kind)).toBe(UNRECOGNISED_KEY_KIND);
    }
  });
});
