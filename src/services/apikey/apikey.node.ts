import admin from 'firebase-admin';
import type { Firestore } from 'firebase-admin/firestore';
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
} from './apikey.utils.js';

/**
 * Node.js implementation of ApiKeyService using Firebase Admin SDK
 */
export class ApiKeyServiceNode implements ApiKeyService {
  private db: Firestore;

  constructor() {
    this.db = admin.firestore();
  }

  /**
   * Creates a new API key for a project
   */
  async createApiKey(
    projectId: string,
    data: CreateApiKeyData
  ): Promise<CreateApiKeyResult> {
    // Generate the raw key
    const rawKey = generateApiKey(projectId);
    
    // Hash the key for storage
    const hash = await hashApiKey(rawKey);
    
    // Get the prefix for identification
    const prefix = getKeyPrefix(rawKey);
    
    // Generate document ID
    const keyId = generateKeyId();
    
    // Create the key document
    const keyRef = this.db.doc(`projects/${projectId}/apiKeys/${keyId}`);
    const now = new Date();
    
    const keyDoc: Omit<ApiKey, 'id'> = {
      name: data.name,
      prefix,
      hash,
      status: 'active',
      createdAt: now,
      createdBy: data.createdBy,
      ...(data.expiresAt && { expiresAt: data.expiresAt }),
    };

    await keyRef.set({
      ...keyDoc,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      ...(data.expiresAt && { expiresAt: admin.firestore.Timestamp.fromDate(data.expiresAt) }),
    });

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

    // Hash the incoming key
    const hash = await hashApiKey(rawKey);

    // Query for matching active key
    const snapshot = await this.db
      .collection(`projects/${projectId}/apiKeys`)
      .where('hash', '==', hash)
      .where('status', '==', 'active')
      .limit(1)
      .get();

    if (snapshot.empty) {
      return {
        valid: false,
        error: 'Invalid or revoked API key',
      };
    }

    const doc = snapshot.docs[0];
    const data = doc.data();

    // Check expiration
    if (data.expiresAt) {
      const expiresAt = data.expiresAt.toDate();
      if (expiresAt < new Date()) {
        return {
          valid: false,
          error: 'API key has expired',
        };
      }
    }

    // Return valid result
    const apiKey: Omit<ApiKey, 'hash'> = {
      id: doc.id,
      name: data.name,
      prefix: data.prefix,
      status: data.status,
      createdAt: data.createdAt?.toDate() || new Date(),
      createdBy: data.createdBy,
      lastUsedAt: data.lastUsedAt?.toDate(),
      expiresAt: data.expiresAt?.toDate(),
      revokedAt: data.revokedAt?.toDate(),
      revokedBy: data.revokedBy,
      ...(typeof data.kind === 'string' && data.kind ? { kind: data.kind } : {}),
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
    const snapshot = await this.db
      .collection(`projects/${projectId}/apiKeys`)
      .orderBy('createdAt', 'desc')
      .get();

    return snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        name: data.name,
        prefix: data.prefix,
        status: data.status,
        createdAt: data.createdAt?.toDate() || new Date(),
        createdBy: data.createdBy,
        lastUsedAt: data.lastUsedAt?.toDate(),
        expiresAt: data.expiresAt?.toDate(),
        revokedAt: data.revokedAt?.toDate(),
        revokedBy: data.revokedBy,
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
    const keyRef = this.db.doc(`projects/${projectId}/apiKeys/${keyId}`);
    
    await keyRef.update({
      status: 'revoked',
      revokedAt: admin.firestore.FieldValue.serverTimestamp(),
      revokedBy: userId,
    });
  }

  /**
   * Deletes an API key permanently
   */
  async deleteApiKey(
    projectId: string,
    keyId: string
  ): Promise<void> {
    const keyRef = this.db.doc(`projects/${projectId}/apiKeys/${keyId}`);
    await keyRef.delete();
  }

  /**
   * Updates the lastUsedAt timestamp for an API key
   */
  async updateLastUsed(
    projectId: string,
    keyId: string
  ): Promise<void> {
    const keyRef = this.db.doc(`projects/${projectId}/apiKeys/${keyId}`);
    
    await keyRef.update({
      lastUsedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
}