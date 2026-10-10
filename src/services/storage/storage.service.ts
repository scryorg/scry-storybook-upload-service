/**
 * Represents the result of a successful file upload operation.
 */
export interface UploadResult {
  /**
   * A publicly accessible or internal URL to the uploaded object.
   */
  url: string;
  /**
   * The full path (key) of the object within the storage bucket.
   */
  path: string;
  /**
   * The version ID of the object, if versioning is enabled.
   */
  versionId?: string;
}

/**
 * Metadata returned by a HEAD check, without downloading the object body.
 */
export interface CapturePresignOptions {
  contentType: string;
  /** Exact body length the PUT must carry. */
  contentLength: number;
  /** Seconds the URL stays valid. */
  expiresIn: number;
}

export interface StorageObjectMeta {
  size: number;
  contentType?: string;
}

/** One entry of a prefix listing (sync-delta-upload: the `_blobs/` existence check and the clean-up pass). */
export interface StorageListedKey {
  key: string;
  size: number;
  /** When the object was written; the clean-up pass only deletes objects older than its retention. */
  uploaded: Date;
}

export interface StorageKeyPage {
  keys: StorageListedKey[];
  /** Present when more keys follow; pass it back as `cursor`. */
  cursor?: string;
}

/**
 * A byte range to read from an object, relative to its start. Used by the capture-sources bundle
 * route (ledger F49) to read just a ZIP's tail (its end-of-central-directory record, then its
 * central directory) before ever opening a full stream over the — potentially huge — rest of it.
 */
export interface StorageObjectRange {
  /** 0-based byte offset from the start of the object. */
  offset: number;
  /** Number of bytes to read, starting at `offset`. An implementation clamps this to whatever is
   *  actually left in the object rather than erroring — a caller that already knows the object's
   *  real size (every caller here does, from a prior `head()`) never needs to ask for more than
   *  what's left, but a shorter response is never treated as a failure on its own. */
  length: number;
}

/**
 * Defines the contract for all storage operations within the application.
 * Any class implementing this interface can be used as the storage backend.
 */
export interface StorageService {
  /**
   * Uploads a file to the storage backend.
   * @param key The destination key (path) for the object.
   * @param body The content of the file as a ReadableStream or Buffer.
   * @param contentType The MIME type of the file.
   * @returns A promise that resolves to an UploadResult.
   */
  upload(key: string, body: ReadableStream | Buffer, contentType: string): Promise<UploadResult>;

  /**
   * Generates a presigned URL that allows a client to upload a file directly.
   * @param key The destination key (path) for the object.
   * @param contentType The expected MIME type of the file.
   * @returns A promise that resolves to an object containing the upload URL and the final key.
   */
  getPresignedUploadUrl(key: string, contentType: string): Promise<{ url: string; key: string }>;

  /**
   * Presigned PUT for a Scry Snip capture rendition (feature snip-capture). Stricter than
   * `getPresignedUploadUrl`: `content-type` and `content-length` are SIGNED, so R2 refuses a PUT whose
   * type or length differs, the URL is short-lived, and it carries no `x-amz-checksum-*` query
   * parameters (the SDK default would add the CRC32 of an empty body). The SCF bundle presign above
   * is deliberately unchanged.
   */
  getPresignedCaptureUploadUrl(key: string, opts: CapturePresignOptions): Promise<{ url: string; key: string }>;

  /**
   * HEADs an object: its size and content type, without downloading the body.
   * Used to size-check an upload (capture-sources bundle route) before reading it.
   * @returns The object's metadata, or null if it does not exist.
   */
  head(key: string): Promise<StorageObjectMeta | null>;

  /**
   * Streams an object's body.
   * @returns The object's body as a web ReadableStream, or null if it does not exist.
   */
  getObjectStream(key: string): Promise<ReadableStream | null>;

  /**
   * Reads a byte range of an object's body, without downloading the whole object (ledger F49).
   * @returns exactly the bytes in `[range.offset, range.offset + range.length)` (fewer, if the
   *   object is shorter than that), or `null` if the object does not exist.
   */
  getObjectRange(key: string, range: StorageObjectRange): Promise<Uint8Array | null>;

  /**
   * Writes a small object from bytes already in memory (sync-delta-upload blobs, manifests). When
   * `sha256` (lowercase hex) is given the store also verifies it, so a corrupted write stores nothing.
   */
  putObject(key: string, bytes: Uint8Array, opts: { contentType: string; sha256?: string }): Promise<void>;

  /**
   * Lists one page of keys under `prefix`, in key order, with size and write time.
   * `limit` is at most 1000 (the R2 page size). `startAfter` (a full key, exclusive) starts the listing after that key, so a
   * caller can jump over a stretch it does not need; `cursor` wins when both are given.
   */
  listKeys(prefix: string, opts?: { cursor?: string; limit?: number; startAfter?: string }): Promise<StorageKeyPage>;

  /**
   * Deletes a single object. A no-op if it does not already exist.
   * @param key The object's key.
   */
  delete(key: string): Promise<void>;

  /**
   * Deletes all objects with keys matching the given prefix.
   * @param prefix The prefix to match object keys (e.g., 'project/version/').
   * @returns A promise that resolves when deletion is complete.
   */
  deleteByPrefix(prefix: string): Promise<void>;
}
