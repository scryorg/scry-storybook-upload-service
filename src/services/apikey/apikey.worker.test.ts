import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiKeyServiceWorker } from './apikey.worker.js';
import * as utils from './apikey.utils.js';

// Mock the fetch function
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock crypto.subtle for JWT signing
const mockSign = vi.fn().mockResolvedValue(new ArrayBuffer(256));
const mockDigest = vi.fn();
const mockImportKey = vi.fn().mockResolvedValue({});
const mockGetRandomValues = vi.fn((array: Uint8Array) => {
  for (let i = 0; i < array.length; i++) {
    array[i] = Math.floor(Math.random() * 256);
  }
  return array;
});

Object.defineProperty(global, 'crypto', {
  value: {
    subtle: {
      sign: mockSign,
      importKey: mockImportKey,
      digest: mockDigest.mockImplementation(async (_algo: string, data: ArrayBuffer) => {
        // Create a deterministic hash based on input length for testing
        const result = new Uint8Array(32);
        const view = new Uint8Array(data);
        for (let i = 0; i < 32; i++) {
          result[i] = (view[i % view.length] + i) % 256;
        }
        return result.buffer;
      }),
    },
    getRandomValues: mockGetRandomValues,
  },
  writable: true,
});

describe('ApiKeyServiceWorker', () => {
  const config = {
    projectId: 'test-firebase-project',
    clientEmail: 'test@test-firebase-project.iam.gserviceaccount.com',
    privateKey: '-----BEGIN PRIVATE KEY-----\nMIItest...\n-----END PRIVATE KEY-----',
  };

  let service: ApiKeyServiceWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ApiKeyServiceWorker(config);
    
    // Mock the getAccessToken method directly to avoid JWT/crypto issues in tests
    (service as any).getAccessToken = vi.fn().mockResolvedValue('mock-access-token');
    
    // Reset fetch mock
    mockFetch.mockReset();
  });

  describe('createApiKey', () => {
    it('should create an API key and return the raw key', async () => {
      // Mock the setDocument call (PATCH request)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const result = await service.createApiKey('my-project', {
        name: 'Test Key',
        createdBy: 'user-123',
      });

      expect(result.rawKey).toMatch(/^scry_proj_my-project_/);
      expect(result.apiKey.name).toBe('Test Key');
      expect(result.apiKey.status).toBe('active');
      expect(result.apiKey.createdBy).toBe('user-123');
      expect(result.apiKey.prefix).toBe(result.rawKey.slice(0, 12));
    });

    it('should create an API key with expiration date', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const expiresAt = new Date('2025-12-31');
      const result = await service.createApiKey('my-project', {
        name: 'Expiring Key',
        createdBy: 'user-123',
        expiresAt,
      });

      expect(result.apiKey.expiresAt).toEqual(expiresAt);
    });
  });

  describe('validateApiKey', () => {
    it('should return valid for an active key', async () => {
      const rawKey = 'scry_proj_my-project_abcdefghijklmnopqrstuvwxyz123456';
      
      // Mock query response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [{
          document: {
            name: 'projects/test-firebase-project/databases/(default)/documents/projects/my-project/apiKeys/key-123',
            fields: {
              name: { stringValue: 'Test Key' },
              prefix: { stringValue: 'scry_proj_my' },
              status: { stringValue: 'active' },
              createdAt: { timestampValue: '2025-01-01T00:00:00Z' },
              createdBy: { stringValue: 'user-123' },
            },
          },
        }],
      });

      const result = await service.validateApiKey('my-project', rawKey);

      expect(result.valid).toBe(true);
      expect(result.apiKey?.name).toBe('Test Key');
      expect(result.apiKey?.id).toBe('key-123');
    });

    it('should return invalid for non-existent key', async () => {
      const rawKey = 'scry_proj_my-project_abcdefghijklmnopqrstuvwxyz123456';
      
      // Mock empty query response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [], // No documents found
      });

      const result = await service.validateApiKey('my-project', rawKey);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid or revoked API key');
    });

    it('should return invalid for malformed key', async () => {
      const result = await service.validateApiKey('my-project', 'invalid-key-format');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid API key format');
    });

    it('should return invalid for expired key', async () => {
      const rawKey = 'scry_proj_my-project_abcdefghijklmnopqrstuvwxyz123456';
      
      // Mock query response with expired key
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [{
          document: {
            name: 'projects/test-firebase-project/databases/(default)/documents/projects/my-project/apiKeys/key-123',
            fields: {
              name: { stringValue: 'Expired Key' },
              prefix: { stringValue: 'scry_proj_my' },
              status: { stringValue: 'active' },
              createdAt: { timestampValue: '2024-01-01T00:00:00Z' },
              createdBy: { stringValue: 'user-123' },
              expiresAt: { timestampValue: '2024-06-01T00:00:00Z' }, // Past date
            },
          },
        }],
      });

      const result = await service.validateApiKey('my-project', rawKey);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('API key has expired');
    });
  });

  describe('listApiKeys', () => {
    it('should return a list of API keys without hash data', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            document: {
              name: 'projects/test-firebase-project/databases/(default)/documents/projects/my-project/apiKeys/key-1',
              fields: {
                name: { stringValue: 'Key 1' },
                prefix: { stringValue: 'scry_proj_my' },
                status: { stringValue: 'active' },
                createdAt: { timestampValue: '2025-01-01T00:00:00Z' },
                createdBy: { stringValue: 'user-123' },
              },
            },
          },
          {
            document: {
              name: 'projects/test-firebase-project/databases/(default)/documents/projects/my-project/apiKeys/key-2',
              fields: {
                name: { stringValue: 'Key 2' },
                prefix: { stringValue: 'scry_proj_my' },
                status: { stringValue: 'revoked' },
                createdAt: { timestampValue: '2025-01-02T00:00:00Z' },
                createdBy: { stringValue: 'user-456' },
                revokedAt: { timestampValue: '2025-01-15T00:00:00Z' },
                revokedBy: { stringValue: 'admin-789' },
              },
            },
          },
        ],
      });

      const result = await service.listApiKeys('my-project');

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Key 1');
      expect(result[0].status).toBe('active');
      expect(result[1].name).toBe('Key 2');
      expect(result[1].status).toBe('revoked');
      expect(result[1].revokedBy).toBe('admin-789');
      // Ensure hash is not included
      expect((result[0] as any).hash).toBeUndefined();
    });
  });

  describe('revokeApiKey', () => {
    it('should revoke an API key', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      await expect(service.revokeApiKey('my-project', 'key-123', 'admin-user')).resolves.not.toThrow();

      // Verify the PATCH request was made with correct fields
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const patchCall = mockFetch.mock.calls[0];
      expect(patchCall[0]).toContain('apiKeys/key-123');
      // F84: one updateMask.fieldPaths per field, never comma-joined
      expect(patchCall[0]).toContain('updateMask.fieldPaths=status&updateMask.fieldPaths=revokedAt&updateMask.fieldPaths=revokedBy');
      expect(patchCall[0]).not.toContain(',');
      expect(patchCall[1].method).toBe('PATCH');
    });

    it('regression-empty-updatemask: patchDocument() with no fields throws instead of sending a mask-less PATCH (F9)', async () => {
      // No current caller (revokeApiKey, updateLastUsed) ever passes an empty `fields` object, but
      // patchDocument() is a shared private helper -- an empty updateMask.fieldPaths query is a
      // Firestore full-document replace, not a no-op, so it must fail closed regardless of caller.
      await expect(
        (service as any).patchDocument('projects/my-project/apiKeys/key-123', {}, 'mock-access-token')
      ).rejects.toThrow(/empty update mask/i);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('deleteApiKey', () => {
    it('should delete an API key', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
      });

      await expect(service.deleteApiKey('my-project', 'key-123')).resolves.not.toThrow();

      // Verify the DELETE request was made
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const deleteCall = mockFetch.mock.calls[0];
      expect(deleteCall[0]).toContain('apiKeys/key-123');
      expect(deleteCall[1].method).toBe('DELETE');
    });
  });

  describe('updateLastUsed', () => {
    it('should update the lastUsedAt timestamp', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      await expect(service.updateLastUsed('my-project', 'key-123')).resolves.not.toThrow();

      // Verify the PATCH request was made with lastUsedAt field
      const patchCall = mockFetch.mock.calls[0];
      expect(patchCall[0]).toContain('lastUsedAt');
    });
  });
});