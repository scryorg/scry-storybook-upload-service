import { createHash } from 'node:crypto';
import { StorageService, StorageKeyPage, StorageObjectMeta, StorageObjectRange, UploadResult } from './storage.service.js';

/**
 * A mock StorageService implementation for testing that returns
 * predictable URLs and responses that match test expectations.
 *
 * Tracks uploaded bytes in memory so `head`/`getObjectStream`/`delete` behave like a real
 * object store against whatever was actually `upload()`-ed (capture-sources bundle route tests
 * need this: they upload a fixture zip, then complete() reads it back).
 */
export class MockStorageService implements StorageService {
  private readonly baseUrl: string;
  private readonly objects = new Map<string, { bytes: Uint8Array; contentType: string; uploaded: Date }>();

  constructor(options?: { baseUrl?: string }) {
    this.baseUrl = options?.baseUrl || 'https://test-bucket.s3.amazonaws.com';
  }

  async upload(key: string, body: ReadableStream | Buffer, contentType: string): Promise<UploadResult> {
    // Simulate upload delay
    await new Promise(resolve => setTimeout(resolve, 10));

    const bytes = await toBytes(body);
    this.objects.set(key, { bytes, contentType, uploaded: new Date() });

    return {
      url: `${this.baseUrl}/${key}`,
      path: key,
      versionId: `test-version-${Date.now()}`,
    };
  }

  async getPresignedUploadUrl(key: string, _contentType: string): Promise<{ url: string; key: string }> {
    // Return a URL that contains s3.amazonaws.com to match test expectations
    const presignedUrl = `https://test-bucket.s3.amazonaws.com/${key}?AWSAccessKeyId=test&Expires=1234567890&Signature=test`;

    return {
      url: presignedUrl,
      key: key
    };
  }

  async getPresignedCaptureUploadUrl(key: string, opts: { contentType: string; contentLength: number; expiresIn: number }): Promise<{ url: string; key: string }> {
    const url = `https://test-bucket.s3.amazonaws.com/${key}?X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost&X-Amz-Expires=${opts.expiresIn}&X-Amz-Signature=test`;
    return { url, key };
  }

  async head(key: string): Promise<StorageObjectMeta | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    return { size: object.bytes.byteLength, contentType: object.contentType };
  }

  async getObjectStream(key: string): Promise<ReadableStream | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    const bytes = object.bytes;
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  async getObjectRange(key: string, range: StorageObjectRange): Promise<Uint8Array | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    const start = Math.max(0, range.offset);
    const end = Math.min(object.bytes.byteLength, start + Math.max(0, range.length));
    return object.bytes.subarray(start, end);
  }

  async putObject(key: string, bytes: Uint8Array, opts: { contentType: string; sha256?: string }): Promise<void> {
    // Like R2: a write whose content does not hash to the stated sha256 is refused and stores nothing.
    if (opts.sha256 && createHash('sha256').update(bytes).digest('hex') !== opts.sha256) {
      throw new Error('checksum mismatch');
    }
    this.objects.set(key, { bytes, contentType: opts.contentType, uploaded: new Date() });
  }

  async listKeys(prefix: string, opts: { cursor?: string; limit?: number; startAfter?: string } = {}): Promise<StorageKeyPage> {
    const limit = Math.min(opts.limit ?? 1000, 1000);
    const all = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const after = opts.cursor ?? opts.startAfter;
    const start = after ? all.findIndex((k) => k > after) : 0;
    const page = start < 0 ? [] : all.slice(start, start + limit);
    const more = start >= 0 && start + limit < all.length;
    return {
      keys: page.map((key) => {
        const o = this.objects.get(key) as { bytes: Uint8Array; uploaded: Date };
        return { key, size: o.bytes.byteLength, uploaded: o.uploaded };
      }),
      ...(more ? { cursor: page[page.length - 1] } : {}),
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    // Mock implementation - in real tests this would track what was "deleted"
    console.log(`Mock: Deleting objects with prefix: ${prefix}`);
    for (const key of this.objects.keys()) {
      if (key.startsWith(prefix)) this.objects.delete(key);
    }
  }

  /** Test helper: seed an object directly, without going through upload(). */
  seed(key: string, bytes: Uint8Array, contentType = 'application/zip', uploaded: Date = new Date()): void {
    this.objects.set(key, { bytes, contentType, uploaded });
  }

  /** Test helper: every key currently held (sync-delta-upload asserts what was and was not stored). */
  keys(): string[] {
    return [...this.objects.keys()];
  }
}

async function toBytes(body: ReadableStream | Buffer): Promise<Uint8Array> {
  if (Buffer.isBuffer(body)) return new Uint8Array(body);
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
