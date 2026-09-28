import { describe, it, expect, vi } from 'vitest';
import { MockStorageService } from './storage.mock.js';

describe('MockStorageService', () => {
  it('upload() returns predictable url/path/versionId', async () => {
    const svc = new MockStorageService({ baseUrl: 'https://example.test' });
    const result = await svc.upload('a/b/c.txt', Buffer.from('x'), 'text/plain');
    expect(result.url).toBe('https://example.test/a/b/c.txt');
    expect(result.path).toBe('a/b/c.txt');
    expect(result.versionId).toMatch(/^test-version-/);
  });

  it('getPresignedUploadUrl() returns an s3.amazonaws.com URL (to match tests)', async () => {
    const svc = new MockStorageService({ baseUrl: 'https://example.test' });
    const { url, key } = await svc.getPresignedUploadUrl('k.zip', 'application/zip');
    expect(key).toBe('k.zip');
    expect(url).toContain('s3.amazonaws.com');
    expect(url).toContain('k.zip');
  });

  it('getObjectRange() returns exactly the requested slice of a seeded/uploaded object', async () => {
    const svc = new MockStorageService();
    await svc.upload('k.bin', Buffer.from('0123456789'), 'application/octet-stream');
    expect(await svc.getObjectRange('k.bin', { offset: 2, length: 3 })).toEqual(new Uint8Array(Buffer.from('234')));
  });

  it('getObjectRange() clamps a length that runs past the end of the object', async () => {
    const svc = new MockStorageService();
    await svc.upload('k.bin', Buffer.from('0123456789'), 'application/octet-stream');
    expect(await svc.getObjectRange('k.bin', { offset: 8, length: 100 })).toEqual(new Uint8Array(Buffer.from('89')));
  });

  it('getObjectRange() returns null for a key that does not exist', async () => {
    const svc = new MockStorageService();
    expect(await svc.getObjectRange('missing.bin', { offset: 0, length: 10 })).toBeNull();
  });

  it('deleteByPrefix() logs the prefix', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const svc = new MockStorageService({ baseUrl: 'https://example.test' });
    await svc.deleteByPrefix('pfx/');
    expect(log).toHaveBeenCalledWith('Mock: Deleting objects with prefix: pfx/');
    log.mockRestore();
  });
});

