// x-scry-request-id middleware (features observability-request-id, log-standardization).
// Mounted first in app.ts so every response, including 401/404/500, carries an id:
//   1. mint a ULID. This service is reached by customer API-key clients and has no
//      service bearer, so per the trust rule it never accepts an inbound id. The one exception
//      is the dashboard door (middleware/dashboard-door.ts): once its signed assertion verified,
//      it adopts the dashboard's x-scry-request-id, and this middleware reads it back after next();
//   2. c.set('requestId') for handlers and the queue message;
//   3. echo it as x-scry-request-id;
//   4. add "request_id" to every JSON error body (status >= 400) that lacks one;
//   5. write one schema-v1 request line at the end (allow-listed fields only).
// A failing logger or header write never changes the response (guarantee-4).

import * as Sentry from '@sentry/cloudflare';
import type { Context, Next } from 'hono';
import { REQUEST_ID_HEADER, mintRequestId } from '../lib/request-id.js';
import { configureLog, log, reportError, type LogBindings } from '../lib/log.js';

declare module 'hono' {
  interface ContextVariableMap {
    /** This request's x-scry-request-id (always set by requestIdMiddleware). */
    requestId: string;
    /** Verified project id: set by apiKeyAuth only after the key validated for it. */
    projectId: string;
    /** Set by handlers once the build is looked up, for the request line. */
    buildId: string;
  }
}

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const SAFE_CLIENT = /^[A-Za-z0-9._-]{1,40}\/[0-9A-Za-z.+-]{1,32}$/;

/** The matched route pattern (never the raw URL). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function routePattern(c: Context<any>): string {
  try {
    const routes = c.req.matchedRoutes;
    for (let i = routes.length - 1; i >= 0; i--) {
      if (routes[i].method !== 'ALL') return routes[i].path;
    }
    return 'unmatched';
  } catch {
    return 'unmatched';
  }
}

/**
 * G1: project, build_id and client are logged only when the route matched a known pattern AND the
 * API key middleware verified the project (c.var.projectId, set after the key validated for it).
 * Never read from c.req.param or the path: those are client-controlled (UAT F47).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function verifiedRequestFields(c: Context<any>) {
  const route = routePattern(c);
  const verified = route !== 'unmatched' ? (c.get('projectId') as string | undefined) : undefined;
  const project = verified && SAFE_ID.test(verified) ? verified : undefined;
  const buildId = project ? (c.get('buildId') as string | undefined) : undefined;
  const client = project ? c.req.header('x-scry-client') : undefined;
  // Set only by the dashboard door after its assertion verified (a 12-hex HMAC of the uid, never the uid).
  const uidHash = project ? (c.get('dashboardCaller') as { uidHash?: string } | undefined)?.uidHash : undefined;
  return { route, project, buildId, client, uidHash };
}

async function withRequestIdInBody(res: Response, requestId: string): Promise<Response> {
  if (res.status < 400) return res;
  const type = res.headers.get('content-type') ?? '';
  if (!type.toLowerCase().includes('application/json')) return res;
  let body: unknown;
  try {
    body = await res.clone().json();
  } catch {
    return res;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return res;
  if ((body as Record<string, unknown>).request_id === requestId) return res;
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  return new Response(JSON.stringify({ ...(body as Record<string, unknown>), request_id: requestId }), {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

function tagSentry(requestId: string): void {
  try {
    Sentry.getCurrentScope().setTag('request_id', requestId);
  } catch {
    // telemetry must never break the request
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function requestIdMiddleware(c: Context<any>, next: Next): Promise<void> {
  // Mounted on both the worker app and the shared app: the outermost one wins.
  if (c.get('requestId')) {
    await next();
    return;
  }
  const started = Date.now();
  const requestId = mintRequestId();
  c.set('requestId', requestId);
  try {
    configureLog(c.env as LogBindings | undefined);
  } catch {
    // keep going with the default logger
  }
  tagSentry(requestId);

  await next();

  // The dashboard door adopts the dashboard's id once its assertion verified (trust rule), so read it back.
  const finalId = (c.get('requestId') as string | undefined) ?? requestId;
  if (finalId !== requestId) tagSentry(finalId);

  try {
    let res = await withRequestIdInBody(c.res, finalId);
    try {
      res.headers.set(REQUEST_ID_HEADER, finalId);
    } catch {
      // Immutable headers (a proxied Response): copy once.
      res = new Response(res.body, res);
      res.headers.set(REQUEST_ID_HEADER, finalId);
    }
    if (res !== c.res) {
      c.res = undefined as unknown as Response;
      c.res = res;
    }
  } catch {
    // the caller still gets the response the handler produced
  }

  try {
    const { route, project, buildId, client, uidHash } = verifiedRequestFields(c);
    log.request({
      request_id: finalId,
      route,
      status: c.res.status,
      ms: Date.now() - started,
      ...(project ? { project } : {}),
      ...(buildId && SAFE_ID.test(buildId) ? { build_id: buildId } : {}),
      ...(client && SAFE_CLIENT.test(client) ? { client } : {}),
      ...(uidHash ? { uid_hash: uidHash } : {}),
    });
  } catch {
    // a failing logger never changes the response
  }
}

/** app.onError: unhandled errors reach Sentry with the request id; body keeps the service's error shape. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function errorHandler(err: unknown, c: Context<any>): Response {
  reportError(c, err, 'unhandled error', 'unhandled_error');
  return c.json({ error: 'Internal server error' }, 500);
}
