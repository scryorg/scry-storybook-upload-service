/**
 * Represents the status of an API key
 */
export type ApiKeyStatus = 'active' | 'revoked';

/**
 * Represents an API key document in Firestore
 * Stored at: projects/{projectId}/apiKeys/{keyId}
 */
export interface ApiKey {
  /**
   * Unique identifier for the key
   */
  id: string;

  /**
   * Human-readable name for the key (e.g., "CI/CD Key")
   */
  name: string;

  /**
   * First 12 characters of the raw key for identification (e.g., "scry_proj_ab")
   */
  prefix: string;

  /**
   * SHA-256 hash of the full raw key - raw key is NEVER stored
   */
  hash: string;

  /**
   * Current status of the key
   */
  status: ApiKeyStatus;

  /**
   * Timestamp when the key was created
   */
  createdAt: Date;

  /**
   * User ID who created the key
   */
  createdBy: string;

  /**
   * Timestamp of last successful authentication using this key
   */
  lastUsedAt?: Date;

  /**
   * Optional expiration timestamp
   */
  expiresAt?: Date;

  /**
   * Timestamp when the key was revoked (if applicable)
   */
  revokedAt?: Date;

  /**
   * User ID who revoked the key (if applicable)
   */
  revokedBy?: string;

  /**
   * scry-sync: what minted the key. `'device'` is a Scry Sync desktop key from the dashboard's
   * device sign-in; it may only upload bundles and revoke itself (guarantee-1). Absent on every
   * key minted before scry-sync, which keeps its existing rights.
   */
  kind?: string;
}

/**
 * Data required to create a new API key
 */
export interface CreateApiKeyData {
  /**
   * Human-readable name for the key
   */
  name: string;

  /**
   * User ID creating the key
   */
  createdBy: string;

  /**
   * Optional expiration date
   */
  expiresAt?: Date;
}

/**
 * Result of creating a new API key
 * Contains the raw key which should only be shown once
 */
export interface CreateApiKeyResult {
  /**
   * The created API key metadata (without the hash for security)
   */
  apiKey: Omit<ApiKey, 'hash'>;

  /**
   * The raw API key - ONLY returned on creation, never stored or retrievable again
   */
  rawKey: string;
}

/**
 * Data for validating an API key
 */
export interface ValidateApiKeyResult {
  /**
   * Whether the key is valid
   */
  valid: boolean;

  /**
   * The API key metadata if valid
   */
  apiKey?: Omit<ApiKey, 'hash'>;

  /**
   * Error message if invalid
   */
  error?: string;
}

/**
 * API key listing result (without sensitive hash data)
 */
export type ApiKeyListItem = Omit<ApiKey, 'hash'>;