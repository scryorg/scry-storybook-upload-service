// In src/services/storage/storage.node.ts

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Upload } from '@aws-sdk/lib-storage';
import { StorageService, StorageObjectMeta, StorageObjectRange, UploadResult } from './storage.service.js';
import { Readable } from 'stream';

/** True for the S3/R2 "not found" errors both HeadObject and GetObject can throw. */
function isNotFoundError(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

// Define the shape of the configuration object.
type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
};

/**
 * A StorageService implementation that uses the AWS S3 SDK v3
 * to communicate with Cloudflare R2's S3-compatible API.
 */
export class R2S3StorageService implements StorageService {
  private readonly s3: S3Client;
  private readonly bucketName: string;
  private readonly publicUrlBase: string;

  constructor(config: R2Config) {
    this.s3 = new S3Client({
      region: 'auto', // This is a required value for R2.
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    this.bucketName = config.bucketName;
    // This assumes a public bucket or a custom domain is configured for serving assets.
    this.publicUrlBase = `https://pub-${config.bucketName}.${config.accountId}.r2.dev`;
  }

  /**
   * Uploads a file to R2 using the S3 SDK. It handles both Buffers and ReadableStreams.
   */
  async upload(key: string, body: Buffer | ReadableStream, contentType: string): Promise<UploadResult> {
    const upload = new Upload({
      client: this.s3,
      params: {
        Bucket: this.bucketName,
        Key: key,
        Body: body,
        ContentType: contentType,
      },
    });

    const result = await upload.done();

    return {
      url: `${this.publicUrlBase}/${key}`,
      path: key,
      versionId: result.VersionId,
    };
  }

  /**
   * Generates a presigned URL for direct client-side uploads.
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

  /**
   * HEADs an object via the S3-compatible API: size and content type, no body transfer.
   * Used by the bundle upload route (capture-sources) to size-check before reading.
   */
  async head(key: string): Promise<StorageObjectMeta | null> {
    try {
      const result = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucketName, Key: key }));
      return { size: result.ContentLength ?? 0, contentType: result.ContentType };
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  /**
   * Streams an object's body via the S3-compatible API, normalized to a web ReadableStream
   * (the SDK's response body is a Node Readable in this runtime).
   */
  async getObjectStream(key: string): Promise<ReadableStream | null> {
    try {
      const result = await this.s3.send(new GetObjectCommand({ Bucket: this.bucketName, Key: key }));
      const body = result.Body as (Readable & { transformToWebStream?: () => ReadableStream }) | undefined;
      if (!body) return null;
      if (typeof body.transformToWebStream === 'function') return body.transformToWebStream();
      return Readable.toWeb(body) as unknown as ReadableStream;
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  /**
   * Reads a byte range of an object's body via the S3-compatible API's standard `Range` header
   * (ledger F49) — R2's S3-compatible endpoint supports byte ranges the same way S3 does.
   */
  async getObjectRange(key: string, range: StorageObjectRange): Promise<Uint8Array | null> {
    if (range.length <= 0) return new Uint8Array(0);
    try {
      const end = range.offset + range.length - 1;
      const result = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucketName, Key: key, Range: `bytes=${range.offset}-${end}` })
      );
      if (!result.Body) return null;
      return await result.Body.transformToByteArray();
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  /**
   * Deletes a single object. A no-op if it does not exist.
   */
  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: key }));
  }

  /**
   * Deletes all objects with keys matching the given prefix.
   * @param prefix The prefix to match object keys (e.g., 'project/version/').
   * @returns A promise that resolves when deletion is complete.
   */
  async deleteByPrefix(prefix: string): Promise<void> {
    let continuationToken: string | undefined;
    do {
      const listCommand = new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      });

      const listResult = await this.s3.send(listCommand);

      if (listResult.Contents && listResult.Contents.length > 0) {
        const deleteParams = {
          Bucket: this.bucketName,
          Delete: {
            Objects: listResult.Contents.map(obj => ({ Key: obj.Key })),
            Quiet: true,
          },
        };

        const deleteCommand = new DeleteObjectsCommand(deleteParams);
        await this.s3.send(deleteCommand);
      }

      continuationToken = listResult.NextContinuationToken;
    } while (continuationToken);
  }
}
