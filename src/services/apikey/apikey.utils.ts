/**
 * API Key Utilities
 * 
 * Provides functions for generating secure API keys and hashing them.
 * Uses Web Crypto API for compatibility with both Node.js and Cloudflare Workers.
 */

/**
 * API key format: scry_proj_{projectId}_{randomString}
 * - Prefix: scry_proj_
 * - Project ID: Ensures keys are scoped to a specific project
 * - Random: 32 bytes of random data (base62 encoded)
 */
const KEY_PREFIX = 'scry_proj_';

/**
 * Base62 character set for encoding
 */
const BASE62_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Converts a Uint8Array to a base62 encoded string
 */
function toBase62(bytes: Uint8Array): string {
  let result = '';
  let carry = 0;
  
  // Simple base conversion - treat bytes as a large number
  for (const byte of bytes) {
    carry = carry * 256 + byte;
    while (carry >= 62) {
      result += BASE62_CHARS[carry % 62];
      carry = Math.floor(carry / 62);
    }
  }
  
  if (carry > 0 || result.length === 0) {
    result += BASE62_CHARS[carry];
  }
  
  return result;
}

/**
 * Generates a cryptographically secure random string
 * @param length Number of random bytes to generate
 * @returns Base62 encoded random string
 */
export function generateRandomString(length: number = 32): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return toBase62(bytes);
}

/**
 * Generates a new API key for a project
 * @param projectId The project identifier
 * @returns The raw API key string
 */
export function generateApiKey(projectId: string): string {
  const randomPart = generateRandomString(32);
  return `${KEY_PREFIX}${projectId}_${randomPart}`;
}

/**
 * Extracts the project ID from an API key
 * @param apiKey The raw API key
 * @returns The project ID or null if invalid format
 */
export function extractProjectIdFromKey(apiKey: string): string | null {
  if (!apiKey.startsWith(KEY_PREFIX)) {
    return null;
  }
  
  const withoutPrefix = apiKey.slice(KEY_PREFIX.length);
  const underscoreIndex = withoutPrefix.indexOf('_');
  
  if (underscoreIndex === -1) {
    return null;
  }
  
  return withoutPrefix.slice(0, underscoreIndex);
}

/**
 * Gets the prefix portion of an API key (first 12 characters after scry_proj_)
 * Used for identification without exposing the full key
 * @param apiKey The raw API key
 * @returns The prefix string (e.g., "scry_proj_ab")
 */
export function getKeyPrefix(apiKey: string): string {
  return apiKey.slice(0, 12);
}

/**
 * Hashes an API key using SHA-256
 * Uses Web Crypto API for cross-platform compatibility
 * @param apiKey The raw API key to hash
 * @returns Hex-encoded SHA-256 hash
 */
export async function hashApiKey(apiKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(apiKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Validates the format of an API key
 * @param apiKey The API key to validate
 * @returns true if the key has valid format
 */
export function isValidApiKeyFormat(apiKey: string): boolean {
  if (!apiKey || typeof apiKey !== 'string') {
    return false;
  }
  
  if (!apiKey.startsWith(KEY_PREFIX)) {
    return false;
  }
  
  const withoutPrefix = apiKey.slice(KEY_PREFIX.length);
  const parts = withoutPrefix.split('_');
  
  // Should have at least project ID and random part
  if (parts.length < 2) {
    return false;
  }
  
  // Project ID should not be empty
  const projectId = parts[0];
  if (!projectId || projectId.length === 0) {
    return false;
  }
  
  // Random part should exist and be reasonably long
  const randomPart = parts.slice(1).join('_');
  if (!randomPart || randomPart.length < 16) {
    return false;
  }
  
  return true;
}

/**
 * Generates a unique ID for an API key document
 * @returns A random 20-character string suitable for Firestore document IDs
 */
export function generateKeyId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let id = '';
  for (let i = 0; i < 20; i++) {
    id += chars[bytes[i] % chars.length];
  }
  return id;
}
/**
 * What `kind` a key document with an unreadable `kind` is given. Any value is restricted (see
 * `isRestrictedKeyKind` in middleware/auth.ts); this one names the cause in logs and tests.
 */
export const UNRECOGNISED_KEY_KIND = 'unrecognised';

/**
 * scry-sync fail-closed (ledger F39): the key's `kind` as the services hand it on. A document with
 * no `kind` field yields `undefined` (a legacy key, unchanged). A document with the field present
 * always yields a non-empty string: the stored string when it is one, else UNRECOGNISED_KEY_KIND
 * (a non-string, null or empty value). The caller never sees "present" collapsed into "absent",
 * so a mis-typed `kind` can not turn a device key into an unrestricted one.
 */
export function readKeyKind(present: boolean, raw: unknown): string | undefined {
  if (!present) return undefined;
  return typeof raw === 'string' && raw.length > 0 ? raw : UNRECOGNISED_KEY_KIND;
}
