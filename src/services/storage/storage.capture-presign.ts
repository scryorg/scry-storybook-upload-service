// Presigned PUT for Scry Snip capture renditions (feature snip-capture), shared by the Worker and
// Node storage services. Kept apart from the SCF bundle presign on purpose: that production path
// keeps the SDK defaults, this one signs the content headers and drops the default CRC32.
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { BlobPresignOptions, CapturePresignOptions } from './storage.service.js';

type S3Credentials = { accountId: string; accessKeyId: string; secretAccessKey: string };

/**
 * A client used only to presign capture PUTs. `requestChecksumCalculation: 'WHEN_REQUIRED'` stops
 * the SDK adding `x-amz-checksum-crc32=AAAAAA==` (the CRC32 of an empty body) and
 * `x-amz-sdk-checksum-algorithm` to the URL, which a store that enforces them answers with 400.
 */
export function createCapturePresignClient(config: S3Credentials): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
}

/** `content-type` and `content-length` are signed headers: R2 refuses a PUT that sends anything else. */
export async function presignCapturePut(
  s3: S3Client,
  bucket: string,
  key: string,
  opts: CapturePresignOptions
): Promise<{ url: string; key: string }> {
  const command = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: opts.contentType, ContentLength: opts.contentLength });
  const url = await getSignedUrl(s3, command, {
    expiresIn: opts.expiresIn,
    signableHeaders: new Set(['content-type', 'content-length']),
  });
  return { url, key };
}

/** SHA-256 hex (64 lowercase) to the base64 of the same 32 bytes, the form `x-amz-checksum-sha256` carries. */
export function sha256HexToBase64(hex: string): string {
  const bytes = Uint8Array.from(hex.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
  return btoa(String.fromCodePoint(...bytes));
}

/**
 * Presigned PUT for one delta picture (feature content-hash-identity, slice 2). `content-length`, `content-type` and
 * `x-amz-checksum-sha256` are SIGNED headers: R2 refuses a PUT whose length, type or checksum header differs from what was signed,
 * and R2 itself checks that the body hashes to the signed checksum. `header` is what the client must send, as given.
 */
export async function presignBlobPut(
  s3: S3Client,
  bucket: string,
  key: string,
  opts: BlobPresignOptions
): Promise<{ url: string; key: string; header: Record<string, string> }> {
  const checksum = sha256HexToBase64(opts.sha256Hex);
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: BLOB_CONTENT_TYPE,
    ContentLength: opts.contentLength,
    ChecksumSHA256: checksum,
  });
  const url = await getSignedUrl(s3, command, {
    expiresIn: opts.expiresIn,
    signableHeaders: new Set(['content-type', 'content-length', 'x-amz-checksum-sha256']),
    unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
  });
  return { url, key, header: { 'Content-Type': BLOB_CONTENT_TYPE, 'x-amz-checksum-sha256': checksum } };
}

const BLOB_CONTENT_TYPE = 'application/octet-stream';
