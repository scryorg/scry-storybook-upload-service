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
  };
}

/**
 * One structured line per authentication outcome (upload-project-key-scope).
 * Carries the key's Firestore doc id and projects only; the key value, its
 * prefix and any hash of it are never logged.
 */
function logAuth(
  level: 'log' | 'warn',
  fields: { outcome: string; keyId?: string; keyProject: string | null; routeProject?: string; method: string; path: string }
): void {
  const line = JSON.stringify({ event: 'upload_auth', ...fields });
  if (level === 'warn') console.warn(line);
  else console.log(line);
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
      console.warn('[AUTH] API key service not configured - skipping authentication');
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
      logAuth('warn', {
        outcome: 'project_mismatch',
        keyProject: keyProjectId,
        routeProject: routeProjectId,
        method: c.req.method,
        path: c.req.path,
      });
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
    const result = await apiKeyService.validateApiKey(projectId, apiKey);

    if (!result.valid) {
      return c.json(
        {
          error: 'Invalid API key',
          message: result.error || 'The provided API key is invalid or has been revoked',
        },
        401
      );
    }

    // Set authenticated context
    c.set('authenticatedApiKey', {
      id: result.apiKey!.id,
      name: result.apiKey!.name,
      prefix: result.apiKey!.prefix,
      projectId,
      keyProjectId,
    });

    logAuth('log', {
      outcome: 'ok',
      keyId: result.apiKey!.id,
      keyProject: keyProjectId,
      routeProject: routeProjectId,
      method: c.req.method,
      path: c.req.path,
    });

    // Update lastUsedAt timestamp (fire-and-forget to avoid latency)
    if (config.trackUsage && result.apiKey) {
      apiKeyService.updateLastUsed(projectId, result.apiKey.id).catch((error) => {
        console.error('[AUTH] Failed to update lastUsedAt:', error);
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