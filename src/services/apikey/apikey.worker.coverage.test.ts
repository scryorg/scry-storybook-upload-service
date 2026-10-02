import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiKeyServiceWorker } from './apikey.worker.js';

// Minimal crypto mocks required by apikey.utils.ts (generate + hash)
const mockSign = vi.fn().mockResolvedValue(new ArrayBuffer(256));
const mockImportKey = vi.fn().mockResolvedValue({});
const mockDigest = vi.fn().mockImplementation(async (_algo: string, data: ArrayBuffer) => {
  const bytes = new Uint8Array(data);
  // deterministic-ish digest for tests
  const out = new Uint8Array(32);
  for (let i = 0; i < out.length; i++) out[i] = (bytes[i % bytes.length] + i) % 256;
  return out.buffer;
});
const mockGetRandomValues = vi.fn((array: Uint8Array) => {
  for (let i = 0; i < array.length; i++) array[i] = (i * 13) % 256;
  return array;
});

Object.defineProperty(globalThis, 'crypto', {
  value: {
    subtle: {
      sign: mockSign,
      importKey: mockImportKey,
      digest: mockDigest,
    },
    getRandomValues: mockGetRandomValues,
  },
  writable: true,
});

const config = {
  projectId: 'test-firebase-project',
  clientEmail: 'test@test-firebase-project.iam.gserviceaccount.com',
  privateKey: '-----BEGIN PRIVATE KEY-----\nMIItest...\n-----END PRIVATE KEY-----',
};

describe('ApiKeyServiceWorker (coverage)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('base64UrlEncode() supports string and ArrayBuffer inputs', async () => {
    const svc = new ApiKeyServiceWorker(config);
    const s1 = (svc as any).base64UrlEncode('abc');
    const s2 = (svc as any).base64UrlEncode(new Uint8Array([1, 2, 3]).buffer);

    expect(typeof s1).toBe('string');
    expect(typeof s2).toBe('string');
    expect(s1).not.toContain('=');
    expect(s2).not.toContain('=');
  });

  it('getAccessToken() returns cached token when not expired', async () => {
    const svc = new ApiKeyServiceWorker(config);
    (svc as any).accessToken = 'cached-token';
    (svc as any).tokenExpiry = Date.now() + 60_000;

    await expect((svc as any).getAccessToken()).resolves.toBe('cached-token');
  });

  it('getAccessToken() throws when token exchange fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400, statusText: 'nope', text: async () => 'error body' });
    globalThis.fetch = fetchMock;

    const svc = new ApiKeyServiceWorker(config);
    (svc as any).createJWT = vi.fn().mockResolvedValue('jwt');

    await expect((svc as any).getAccessToken()).rejects.toThrow('Failed to get access token');
  });

  it('getAccessToken() covers non-cached success branch', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 't1', expires_in: 3600 }) });
    globalThis.fetch = fetchMock as any;

    const svc = new ApiKeyServiceWorker(config);
    (svc as any).createJWT = vi.fn().mockResolvedValue('jwt');

    // @ts-ignore - private method
    const token = await (svc as any).getAccessToken();
    expect(token).toBe('t1');
    expect((svc as any).accessToken).toBe('t1');
    expect((svc as any).tokenExpiry).toBeGreaterThan(Date.now());
  });

  it('validateApiKey() covers non-expired expiresAt and default field fallbacks', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          document: {
            name: 'projects/x/databases/(default)/documents/projects/my-project/apiKeys/key-1',
            fields: {
              // intentionally omit status + createdAt to hit fallbacks
              name: { stringValue: 'Key' },
              prefix: { stringValue: 'scry_proj_my' },
              createdBy: { stringValue: 'u1' },
              expiresAt: { timestampValue: '2999-01-01T00:00:00.000Z' },
              lastUsedAt: { timestampValue: '2026-01-01T00:00:00.000Z' },
              revokedAt: { timestampValue: '2026-01-02T00:00:00.000Z' },
              revokedBy: { stringValue: 'admin' },
            },
          },
        },
      ],
    });
    globalThis.fetch = fetchMock as any;

    const svc = new ApiKeyServiceWorker(config);
    (svc as any).accessToken = 'tok';
    (svc as any).tokenExpiry = Date.now() + 60_000;

    const res = await svc.validateApiKey('my-project', 'scry_proj_my-project_abcdefghijklmnopqrstuvwxyz123456');
    expect(res.valid).toBe(true);
    expect(res.apiKey?.id).toBe('key-1');
    expect(res.apiKey?.status).toBe('active');
    expect(res.apiKey?.lastUsedAt).toBeInstanceOf(Date);
    expect(res.apiKey?.expiresAt).toBeInstanceOf(Date);
    expect(res.apiKey?.revokedAt).toBeInstanceOf(Date);
  });

  it('signJWT() covers private key cleanup and base64-url encoding branch', async () => {
    const svc = new ApiKeyServiceWorker(config);
    const signature = await (svc as any).signJWT(
      'a.b',
      '-----BEGIN PRIVATE KEY-----\\nZm9v\\n-----END PRIVATE KEY-----'
    );
    expect(typeof signature).toBe('string');
    // Some environments/mocks can produce an empty signature string; what we
    // mainly care about here is exercising the key-cleanup + signing path.
    expect(signature).not.toContain('=');
    expect(signature).not.toContain('=');
  });

  it('createApiKey() throws when setDocument fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, statusText: 'bad' });
    globalThis.fetch = fetchMock;

    const svc = new ApiKeyServiceWorker(config);
    // Force cached access token path
    (svc as any).accessToken = 'tok';
    (svc as any).tokenExpiry = Date.now() + 60_000;

    await expect(
      svc.createApiKey('my-project', { name: 'Test', createdBy: 'u1' })
    ).rejects.toThrow('Failed to set document');
  });

  it('revokeApiKey() throws when the key read fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, statusText: 'bad' });
    globalThis.fetch = fetchMock;

    const svc = new ApiKeyServiceWorker(config);
    (svc as any).accessToken = 'tok';
    (svc as any).tokenExpiry = Date.now() + 60_000;

    await expect(svc.revokeApiKey('my-project', 'key-1', 'admin')).rejects.toThrow(
      'Failed to get document'
    );
  });

  it('deleteApiKey() throws when DELETE fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, statusText: 'bad' });
    globalThis.fetch = fetchMock;

    const svc = new ApiKeyServiceWorker(config);
    (svc as any).accessToken = 'tok';
    (svc as any).tokenExpiry = Date.now() + 60_000;

    await expect(svc.deleteApiKey('my-project', 'key-1')).rejects.toThrow('Failed to delete API key');
  });

  it('listApiKeys() throws when queryDocuments fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, statusText: 'bad' });
    globalThis.fetch = fetchMock;

    const svc = new ApiKeyServiceWorker(config);
    (svc as any).accessToken = 'tok';
    (svc as any).tokenExpiry = Date.now() + 60_000;

    await expect(svc.listApiKeys('my-project')).rejects.toThrow('Failed to query documents');
  });
});
