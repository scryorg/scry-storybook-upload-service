/**
 * scry-sync: `DELETE /keys/self` — the Scry Sync app's "Disconnect".
 *
 * Auth is the key itself (`X-API-Key`), and the only key it can touch is that one: the key is
 * looked up by its hash under the project it names, exactly as every upload route validates it,
 * and that key's own document is marked revoked. No other key, project or build is read or
 * written. A revoked key then fails every route with the existing "Invalid API key" 401
 * (guarantee-5), because validation only matches `status == 'active'`.
 *
 * Idempotent: a well-formed key that no longer validates (already revoked, expired or unknown)
 * also answers 204, so "Disconnect" after a revoke in the dashboard still succeeds. The answer is
 * the same for an unknown key as for a revoked one, so the route says nothing about which keys
 * exist. Log lines carry the verified project and the request id only, never the key value (G8).
 */
import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { log, reqFields, reportError } from '../lib/log.js';
import { markVerifiedProject } from '../middleware/auth.js';
import { extractProjectIdFromKey } from '../services/apikey/apikey.utils.js';
import type { AppEnv } from '../app.js';

/** What `revokedBy` records for a key that revoked itself (no user id is known here). */
export const SELF_REVOKED_BY = 'self';

const ErrorSchema = z.object({ error: z.string(), message: z.string() });

export const selfRevokeRoute = createRoute({
  method: 'delete',
  path: '/keys/self',
  request: {
    headers: z.object({
      'x-api-key': z.string().optional().openapi({ description: 'The key to revoke; it authenticates its own revocation.' }),
    }),
  },
  responses: {
    204: { description: 'The key is revoked (or already was). No body.' },
    401: { description: 'Missing X-API-Key header, or a value that is not an API key', content: { 'application/json': { schema: ErrorSchema } } },
    503: { description: 'The key store could not be reached; retry shortly', content: { 'application/json': { schema: ErrorSchema } } },
  },
});

function unavailable(c: Context<AppEnv>) {
  c.header('Retry-After', '2');
  return c.json({ error: 'Authentication temporarily unavailable', message: 'Could not revoke the API key right now; retry shortly' }, 503);
}

export function registerSelfRevoke(app: OpenAPIHono<AppEnv>): void {
  app.openapi(selfRevokeRoute, async (c) => {
    const rawKey = c.req.header('X-API-Key');
    if (!rawKey) {
      return c.json({ error: 'Authentication required', message: 'Missing X-API-Key header' }, 401);
    }
    const projectId = extractProjectIdFromKey(rawKey);
    if (!projectId) {
      return c.json({ error: 'Invalid API key format', message: 'The provided API key has an invalid format' }, 401);
    }
    const apiKeyService = c.var.apiKeyService;
    if (!apiKeyService) {
      log.warn('api key service not configured', reqFields(c, { err_code: 'apikey_service_missing' }));
      return unavailable(c);
    }

    let result: Awaited<ReturnType<typeof apiKeyService.validateApiKey>>;
    try {
      result = await apiKeyService.validateApiKey(projectId, rawKey);
    } catch (error) {
      reportError(c, error, 'api key validation backend failed', 'apikey_backend_unavailable', {});
      return unavailable(c);
    }

    if (!result.valid || !result.apiKey) {
      // Already revoked, expired or unknown: the key does not work, which is what the caller asked for.
      log.info('key self revoke no-op', reqFields(c, { err_code: 'key_self_revoke_noop' }));
      return c.body(null, 204);
    }

    markVerifiedProject(c, projectId);
    try {
      await apiKeyService.revokeApiKey(projectId, result.apiKey.id, SELF_REVOKED_BY);
    } catch (error) {
      reportError(c, error, 'key self revoke failed', 'key_self_revoke_failed');
      return unavailable(c);
    }
    // The key's document (revokedAt, revokedBy 'self') records which key it was; the line needs no key field.
    log.info('key self revoked', reqFields(c, { err_code: 'key_self_revoked' }));
    return c.body(null, 204);
  });
}
