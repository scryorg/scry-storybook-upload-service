// Structured logging for the upload service (feature log-standardization, schema v1).
// One logger per process, configured from the first request's bindings. Free-text
// console output on the request path is replaced by log.info/warn/error(fixedMsg, fields):
// `msg` is words only, variable data goes in the allowed fields (request_id, project,
// build_id, route, status, ms, err_code). Never pass an exception message.

import * as Sentry from '@sentry/cloudflare';
import type { Context } from 'hono';
import { createLogger, type Env, type LineFields, type Logger } from './scry-log';

export interface LogBindings {
  SCRY_ENV?: string;
  SCRY_COMMIT?: string;
  SCRY_LOG_DEBUG?: string;
}

let current: Logger | undefined;
let currentKey = '';

function processEnv(): LogBindings {
  try {
    const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    return { SCRY_ENV: p?.env?.SCRY_ENV, SCRY_COMMIT: p?.env?.SCRY_COMMIT, SCRY_LOG_DEBUG: p?.env?.SCRY_LOG_DEBUG };
  } catch {
    return {};
  }
}

function tier(value: string | undefined): Env {
  return value === 'production' || value === 'staging' ? value : 'development';
}

/** (Re)build the logger when the deploy identity changes. Cheap; called per request. */
export function configureLog(bindings?: LogBindings): Logger {
  const b = { ...processEnv(), ...(bindings ?? {}) };
  const key = `${b.SCRY_ENV ?? ''}|${b.SCRY_COMMIT ?? ''}|${b.SCRY_LOG_DEBUG ?? ''}`;
  if (!current || key !== currentKey) {
    current = createLogger({
      service: 'upload',
      env: tier(b.SCRY_ENV),
      version: b.SCRY_COMMIT,
      debug: b.SCRY_LOG_DEBUG === '1',
    });
    currentKey = key;
  }
  return current;
}

/** The process logger. Delegates so a later configureLog() takes effect. */
export const log: Logger = {
  info: (m, f) => configureLog().info(m, f),
  warn: (m, f) => configureLog().warn(m, f),
  error: (m, f) => configureLog().error(m, f),
  debug: (m, f) => configureLog().debug(m, f),
  request: (f) => configureLog().request(f),
  flush: () => configureLog().flush(),
};

/** Fields every line for this request should carry. Never throws. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function reqFields(c: Context<any> | undefined, extra: LineFields = {}): LineFields {
  const out: LineFields = {};
  try {
    if (c) {
      const id = c.get('requestId') as string | undefined;
      if (id) out.request_id = id;
      const buildId = c.get('buildId') as string | undefined;
      if (buildId) out.build_id = buildId;
      let project: string | undefined;
      try {
        project = c.req.param('project') as string | undefined;
      } catch {
        project = undefined;
      }
      if (project) out.project = project;
    }
  } catch {
    // never throw from logging
  }
  return { ...out, ...extra };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function logInfo(c: Context<any> | undefined, msg: string, extra?: LineFields): void {
  log.info(msg, reqFields(c, extra));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function logWarn(c: Context<any> | undefined, msg: string, code: string, extra?: LineFields): void {
  log.warn(msg, reqFields(c, { err_code: code, ...extra }));
}

/**
 * Log an error line and send the exception to Sentry with the request id.
 * `msg` and `code` are fixed strings; the exception itself goes only to Sentry
 * (whose beforeSend scrubber removes credentials), never into the log line.
 */
export function reportError(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: Context<any> | undefined,
  err: unknown,
  msg: string,
  code: string,
  extra?: LineFields
): void {
  const fields = reqFields(c, { err_code: code, ...extra });
  log.error(msg, fields);
  try {
    Sentry.captureException(err, {
      tags: { request_id: fields.request_id ?? 'none', err_code: code },
    });
  } catch {
    // telemetry must never break the request
  }
}
