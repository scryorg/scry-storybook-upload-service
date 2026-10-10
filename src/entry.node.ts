// In src/entry.node.ts

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { app } from './app.js';
import { R2S3StorageService } from './services/storage/storage.node.js';
import { MockStorageService } from './services/storage/storage.mock.js';
import { FirestoreServiceNode } from './services/firestore/firestore.node.js';
import { ApiKeyServiceNode } from './services/apikey/apikey.node.js';
import type { AppEnv } from './app.js';
import type { StampBindings } from './deploy-stamp.js';
import admin from 'firebase-admin';

// This will be used if dotenv is configured for local development
import 'dotenv/config';

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  // Check if we should use service account file or environment variables
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // Use service account file (development mode)
    admin.initializeApp({
      credential: admin.credential.applicationDefault()
    });
  } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    // Use environment variables (production mode)
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
      })
    });
  } else {
    console.warn('WARNING: Firebase credentials not configured. Firestore functionality will be disabled.');
  }
}

// Define a type for the R2 configuration expected from environment variables.
type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
};

// Check if we're in test mode
const isTestMode = process.env.NODE_ENV === 'test';

// Gather all configuration from process.env.
// The '!' non-null assertion operator is used assuming these are required for the app to start.
// In a production app, robust validation (e.g., with Zod) would be added here.
const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  r2: isTestMode ? {
    // Use placeholder values for test mode
    accountId: 'test-account',
    accessKeyId: 'test-key',
    secretAccessKey: 'test-secret',
    bucketName: 'test-bucket',
  } : {
    accountId: process.env.R2_ACCOUNT_ID!,
    accessKeyId: process.env.R2_S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_S3_SECRET_ACCESS_KEY!,
    bucketName: process.env.R2_BUCKET_NAME!,
  },
};

// Basic validation to ensure the server doesn't start with missing configuration (except in test mode).
if (!isTestMode && Object.values(config.r2).some(v => !v)) {
  console.error("FATAL: Missing required R2 environment variables. Please check your .env file or environment configuration.");
  console.error("Required variables: R2_ACCOUNT_ID, R2_S3_ACCESS_KEY_ID, R2_S3_SECRET_ACCESS_KEY, R2_BUCKET_NAME");
  process.exit(1);
}

const nodeApp = new Hono<AppEnv>();

/**
 * This top-level middleware instantiates the Node.js-specific storage service
 * with configuration from environment variables and injects it into the context.
 */
nodeApp.use('*', async (c, next) => {
  const storageService = isTestMode
    ? new MockStorageService()
    : new R2S3StorageService(config.r2);
  c.set('storage', storageService);
  
  // Initialize Firestore and API Key services if Firebase is configured.
  //
  // In test mode we intentionally skip Firebase initialization to avoid requiring
  // real API keys / Firestore credentials for local/e2e runs.
  if (!isTestMode && admin.apps.length > 0) {
    const serviceAccountId = process.env.FIRESTORE_SERVICE_ACCOUNT_ID || 'upload-service';
    const firestoreService = new FirestoreServiceNode(serviceAccountId);
    c.set('firestore', firestoreService);
    
    // Initialize API Key service for authentication
    const apiKeyService = new ApiKeyServiceNode();
    c.set('apiKeyService', apiKeyService);
  }
  if (process.env.SCRY_UPLOAD_ASSERTION_SECRET) {
    c.set('assertionSecret', process.env.SCRY_UPLOAD_ASSERTION_SECRET);
  }
  if (process.env.CLEANUP_TOKEN) {
    c.set('cleanupToken', process.env.CLEANUP_TOKEN);
  }
  c.set('syncDelta', process.env.SYNC_DELTA === '1');
  
  await next();
});

// Mount the shared application routes.
nodeApp.route('/', app);

console.log(`Server is running on http://localhost:${config.port}${isTestMode ? ' (TEST MODE)' : ''}`);

// Use the serve adapter to start the Node.js server.
serve({
  fetch: (request) => nodeApp.fetch(request, {
    SCRY_ENV: process.env.SCRY_ENV as StampBindings['SCRY_ENV'],
    SCRY_SERVICE: process.env.SCRY_SERVICE,
    SCRY_COMMIT: process.env.SCRY_COMMIT,
    SCRY_BRANCH: process.env.SCRY_BRANCH,
    SCRY_BUILD_TIME: process.env.SCRY_BUILD_TIME,
    SCRY_DEPLOY_ID: process.env.SCRY_DEPLOY_ID,
    SCRY_ACTOR: process.env.SCRY_ACTOR,
  }),
  port: config.port,
});
