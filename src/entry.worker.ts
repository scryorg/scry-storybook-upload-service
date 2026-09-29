// In src/entry.worker.ts

import * as Sentry from '@sentry/cloudflare';
import { scrubEvent } from './sentry-scrub.js';
import { Hono } from 'hono';
import { app } from './app';
import { R2S3StorageService } from './services/storage/storage.worker';
import { MockStorageService } from './services/storage/storage.mock';
import { FirestoreServiceWorker } from './services/firestore/firestore.worker';
import { ApiKeyServiceWorker } from './services/apikey/apikey.worker';
import type { AppEnv } from './app';
import type { StampBindings } from './deploy-stamp.js';
import { sweepOrphanBundleBuilds, bundleZipKey, type OrphanSweepStore } from './bundle/orphan-sweep.js';
import type { StorageService } from './services/storage/storage.service.js';

/**
 * Defines the specific Cloudflare Bindings expected by this Worker.
 * This provides type safety for c.env.
 */
type Bindings = StampBindings & {
  // This binding provides access to the R2 bucket for storybooks.
  STORYBOOK_BUCKET: R2Bucket;

  // These are the secrets required for the S3-compatible API.
  // They should be set in the wrangler.toml or via the Cloudflare dashboard.
  R2_ACCOUNT_ID: string;
  R2_S3_ACCESS_KEY_ID: string;
  R2_S3_SECRET_ACCESS_KEY: string;
  R2_BUCKET_NAME: string;

  // Firebase/Firestore configuration
  FIREBASE_PROJECT_ID?: string;
  FIREBASE_CLIENT_EMAIL?: string;
  FIREBASE_PRIVATE_KEY?: string;
  FIRESTORE_SERVICE_ACCOUNT_ID?: string;

  // Sentry configuration
  SENTRY_DSN?: string;
  /** Optional. Defaults to 1.0 — see below. */
  SENTRY_TRACES_SAMPLE_RATE?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_RELEASE?: string;

  // Build processing queue
  BUILD_PROCESSING_QUEUE?: Queue;
  // Environment variable to detect test mode
  NODE_ENV?: string;

  // Shared secret used to authorize cleanup requests.
  CLEANUP_TOKEN?: string;
};

// Create a new Hono instance specifically for the Worker, extending the shared AppEnv.
const workerApp = new Hono<AppEnv & { Bindings: Bindings }>();

/**
 * This top-level middleware is executed for every request.
 * It instantiates the Worker-specific storage service using the R2 binding
 * and S3 credentials from the environment, then injects it into the context.
 */
workerApp.use('*', async (c, next) => {
  // Health reports deployment identity without depending on storage credentials.
  if (c.req.path === '/health' || c.req.path === '/healthz') {
    return next();
  }

  // Check if we're in test mode
  const isTestMode = c.env.NODE_ENV === 'test';
  
  let storageService;
  
  if (isTestMode) {
    // Use mock storage service for testing
    storageService = new MockStorageService();
  } else {
    // Validate R2 credentials are properly configured
    const accessKeyId = c.env.R2_S3_ACCESS_KEY_ID;
    const secretAccessKey = c.env.R2_S3_SECRET_ACCESS_KEY;
    const accountId = c.env.R2_ACCOUNT_ID;
    const bucketName = c.env.R2_BUCKET_NAME;
    
    // R2 access key IDs should be exactly 32 characters
    if (accessKeyId && accessKeyId.length !== 32) {
      console.error(`[CONFIG ERROR] R2_S3_ACCESS_KEY_ID has length ${accessKeyId.length}, should be 32. ` +
        `This usually means the secret was not properly set via 'wrangler secret put R2_S3_ACCESS_KEY_ID'. ` +
        `Check if placeholder values in wrangler.toml are overriding secrets.`);
    }
    
    // Log config status (without revealing sensitive values)
    console.log('[INFO] R2 Config Status:', {
      hasAccountId: !!accountId,
      accountIdLength: accountId?.length,
      hasAccessKeyId: !!accessKeyId,
      accessKeyIdLength: accessKeyId?.length,
      hasSecretAccessKey: !!secretAccessKey,
      hasBucketName: !!bucketName,
      hasBucketBinding: !!c.env.STORYBOOK_BUCKET,
    });

    if (!accountId || !bucketName || !accessKeyId || !secretAccessKey) {
      console.error('[CONFIG ERROR] Missing required R2 configuration for presigned URLs.', {
        hasAccountId: !!accountId,
        hasBucketName: !!bucketName,
        hasAccessKeyId: !!accessKeyId,
        hasSecretAccessKey: !!secretAccessKey,
      });
      throw new Error('Missing required R2 configuration. Ensure R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_S3_ACCESS_KEY_ID, and R2_S3_SECRET_ACCESS_KEY are set.');
    }
    
    // Assemble the configuration for the S3 client from environment variables.
    const r2Config = {
      accountId: accountId,
      accessKeyId: accessKeyId,
      secretAccessKey: secretAccessKey,
      bucketName: bucketName,
    };

    // Instantiate the hybrid storage service with both the native binding and the S3 config.
    storageService = new R2S3StorageService(c.env.STORYBOOK_BUCKET, r2Config);
  }

  // Place the service instance into the context for downstream handlers.
  c.set('storage', storageService);
  
  // Initialize Firestore and API Key services if Firebase credentials are configured.
  //
  // For local/e2e test mode we intentionally skip Firebase initialization to avoid
  // requiring real API keys / Firestore credentials in automated tests.
  if (!isTestMode && c.env.FIREBASE_PROJECT_ID && c.env.FIREBASE_CLIENT_EMAIL && c.env.FIREBASE_PRIVATE_KEY) {
    const firestoreConfig = {
      projectId: c.env.FIREBASE_PROJECT_ID,
      clientEmail: c.env.FIREBASE_CLIENT_EMAIL,
      privateKey: c.env.FIREBASE_PRIVATE_KEY,
      serviceAccountId: c.env.FIRESTORE_SERVICE_ACCOUNT_ID || 'upload-service'
    };
    const firestoreService = new FirestoreServiceWorker(firestoreConfig);
    c.set('firestore', firestoreService);
    
    // Initialize API Key service for authentication
    const apiKeyConfig = {
      projectId: c.env.FIREBASE_PROJECT_ID,
      clientEmail: c.env.FIREBASE_CLIENT_EMAIL,
      privateKey: c.env.FIREBASE_PRIVATE_KEY
    };
    const apiKeyService = new ApiKeyServiceWorker(apiKeyConfig);
    c.set('apiKeyService', apiKeyService);
  }

  // Inject processing queue if available
  if (c.env.BUILD_PROCESSING_QUEUE) {
    c.set('processingQueue', c.env.BUILD_PROCESSING_QUEUE);
  }
  if (c.env.CLEANUP_TOKEN) {
    c.set('cleanupToken', c.env.CLEANUP_TOKEN);
  }

  await next();
});

// Mount the shared application routes onto the worker-specific app.
workerApp.route('/', app);

/**
 * The base handler that processes requests through the Hono app.
 * This is wrapped by Sentry for error tracking and performance monitoring.
 */
const handler: ExportedHandler<Bindings> = {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    return workerApp.fetch(request, env, ctx);
  },

  // Cron (wrangler.toml `[triggers]`, ledger F80). A bundle build whose `/bundle/complete` call
  // never arrives is never touched again by anything else in this service — there is no in-flight
  // invocation to time out and nothing queued to retry, just a Firestore document that looks
  // "just created" forever. Only something running on its own schedule can notice that.
  async scheduled(_controller: ScheduledController, env: Bindings): Promise<void> {
    await runOrphanBundleSweep(env);
  },
};

/**
 * Sweep for bundle builds whose upload never completed and mark them `failed` (ledger F80).
 *
 * Same storage-service selection as the request middleware above (mock in test mode, the real
 * hybrid R2/S3 service otherwise) — the sweep only ever calls `head()`, which the native R2 binding
 * serves directly, so the S3-signing credentials it also takes are unused here but harmless to pass
 * through unset.
 */
async function runOrphanBundleSweep(env: Bindings) {
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
    console.warn('[ORPHAN] Firestore not configured; skipping orphan-bundle sweep');
    return;
  }

  try {
    const firestore = new FirestoreServiceWorker({
      projectId: env.FIREBASE_PROJECT_ID,
      clientEmail: env.FIREBASE_CLIENT_EMAIL,
      privateKey: env.FIREBASE_PRIVATE_KEY,
      serviceAccountId: env.FIRESTORE_SERVICE_ACCOUNT_ID || 'upload-service',
    });

    const isTestMode = env.NODE_ENV === 'test';
    const storage: StorageService = isTestMode
      ? new MockStorageService()
      : new R2S3StorageService(env.STORYBOOK_BUCKET, {
          accountId: env.R2_ACCOUNT_ID,
          accessKeyId: env.R2_S3_ACCESS_KEY_ID,
          secretAccessKey: env.R2_S3_SECRET_ACCESS_KEY,
          bucketName: env.R2_BUCKET_NAME,
        });

    const store: OrphanSweepStore = {
      listProjectIds: (limit) => firestore.listProjectIds(limit),
      findCandidates: (projectId, cutoff, limit) =>
        firestore.findOrphanBundleCandidates(projectId, cutoff, limit),
      bundleObjectExists: async (candidate) => (await storage.head(bundleZipKey(candidate))) !== null,
      markUploadNeverCompleted: (candidate) =>
        firestore.updateBuild(candidate.projectId, candidate.buildId, {
          processingStatus: 'failed',
          processingError: 'upload never completed',
        }),
    };

    await sweepOrphanBundleBuilds(store);
  } catch (error) {
    // A sweep that cannot run is itself a silent failure — report it and rethrow so the platform
    // records the cron invocation as failed (mirrors the sibling stall-detector's same rule).
    console.error('[ORPHAN] Sweep failed:', error);
    Sentry.captureException(error, { tags: { path: 'cron', kind: 'orphan-bundle-sweep' } });
    throw error;
  }
}

/** Sentry options, exported for tests (the tier → environment mapping). */
export function sentryOptions(env: Bindings) {
  return {
    dsn: env.SENTRY_DSN,
    // The tier (observability-request-id): SCRY_ENV is set on every wrangler
    // env (staging | production). SENTRY_ENVIRONMENT stays as a local override
    // (.dev.vars). Never a silent 'production' fallback.
    environment: env.SENTRY_ENVIRONMENT || env.SCRY_ENV || 'unknown',
    // Release version for tracking deployments and source maps
    release: env.SENTRY_RELEASE,
    // Tracing quota is a much smaller budget than errors, so this is a
    // deliberate rate rather than a default. Sampling at 0.1 meant nine deploys
    // in ten had no trace — and with a handful of deploys a day, the build
    // someone is asking about is then almost certainly one of the nine.
    // Override with SENTRY_TRACES_SAMPLE_RATE if volume grows.
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE
      ? Number(env.SENTRY_TRACES_SAMPLE_RATE)
      : 1.0,
    // SDK debug logging off on every tier: NODE_ENV is unset on the Workers, so
    // the old `NODE_ENV !== 'production'` turned it on in production and stage.
    debug: false,
    // Attach request data to events for better debugging
    sendDefaultPii: false,
    // This service authenticates with an X-API-Key header carrying a customer's
    // project key, and the SDK attaches request context by default — so without
    // these, a customer credential reaches Sentry on every authenticated error.
    dataCollection: { userInfo: false, httpBodies: [] },
    // Configure which errors to ignore
    ignoreErrors: [
      // Ignore common non-actionable errors
      'AbortError',
      'Network request failed',
    ],
    // Add custom tags to all events
    initialScope: {
      tags: {
        service: 'storybook-upload-service',
        runtime: 'cloudflare-workers',
      },
    },
    // Before sending an event, you can modify or drop it
    beforeSend(event: Sentry.ErrorEvent, _hint: Sentry.EventHint) {
      // Don't send events in test mode
      if (env.NODE_ENV === 'test') {
        return null;
      }
      // Strip credentials last, so nothing added above can slip past it.
      return scrubEvent(event);
    },
  };
}

/**
 * Export the final object that conforms to the Cloudflare Module Worker standard.
 * The runtime will invoke the 'fetch' method for each incoming HTTP request.
 * 
 * Wrapped with Sentry's withSentry for:
 * - Automatic error capturing and reporting
 * - Performance monitoring and tracing
 * - Request context enrichment
 * - Proper use of ctx.waitUntil for async event delivery
 */
export default Sentry.withSentry(
  (env: Bindings) => sentryOptions(env),
  handler as ExportedHandler
);
