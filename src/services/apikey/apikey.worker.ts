import type { ApiKeyService } from './apikey.service.js';
import type {
  ApiKey,
  CreateApiKeyData,
  CreateApiKeyResult,
  ValidateApiKeyResult,
  ApiKeyListItem,
} from './apikey.types.js';
import {
  generateApiKey,
  hashApiKey,
  getKeyPrefix,
  generateKeyId,
  isValidApiKeyFormat,
  readKeyKind,
} from './apikey.utils.js';
import { retryFetch } from '../../utils/firestore-retry.js';
import { exchangeJwtForAccessToken } from '../../utils/google-token.js';

interface ApiKeyWorkerConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

/**
 * A Firestore REST API "Value" wire object, narrowed to the variants this file's
 * key documents actually use (string/timestamp/boolean fields only — no nested
 * map/array values here, unlike firestore.worker.ts's build documents).
 */
interface FirestoreValue {
  booleanValue?: boolean;
  stringValue?: string;
  timestampValue?: string;
}

/** A Firestore REST document's `fields` map — also the shape every write body sends. */
type FirestoreFields = Record<string, FirestoreValue>;

/** A Firestore REST document, as returned by get/runQuery. */
interface FirestoreDocument {
  name: string;
  fields: FirestoreFields;
}

/** A Firestore REST `StructuredQuery`, narrowed to the shapes this file builds. */
interface FirestoreStructuredQuery {
  from: Array<{ collectionId: string }>;
  where?: {
    fieldFilter?: { field: { fieldPath: string }; op: string; value: FirestoreValue };
    compositeFilter?: {
      op: string;
      filters: Array<{ fieldFilter: { field: { fieldPath: string }; op: string; value: FirestoreValue } }>;
    };
  };
  limit?: number;
}

/** One element of a Firestore REST `runQuery` response body. */
interface FirestoreRunQueryResponseItem {
  document?: FirestoreDocument;
}

/**
 * Cloudflare Worker implementation of ApiKeyService using Firestore REST API
 * This implementation uses service account authentication via JWT tokens
 */
export class ApiKeyServiceWorker implements ApiKeyService {
  private config: ApiKeyWorkerConfig;
  private baseUrl: string;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;

  constructor(config: ApiKeyWorkerConfig) {
    this.config = config;
    this.baseUrl = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents`;
  }

  /**
   * Creates a new API key for a project
   */
  async createApiKey(
    projectId: string,
    data: CreateApiKeyData
  ): Promise<CreateApiKeyResult> {
    const token = await this.getAccessToken();
    
    // Generate the raw key
    const rawKey = generateApiKey(projectId);
    
    // Hash the key for storage
    const hash = await hashApiKey(rawKey);
    
    // Get the prefix for identification
    const prefix = getKeyPrefix(rawKey);
    
    // Generate document ID
    const keyId = generateKeyId();
    
    // Create the key document
    const now = new Date();
    const keyPath = `projects/${projectId}/apiKeys/${keyId}`;
    
    const keyDoc: FirestoreFields = {
      name: { stringValue: data.name },
      prefix: { stringValue: prefix },
      hash: { stringValue: hash },
      status: { stringValue: 'active' },
      createdAt: { timestampValue: now.toISOString() },
      createdBy: { stringValue: data.createdBy },
    };

    if (data.expiresAt) {
      keyDoc.expiresAt = { timestampValue: data.expiresAt.toISOString() };
    }

    await this.setDocument(keyPath, keyDoc, token);

    // Return the result with raw key (only time it's available)
    const apiKeyMetadata: Omit<ApiKey, 'hash'> = {
      id: keyId,
      name: data.name,
      prefix,
      status: 'active',
      createdAt: now,
      createdBy: data.createdBy,
      ...(data.expiresAt && { expiresAt: data.expiresAt }),
    };

    return {
      apiKey: apiKeyMetadata,
      rawKey,
    };
  }

  /**
   * Validates an API key and returns its metadata if valid
   */
  async validateApiKey(
    projectId: string,
    rawKey: string
  ): Promise<ValidateApiKeyResult> {
    // Validate key format
    if (!isValidApiKeyFormat(rawKey)) {
      return {
        valid: false,
        error: 'Invalid API key format',
      };
    }

    const token = await this.getAccessToken();
    
    // Hash the incoming key
    const hash = await hashApiKey(rawKey);

    // Query for matching active key
    const structuredQuery = {
      from: [{ collectionId: 'apiKeys' }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: [
            {
              fieldFilter: {
                field: { fieldPath: 'hash' },
                op: 'EQUAL',
                value: { stringValue: hash },
              },
            },
            {
              fieldFilter: {
                field: { fieldPath: 'status' },
                op: 'EQUAL',
                value: { stringValue: 'active' },
              },
            },
          ],
        },
      },
      limit: 1,
    };

    const docs = await this.queryDocuments(`projects/${projectId}`, structuredQuery, token);

    if (docs.length === 0) {
      return {
        valid: false,
        error: 'Invalid or revoked API key',
      };
    }

    const doc = docs[0];
    const fields = doc.fields;

    // Check expiration
    if (fields.expiresAt?.timestampValue) {
      const expiresAt = new Date(fields.expiresAt.timestampValue);
      if (expiresAt < new Date()) {
        return {
          valid: false,
          error: 'API key has expired',
        };
      }
    }

    // Extract document ID from the name
    const docId = doc.name.split('/').pop()!;

    const kind = readKeyKind('kind' in fields, fields.kind?.stringValue);

    // Return valid result
    const apiKey: Omit<ApiKey, 'hash'> = {
      id: docId,
      name: fields.name?.stringValue || '',
      prefix: fields.prefix?.stringValue || '',
      status: fields.status?.stringValue as 'active' | 'revoked' || 'active',
      createdAt: new Date(fields.createdAt?.timestampValue || new Date()),
      createdBy: fields.createdBy?.stringValue || '',
      lastUsedAt: fields.lastUsedAt?.timestampValue ? new Date(fields.lastUsedAt.timestampValue) : undefined,
      expiresAt: fields.expiresAt?.timestampValue ? new Date(fields.expiresAt.timestampValue) : undefined,
      revokedAt: fields.revokedAt?.timestampValue ? new Date(fields.revokedAt.timestampValue) : undefined,
      revokedBy: fields.revokedBy?.stringValue,
      // fail-closed (F39): a present `kind` is never dropped, whatever its type; only no field is a legacy key
      ...(kind === undefined ? {} : { kind }),
    };

    return {
      valid: true,
      apiKey,
    };
  }

  /**
   * Lists all API keys for a project (without hash data)
   */
  async listApiKeys(projectId: string): Promise<ApiKeyListItem[]> {
    const token = await this.getAccessToken();
    
    const structuredQuery = {
      from: [{ collectionId: 'apiKeys' }],
      orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }],
    };

    const docs = await this.queryDocuments(`projects/${projectId}`, structuredQuery, token);

    return docs.map((doc) => {
      const fields = doc.fields;
      const docId = doc.name.split('/').pop()!;
      
      return {
        id: docId,
        name: fields.name?.stringValue || '',
        prefix: fields.prefix?.stringValue || '',
        status: fields.status?.stringValue as 'active' | 'revoked' || 'active',
        createdAt: new Date(fields.createdAt?.timestampValue || new Date()),
        createdBy: fields.createdBy?.stringValue || '',
        lastUsedAt: fields.lastUsedAt?.timestampValue ? new Date(fields.lastUsedAt.timestampValue) : undefined,
        expiresAt: fields.expiresAt?.timestampValue ? new Date(fields.expiresAt.timestampValue) : undefined,
        revokedAt: fields.revokedAt?.timestampValue ? new Date(fields.revokedAt.timestampValue) : undefined,
        revokedBy: fields.revokedBy?.stringValue,
      };
    });
  }

  /**
   * Revokes an API key
   */
  async revokeApiKey(
    projectId: string,
    keyId: string,
    userId: string
  ): Promise<void> {
    const token = await this.getAccessToken();
    const keyPath = `projects/${projectId}/apiKeys/${keyId}`;
    
    const fields = {
      status: { stringValue: 'revoked' },
      revokedAt: { timestampValue: new Date().toISOString() },
      revokedBy: { stringValue: userId },
    };

    await this.patchDocument(keyPath, fields, token);
  }

  /**
   * Deletes an API key permanently
   */
  async deleteApiKey(
    projectId: string,
    keyId: string
  ): Promise<void> {
    const token = await this.getAccessToken();
    const keyPath = `projects/${projectId}/apiKeys/${keyId}`;
    
    const url = `${this.baseUrl}/${keyPath}`;
    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to delete API key: ${response.statusText}`);
    }
  }

  /**
   * Updates the lastUsedAt timestamp for an API key
   */
  async updateLastUsed(
    projectId: string,
    keyId: string
  ): Promise<void> {
    const token = await this.getAccessToken();
    const keyPath = `projects/${projectId}/apiKeys/${keyId}`;
    
    const fields = {
      lastUsedAt: { timestampValue: new Date().toISOString() },
    };

    await this.patchDocument(keyPath, fields, token);
  }

  /**
   * Helper methods for Firestore REST API operations
   */

  // Idempotent write: every field here is a fixed value the caller already
  // computed (never a Firestore increment transform), so resending the same
  // PATCH on a transient failure is safe. Retried on 429/503/500/network (F85).
  private async setDocument(path: string, fields: FirestoreFields, token: string): Promise<void> {
    const url = `${this.baseUrl}/${path}`;
    const response = await retryFetch(() => fetch(url, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields }),
    }), { op: 'setDocument' });

    if (!response.ok) {
      throw new Error(`Failed to set document: ${response.statusText}`);
    }
  }

  // Idempotent write, same reasoning as setDocument above. Retried on 429/503/500/network (F85).
  private async patchDocument(path: string, fields: FirestoreFields, token: string): Promise<void> {
    const url = `${this.baseUrl}/${path}`;
    const fieldKeys = Object.keys(fields);
    // F9 (upload-provenance-updatemask security review): a PATCH with NO updateMask.fieldPaths
    // param at all is a full-document replace per Firestore's REST contract, not a no-op -- fail
    // closed instead of ever sending that request. Every current caller passes >=1 field.
    if (fieldKeys.length === 0) {
      throw new Error(
        `patchDocument() called with an empty update mask for "${path}" -- refusing to send a ` +
        'mask-less Firestore PATCH, which Firestore treats as a full-document replace (F9)'
      );
    }
    // One `updateMask.fieldPaths` param per field; a comma-joined value is one invalid path (F73/F84).
    const params = new URLSearchParams();
    for (const key of fieldKeys) {
      params.append('updateMask.fieldPaths', /^[A-Za-z_]\w*$/.test(key) ? key : `\`${key.replace(/`/g, '\\`')}\``);
    }

    const response = await retryFetch(() => fetch(`${url}?${params.toString()}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields }),
    }), { op: 'patchDocument' });

    if (!response.ok) {
      throw new Error(`Failed to patch document: ${response.statusText}`);
    }
  }

  // Idempotent read: retried on 429/503/500/network (F85/F86 — this is the
  // validateApiKey query that 500'd the whole presign route for 7+ minutes
  // straight on stage without retrying).
  private async queryDocuments(parent: string, structuredQuery: FirestoreStructuredQuery, token: string): Promise<FirestoreDocument[]> {
    const url = `${this.baseUrl}/${parent}:runQuery`;
    const response = await retryFetch(() => fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ structuredQuery }),
    }), { op: 'runQuery' });

    if (!response.ok) {
      throw new Error(`Failed to query documents: ${response.statusText}`);
    }

    const results = await response.json() as FirestoreRunQueryResponseItem[];
    return results.flatMap((r) => (r.document ? [r.document] : []));
  }

  /**
   * Generate access token using service account credentials
   */
  private tokenInFlight: Promise<string> | null = null;

  private async getAccessToken(): Promise<string> {
    // Check if we have a valid cached token
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    // One in-flight exchange per isolate: a burst of concurrent requests shares it (F145).
    this.tokenInFlight ??= (async () => {
      const jwt = await this.createJWT();
      const t = await exchangeJwtForAccessToken(jwt);
      this.accessToken = t.accessToken;
      this.tokenExpiry = t.expiresAtMs;
      return t.accessToken;
    })().finally(() => {
      this.tokenInFlight = null;
    });
    return this.tokenInFlight;
  }

  /**
   * Create JWT token for service account authentication
   */
  private async createJWT(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      iss: this.config.clientEmail,
      sub: this.config.clientEmail,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
      scope: 'https://www.googleapis.com/auth/datastore',
    };

    const encodedHeader = this.base64UrlEncode(JSON.stringify(header));
    const encodedPayload = this.base64UrlEncode(JSON.stringify(payload));
    const unsignedToken = `${encodedHeader}.${encodedPayload}`;

    // Sign with private key
    const signature = await this.signJWT(unsignedToken, this.config.privateKey);
    return `${unsignedToken}.${signature}`;
  }

  /**
   * Sign JWT using RSA-SHA256
   */
  private async signJWT(data: string, privateKey: string): Promise<string> {
    // Handle both literal \n and actual newlines in the private key
    const trimmedKey = privateKey.trim();
    const unquotedKey = trimmedKey
      .replace(/^"(.*)"$/, '$1')
      .replace(/^'(.*)'$/, '$1');
    const cleanedKey = unquotedKey.replace(/\\n/g, '\n');
    
    const pemHeader = '-----BEGIN PRIVATE KEY-----';
    const pemFooter = '-----END PRIVATE KEY-----';
    
    // Extract the content between the header and footer
    const pemContents = cleanedKey
      .replace(pemHeader, '')
      .replace(pemFooter, '')
      .replace(/\s/g, ''); // Remove all whitespace including newlines
    
    const binaryKey = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
    
    const cryptoKey = await crypto.subtle.importKey(
      'pkcs8',
      binaryKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );

    // Sign the data
    const encoder = new TextEncoder();
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      encoder.encode(data)
    );

    return this.base64UrlEncode(signature);
  }

  /**
   * Base64 URL encode
   */
  private base64UrlEncode(data: string | ArrayBuffer): string {
    let base64: string;
    
    if (typeof data === 'string') {
      base64 = btoa(data);
    } else {
      const bytes = new Uint8Array(data);
      const binary = String.fromCharCode(...bytes);
      base64 = btoa(binary);
    }
    
    const unpadded = base64.replace(/\+/g, '-').replace(/\//g, '_');
    // Strip trailing '=' padding without a `=+$`-shaped regex (sonarjs/super-linear-regex):
    // a hand-rolled scan is O(n) with no backtracking, unlike a trailing-quantifier regex.
    let end = unpadded.length;
    while (end > 0 && unpadded[end - 1] === '=') end--;
    return unpadded.slice(0, end);
  }
}
