/**
 * Minimal, dependency-free, synchronous SHA-256 (FIPS 180-4).
 *
 * `storageKey()` needs a synchronous hash that works identically in Node and in a Cloudflare Worker
 * without a runtime dependency. `node:crypto` is Node-only and the Web Crypto `subtle.digest` API is
 * async-only, so neither fits. This implementation is verified against the standard test vectors in
 * test/sha256.test.ts.
 */
/** SHA-256 digest of `data`, returned as 32 raw bytes. */
export declare function sha256(data: Uint8Array): Uint8Array;
/** SHA-256 digest of `data`, returned as a lowercase hex string. */
export declare function sha256Hex(data: Uint8Array): string;
//# sourceMappingURL=sha256.d.ts.map