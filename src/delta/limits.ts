// Limits and constants for the delta upload routes (feature sync-delta-upload, guarantee G7).
// They match today's zip limits (src/bundle/bounded-zip.ts) so a library that fits the zip path fits here.

/** Pictures in one manifest (the SCF validator's own cap). */
export const MAX_PICTURES = 10_000;
/** The manifest request body: the scf.json plus the `images` map. */
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
/** One picture. */
export const MAX_BLOB_BYTES = 20 * 1024 * 1024;
/** Declared bytes of the pictures a build still has to receive. */
export const MAX_NEW_BYTES = 1024 * 1024 * 1024;

/** A build stays open this long after creation and after every accepted blob PUT. */
export const BUILD_DEADLINE_MS = 60 * 60 * 1000;
/** An Idempotency-Key record outlives its build deadline by a day (TTL policy on `expireAt`). */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** The only protocol and hash this server speaks; anything else is `400 unsupported_protocol`. */
export const PROTOCOL_VERSION = 1;
export const HASH_ALGORITHM = 'sha256';

/** Blobs older than this, and not referenced by a recent or latest build, are deleted by the daily clean-up (D2). */
export const BLOB_RETENTION_DAYS = 30;

export const SHA256_HEX = /^[0-9a-f]{64}$/;
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;
