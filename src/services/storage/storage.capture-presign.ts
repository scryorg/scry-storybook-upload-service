// Presigned PUT for Scry Snip capture renditions (feature snip-capture), shared by the Worker and
// Node storage services. Kept apart from the SCF bundle presign on purpose: that production path
// keeps the SDK defaults, this one signs the content headers and drops the default CRC32.
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { CapturePresignOptions } from './storage.service.js';

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
