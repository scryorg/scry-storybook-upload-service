import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createCapturePresignClient, presignCapturePut } from './storage.capture-presign.js';
import { StorageService, CapturePresignOptions, StorageObjectMeta, StorageObjectRange, UploadResult } from './storage.service.js';

// Define the shape of the configuration object, similar to the Node.js version.
type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
};

/**
 * A StorageService implementation for Cloudflare Workers that uses a hybrid approach:
 * - Native R2 bindings for efficient uploads initiated by the Worker.
 * - The S3 SDK for generating presigned URLs for client-side uploads.
 */
export class R2S3StorageService implements StorageService {
  private readonly bucket: R2Bucket;
  private readonly s3: S3Client;
  private readonly captureS3: S3Client;
  private readonly bucketName: string;
  private readonly publicUrlBase: string;

  /**
   * @param bucket The R2Bucket instance provided by the Cloudflare runtime.
   * @param config The R2 S3-compatible API configuration.
   */
  constructor(bucket: R2Bucket, config: R2Config) {
    this.bucket = bucket;
    this.bucketName = config.bucketName;
    this.s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    this.captureS3 = createCapturePresignClient(config);
    // This assumes a public bucket or a custom domain is configured.
    this.publicUrlBase = `https://pub-${config.bucketName}.${config.accountId}.r2.dev`;
  }

  /**
   * Uploads a file stream directly to the R2 bucket using the native binding.
   * This is efficient for uploads that are proxied through the Worker.
   */
  async upload(key: string, body: ReadableStream, contentType: string): Promise<UploadResult> {
    const object = await this.bucket.put(key, body, {
      httpMetadata: { contentType },
    });

    return {
      url: `${this.publicUrlBase}/${object.key}`,
      path: object.key,
      versionId: object.version,
    };
  }

  /**
   * Generates a presigned URL using the S3 API, allowing a client to upload directly to R2.
   */
  async getPresignedUploadUrl(key: string, contentType: string): Promise<{ url: string; key: string }> {
    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      ContentType: contentType,
    });

    const signedUrl = await getSignedUrl(this.s3, command, { expiresIn: 3600 }); // URL valid for 1 hour

    return { url: signedUrl, key: key };
  }

  /** Capture rendition PUT: signed content-type and content-length, short expiry, no default checksum. */
  getPresignedCaptureUploadUrl(key: string, opts: CapturePresignOptions): Promise<{ url: string; key: string }> {
    return presignCapturePut(this.captureS3, this.bucketName, key, opts);
  }

  /**
   * HEADs an object via the native R2 binding: size and content type, no body transfer.
   * Used by the bundle upload route (capture-sources) to size-check before reading.
   */
  async head(key: string): Promise<StorageObjectMeta | null> {
    const object = await this.bucket.head(key);
    if (!object) return null;
    return { size: object.size, contentType: object.httpMetadata?.contentType };
  }

  /**
   * Streams an object's body via the native R2 binding.
   */
  async getObjectStream(key: string): Promise<ReadableStream | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    return object.body;
  }

  /**
   * Reads a byte range of an object's body via the native R2 binding's own `range` option (ledger
   * F49) — no S3-compatible `Range` header needed, R2 supports this natively.
   */
  async getObjectRange(key: string, range: StorageObjectRange): Promise<Uint8Array | null> {
    if (range.length <= 0) return new Uint8Array(0);
    const object = await this.bucket.get(key, { range: { offset: range.offset, length: range.length } });
    if (!object) return null;
    return new Uint8Array(await object.arrayBuffer());
  }

  /**
   * Deletes a single object via the native R2 binding. A no-op if it does not exist
   * (R2's delete is idempotent).
   */
  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  /**
   * Deletes all objects with keys matching the given prefix using R2 bindings.
   * @param prefix The prefix to match object keys (e.g., 'project/version/').
   * @returns A promise that resolves when deletion is complete.
   */
  async deleteByPrefix(prefix: string): Promise<void> {
    let cursor: string | undefined;
    do {
      const list = await this.bucket.list({ prefix, cursor });
      
      if (list.objects.length > 0) {
        await this.bucket.delete(list.objects.map(obj => obj.key));
      }

      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
  }
}
