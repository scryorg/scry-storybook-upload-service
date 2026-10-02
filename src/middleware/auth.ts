import { log, reqFields, reportError } from '../lib/log.js';
import { Context, Next } from 'hono';
import type { ApiKeyService } from '../services/apikey/apikey.service.js';
import { extractProjectIdFromKey } from '../services/apikey/apikey.utils.js';

/**
 * API Key Authentication Middleware
 * 
 * Validates the X-API-Key header against Firestore-stored API keys.
 * 
 * Usage:
 *   app.use('/upload/*', apiKeyAuth())
 * 
 * The middleware expects:
 * - `apiKeyService` to be available in `c.var`
 * - `X-API-Key` header in the request
 * - Optional: `project` parameter in the route for cross-validation
 */

/**
 * Options for the API key authentication middleware
 */
export interface ApiKeyAuthOptions {
  /**
   * Header name to look for the API key (default: 'X-API-Key')
   */
  headerName?: string;

  /**
   * Whether to validate that the key's project matches the route's project param
   * (default: true)
   */
  validateProjectMatch?: boolean;

  /**
   * Route parameter name for the project ID (default: 'project')
   */
  projectParamName?: string;

  /**
   * Whether to update lastUsedAt timestamp on successful auth
   * This is done fire-and-forget to avoid latency (default: true)
   */
  trackUsage?: boolean;

  /**
   * Whether to skip auth if no X-API-Key header is provided
   * Useful for endpoints that support both authenticated and unauthenticated access
   * (default: false)
   */
  optional?: boolean;
}

const DEFAULT_OPTIONS: Required<ApiKeyAuthOptions> = {
  headerName: 'X-API-Key',
  validateProjectMatch: true,
  projectParamName: 'project',
  trackUsage: true,
  optional: false,
};

/**
 * Authenticated request context variables
 */
export interface AuthVariables {
  /**
   * The authenticated API key metadata (if auth succeeded)
   */
  authenticatedApiKey?: {
    id: string;
    name: string;
    prefix: string;
    projectId: string;
    /** The project the key was minted for (from the key itself). */
    keyProjectId: string;
    /**
     * scry-sync: what minted the key. `'device'` is a Scry Sync desktop key. ANY present value is the
     * restricted class (see `isRestrictedKeyKind`); absent only for a key minted before scry-sync.
     */
    kind?: string;
  };
}

/** scry-sync: the `kind` the dashboard's device sign-in writes on the key it mints. */
export const DEVICE_KEY_KIND = 'device';

/** The one source kind a restricted (device) key may presign or complete (ledger F40). */
export const DEVICE_KEY_SOURCE_KIND = 'x-scry-sync';

/** ...and the one platform it may name: the full source is exactly `x-scry-sync:other` (ledger F68). */
export const DEVICE_KEY_SOURCE_PLATFORM = 'other';

/**
 * True only for the exact device-key source. Comparing the kind alone let `x-scry-sync:ios` /
 * `x-scry-sync:web` through, and a distinct source key splits "latest build per source" (G7).
 */
export function isDeviceKeySource(source: { kind?: string; platform?: string } | null | undefined): boolean {
  return source?.kind === DEVICE_KEY_SOURCE_KIND && source.platform === DEVICE_KEY_SOURCE_PLATFORM;
}

/** What a restricted key is told on every refusal (route scope and source pin share the body). */
export const DEVICE_KEY_REFUSAL = {
  error: 'Forbidden',
  message: 'This key can only upload pictures to its project',
} as const;

/**
 * scry-sync fail-closed (ledger F39): a key is the restricted device class whenever its `kind`
 * field is PRESENT, whatever the value ('device', 'Device', 'ci', a number...). The key services
 * hand `kind` on as a string for any present field and leave it undefined only for a key document
 * with no `kind` field, which keeps its pre-scry-sync rights. No present value is unrestricted
 * today; to allow one later, add an explicit check here rather than loosening the rule.
 */
export function isRestrictedKeyKind(kind: string | undefined): boolean {
  return kind !== undefined;
}

/**
 * scry-sync guarantee-1: the only requests a device key may make through `apiKeyAuth`. Presign a
 * bundle and complete it (the PUT in between goes straight to R2 on the presigned URL). Revoking
 * itself (`DELETE /keys/self`) is not listed: that handler is not behind `apiKeyAuth` (no mount
 * covers `/keys/*`) and authenticates the key itself, so an entry here would be dead. Every other
 * route (read, list, legacy uploads, coverage, metadata, images) is refused with 403, even for the
 * key's own project. Matched on the method and the concrete path, so a new route is refused by
 * default until it is added here.
 */
const DEVICE_KEY_ROUTES: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: 'POST', path: /^\/presigned-url\/[^/]+\/[^/]+\/bundle\.zip$/ },
  { method: 'POST', path: /^\/upload\/[^/]+\/[^/]+\/bundle\/complete$/ },
];

export function deviceKeyMayUse(method: string, path: string): boolean {
  return DEVICE_KEY_ROUTES.some((r) => r.method === method.toUpperCase() && r.path.test(path));
}

/**
 * One structured line per authentication outcome (upload-project-key-scope).
 * Carries the key's Firestore doc id and projects only; the key value, its
 * prefix and any hash of it are never logged.
 */
function logAuth(
  level: 'log' | 'warn',
  fields: { outcome: string; keyId?: string; keyProject?: string | null; routeProject?: string; method: string; path?: string }
): void {
  const line = JSON.stringify({ event: 'upload_auth', ...fields });
  if (level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * Record the project for the request line and every later line of this request. Called ONLY once
 * the API key validated for that project (the key exists under it and is not revoked), never from
 * the raw path or c.req.param: a client-chosen path segment must not reach the log store
 * (guarantee G1, UAT F47, same class as the CDN F41).
 */
const VERIFIED_PROJECT = /^[A-Za-z0-9_-]{1,128}$/;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function markVerifiedProject(c: Context<any>, projectId: string): void {
  if (VERIFIED_PROJECT.test(projectId)) c.set('projectId', projectId);
}

/**
 * Creates an API key authentication middleware for Hono
 * 
 * @param options Optional configuration options
 * @returns Hono middleware function
 * 
 * @example
 * // Basic usage - protect all upload routes
 * app.use('/upload/*', apiKeyAuth());
 * 
 * @example
 * // Optional auth - allow unauthenticated access
 * app.use('/public/*', apiKeyAuth({ optional: true }));
 * 
 * @example
 * // Custom header name
 * app.use('/api/*', apiKeyAuth({ headerName: 'Authorization' }));
 */
export function apiKeyAuth(options: ApiKeyAuthOptions = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };

  return async (c: Context<{ Variables: { apiKeyService?: ApiKeyService } & AuthVariables }>, next: Next) => {
    const apiKeyService = c.var.apiKeyService;

    // Check if API key service is configured
    if (!apiKeyService) {
      log.warn('api key service not configured', reqFields(c as never, { err_code: 'apikey_service_missing' }));
      return next();
    }

    // Get the API key from header
    const apiKey = c.req.header(config.headerName);

    // Handle missing API key
    if (!apiKey) {
      if (config.optional) {
        return next();
      }
      return c.json(
        {
          error: 'Authentication required',
          message: `Missing ${config.headerName} header`,
        },
        401
      );
    }

    // Extract project ID from the API key
    const keyProjectId = extractProjectIdFromKey(apiKey);
    if (!keyProjectId) {
      return c.json(
        {
          error: 'Invalid API key format',
          message: 'The provided API key has an invalid format',
        },
        401
      );
    }

    // Get project ID from route parameter if available
    const routeProjectId = c.req.param(config.projectParamName);

    // Validate project match if configured
    if (config.validateProjectMatch && routeProjectId && keyProjectId !== routeProjectId) {
      // Neither project is verified here (both come from the request), so neither is logged.
      log.warn('api key project mismatch', reqFields(c as never, { err_code: 'project_mismatch' }));
      logAuth('warn', { outcome: 'project_mismatch', method: c.req.method });
      return c.json(
        {
          error: 'Project mismatch',
          message: 'The API key does not belong to the requested project',
        },
        403
      );
    }

    // Use the project ID from the key for validation
    const projectId = routeProjectId || keyProjectId;

    // Validate the API key
    // A backend failure (Firestore/token exchange down or slow) is not the caller's fault and not an
    // unhandled 500: answer 503 + Retry-After, which the CLI's upload retry treats as transient (F145).
    let result: Awaited<ReturnType<typeof apiKeyService.validateApiKey>>;
    try {
      result = await apiKeyService.validateApiKey(projectId, apiKey);
    } catch (error) {
      reportError(c as never, error, 'api key validation backend failed', 'apikey_backend_unavailable', {});
      c.header('Retry-After', '2');
      return c.json(
        { error: 'Authentication temporarily unavailable', message: 'Could not validate the API key right now; retry shortly' },
        503
      );
    }

    if (!result.valid) {
      log.warn('api key rejected', reqFields(c as never, { err_code: 'apikey_invalid' }));
      return c.json(
        {
          error: 'Invalid API key',
          message: result.error || 'The provided API key is invalid or has been revoked',
        },
        401
      );
    }

    // scry-sync guarantee-1: a device key can upload bundles and revoke itself, nothing else.
    const keyKind = result.apiKey!.kind;
    if (isRestrictedKeyKind(keyKind) && !deviceKeyMayUse(c.req.method, c.req.path)) {
      log.warn('device key refused', reqFields(c as never, { err_code: 'device_key_scope' }));
      logAuth('warn', { outcome: 'device_key_scope', keyId: result.apiKey!.id, method: c.req.method });
      return c.json(DEVICE_KEY_REFUSAL, 403);
    }

    // Authorized: only now may the project reach a log line.
    markVerifiedProject(c, projectId);

    // Set authenticated context
    c.set('authenticatedApiKey', {
      id: result.apiKey!.id,
      name: result.apiKey!.name,
      prefix: result.apiKey!.prefix,
      projectId,
      keyProjectId,
      ...(keyKind !== undefined ? { kind: keyKind } : {}),
    });

    logAuth('log', {
      outcome: 'ok',
      keyId: result.apiKey!.id,
      keyProject: keyProjectId,
      routeProject: projectId,
      method: c.req.method,
    });

    // Update lastUsedAt timestamp (fire-and-forget to avoid latency)
    if (config.trackUsage && result.apiKey) {
      apiKeyService.updateLastUsed(projectId, result.apiKey.id).catch(() => {
        log.warn('could not update key last used', reqFields(c as never, { err_code: 'apikey_touch_failed' }));
      });
    }

    // Continue to the next handler
    return next();
  };
}

/**
 * Helper to check if the current request is authenticated
 * @param c Hono context
 * @returns true if the request has valid API key authentication
 */
export function isAuthenticated(c: Context<{ Variables: AuthVariables }>): boolean {
  return !!c.var.authenticatedApiKey;
}

/**
 * Helper to get the authenticated API key info
 * @param c Hono context
 * @returns The authenticated API key info or undefined
 */
export function getAuthenticatedApiKey(c: Context<{ Variables: AuthVariables }>) {
  return c.var.authenticatedApiKey;
}