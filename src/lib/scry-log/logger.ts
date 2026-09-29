// scry-log logger: structured lines, allow-list + scrubber on every call, console and http sinks,
// bounded fail-open queue (G4). Zero dependencies; Workers and Node 22.
import { sanitizeLine, type Env, type Level, type LogLine, type Service } from './schema';

export type LineFields = Partial<Omit<LogLine, 'v' | 'ts' | 'level' | 'service' | 'env' | 'msg'>>;

/** Something that receives already-sanitised lines. `write` must be synchronous and never throw. */
export interface Sink {
  write(line: LogLine): void;
  /** Send whatever is queued. Resolves (never rejects) when done or timed out. */
  flush(): Promise<void>;
  /** Number of lines dropped since the last call; resets to 0. */
  takeDrops?(): number;
  /** Count lines that were lost before reaching the sink (e.g. rejected by sanitizeLine). */
  addDrops?(n: number): void;
}

/** Max bytes per POST body; scry-logs /ingest rejects bodies over 512 KB, so stay well under. */
export const MAX_POST_BYTES = 400 * 1024;

function byteLength(s: string): number {
  try {
    return new TextEncoder().encode(s).length;
  } catch {
    return s.length * 3;
  }
}

/** A lost line counts once, plus whatever drop count it was carrying. */
function lostIn(lines: LogLine[]): number {
  let n = 0;
  for (const l of lines) n += 1 + (typeof l.log_drop === 'number' ? l.log_drop : 0);
  return n;
}

export interface ConsoleSinkOptions {
  out?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export function consoleSink(opts: ConsoleSinkOptions = {}): Sink {
  return {
    write(line) {
      try {
        const out = opts.out ?? console;
        const text = JSON.stringify(line);
        if (line.level === 'error') out.error(text);
        else if (line.level === 'warn') out.warn(text);
        else out.log(text);
      } catch {
        // never throw on the request path
      }
    },
    async flush() {},
  };
}

export interface HttpSinkOptions {
  /** Base URL of scry-logs (no trailing /ingest), e.g. $SCRY_LOGS_URL. Empty or missing = lines are dropped and counted. */
  url?: string;
  /** Producer bearer, e.g. $SCRY_LOGS_TOKEN. */
  token?: string;
  /** Vercel `after()` / Workers `ctx.waitUntil`. Used for automatic (size/timer) flushes. */
  waitUntil?: (p: Promise<unknown>) => void;
  fetch?: typeof fetch;
  /** Flush when this many lines are queued. Default 50. */
  flushSize?: number;
  /** Flush this long after the first queued line. Default 5000 ms. */
  flushMs?: number;
  /** Per-POST timeout. Default 2000 ms. */
  timeoutMs?: number;
  /** Queue bound; oldest lines are dropped beyond it. Default 500. */
  maxQueue?: number;
  /** Also write every line to the console (default true). */
  console?: boolean;
  out?: ConsoleSinkOptions['out'];
}

export function httpSink(opts: HttpSinkOptions = {}): Sink & { queued(): number } {
  // With no waitUntil the runtime may freeze the instance right after the response, so the timer flush is
  // best-effort. Callers MUST call logger.flush() from waitUntil/after() at end of request in that case.
  const flushSize = opts.flushSize ?? 50;
  const flushMs = opts.flushMs ?? 5000;
  const timeoutMs = opts.timeoutMs ?? 2000;
  const maxQueue = opts.maxQueue ?? 500;
  const con = opts.console === false ? null : consoleSink({ out: opts.out });
  let queue: LogLine[] = [];
  let drops = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let oldestAt = 0;

  const hold = (p: Promise<void>) => {
    try {
      if (opts.waitUntil) opts.waitUntil(p);
    } catch {
      // waitUntil unavailable or threw: the flush still runs, just not held open
    }
  };

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  async function postChunk(chunk: LogLine[], body: string, budgetMs: number): Promise<void> {
    const f = opts.fetch ?? (typeof fetch === 'function' ? fetch : undefined);
    if (!opts.url || !f) {
      drops += lostIn(chunk);
      return;
    }
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let killer: ReturnType<typeof setTimeout> | null = null;
    try {
      const req = f(`${opts.url.replace(/\/+$/, '')}/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-ndjson', authorization: `Bearer ${opts.token ?? ''}` },
        body,
        signal: ctrl?.signal,
      });
      const timeout = new Promise<'timeout'>((resolve) => {
        killer = setTimeout(() => {
          try {
            ctrl?.abort();
          } catch {
            // ignore
          }
          resolve('timeout');
        }, budgetMs);
      });
      const res = await Promise.race([req, timeout]);
      if (res === 'timeout') {
        drops += lostIn(chunk);
        // Late rejection of an abandoned request must not become an unhandled rejection.
        (req as Promise<unknown>).catch(() => {});
      } else {
        const r = res as Response;
        if (!r.ok) drops += lostIn(chunk);
        try {
          // Release the connection; we never read the ingest response.
          void Promise.resolve(r.body?.cancel()).catch(() => {});
        } catch {
          // ignore
        }
      }
    } catch {
      drops += lostIn(chunk);
    } finally {
      if (killer !== null) clearTimeout(killer);
    }
  }

  /** Split into POSTs of at most MAX_POST_BYTES, sharing one overall time budget. */
  async function post(batch: LogLine[]): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let chunk: LogLine[] = [];
    let parts: string[] = [];
    let size = 0;
    const groups: { lines: LogLine[]; body: string }[] = [];
    for (const l of batch) {
      let text: string;
      try {
        text = JSON.stringify(l);
      } catch {
        drops += lostIn([l]);
        continue;
      }
      const n = byteLength(text) + 1;
      if (chunk.length > 0 && size + n > MAX_POST_BYTES) {
        groups.push({ lines: chunk, body: parts.join('\n') + '\n' });
        chunk = [];
        parts = [];
        size = 0;
      }
      chunk.push(l);
      parts.push(text);
      size += n;
    }
    if (chunk.length > 0) groups.push({ lines: chunk, body: parts.join('\n') + '\n' });
    for (const g of groups) {
      const left = deadline - Date.now();
      if (left <= 0) drops += lostIn(g.lines);
      else await postChunk(g.lines, g.body, left);
    }
  }

  function flush(): Promise<void> {
    clearTimer();
    if (queue.length === 0) return Promise.resolve();
    const batch = queue;
    queue = [];
    return post(batch).catch(() => {
      drops += lostIn(batch);
    });
  }

  return {
    write(line) {
      try {
        con?.write(line);
        if (queue.length === 0) oldestAt = Date.now();
        queue.push(line);
        if (queue.length > maxQueue) {
          const over = queue.length - maxQueue;
          drops += lostIn(queue.splice(0, over));
        }
        if (queue.length >= flushSize || (!opts.waitUntil && Date.now() - oldestAt > flushMs)) {
          // Without waitUntil, a queue older than flushMs means the timer never ran (instance was frozen): send now.
          hold(flush());
        } else if (timer === null) {
          timer = setTimeout(() => {
            timer = null;
            hold(flush());
          }, flushMs);
          // Do not keep a Node process alive just for the log timer.
          (timer as unknown as { unref?: () => void }).unref?.();
        }
      } catch {
        drops += 1;
      }
    },
    addDrops(n) {
      if (Number.isFinite(n) && n > 0) drops += Math.floor(n);
    },
    flush,
    takeDrops() {
      const d = drops;
      drops = 0;
      return d;
    },
    queued: () => queue.length,
  };
}

export type SinkConfig = { type: 'console' } & ConsoleSinkOptions | ({ type: 'http' } & HttpSinkOptions);

export interface LoggerOptions {
  service: Service;
  env: Env;
  version?: string;
  sink?: Sink | SinkConfig;
  /** Enable debug lines. Default: process.env.SCRY_LOG_DEBUG === '1' where process exists. In Workers pass `env.SCRY_LOG_DEBUG === '1'`. */
  debug?: boolean | string;
  now?: () => Date;
}

export interface Logger {
  info(msg: string, fields?: LineFields): void;
  warn(msg: string, fields?: LineFields): void;
  error(msg: string, fields?: LineFields): void;
  debug(msg: string, fields?: LineFields): void;
  /** End-of-request line: msg "request", level from status (>=500 error, >=400 warn). */
  request(fields: LineFields & { msg?: string }): void;
  flush(): Promise<void>;
}

function envDebug(): boolean {
  try {
    const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    return p?.env?.SCRY_LOG_DEBUG === '1';
  } catch {
    return false;
  }
}

function isSink(s: Sink | SinkConfig): s is Sink {
  return typeof (s as Sink).write === 'function';
}

export function createLogger(options: LoggerOptions): Logger {
  // Off-contract options (null, Proxy, throwing getters) must not throw: fall back to defaults; lines are then
  // rejected by sanitizeLine (no valid service/env) and counted as drops.
  let opts: LoggerOptions = {} as LoggerOptions;
  let sink: Sink;
  let debugOn = false;
  let now: () => Date = () => new Date();
  try {
    opts = { service: options.service, env: options.env, version: options.version, sink: options.sink, debug: options.debug, now: options.now };
    const cfg = opts.sink ?? { type: 'console' as const };
    sink = isSink(cfg) ? cfg : cfg.type === 'http' ? httpSink(cfg) : consoleSink(cfg);
    debugOn = opts.debug === undefined ? envDebug() : opts.debug === true || opts.debug === '1';
    if (typeof opts.now === 'function') now = opts.now;
  } catch {
    sink = consoleSink();
  }

  function emit(level: Level, msg: unknown, fields?: unknown): void {
    try {
      if (level === 'debug' && !debugOn) return;
      const raw: Record<string, unknown> = {
        ...(isPlain(fields) ? fields : {}),
        v: 1,
        ts: now().toISOString(),
        level,
        service: opts.service,
        env: opts.env,
        msg,
      };
      delete raw.log_drop; // producer-owned; callers cannot set it
      if (opts.version && raw.version === undefined) raw.version = opts.version;
      const line = sanitizeLine(raw);
      if (!line) {
        // Rejected (e.g. msg was not a string): count it, and leave the pending drop count for the next line.
        sink.addDrops?.(1);
        return;
      }
      const drops = sink.takeDrops?.() ?? 0;
      if (drops > 0) line.log_drop = drops;
      sink.write(line);
    } catch {
      // G4: logging never throws into the caller
    }
  }

  return {
    info: (msg, f) => emit('info', msg, f),
    warn: (msg, f) => emit('warn', msg, f),
    error: (msg, f) => emit('error', msg, f),
    debug: (msg, f) => emit('debug', msg, f),
    request(fields) {
      try {
        if (!isPlain(fields)) return emit('info', 'request');
        const { msg, ...rest } = fields as Record<string, unknown>;
        const st = rest.status;
        const s = typeof st === 'number' && Number.isFinite(st) ? st : 0;
        emit(s >= 500 ? 'error' : s >= 400 ? 'warn' : 'info', typeof msg === 'string' ? msg : 'request', rest);
      } catch {
        // G4
      }
    },
    async flush() {
      try {
        await sink.flush();
      } catch {
        // fail-open
      }
    },
  };
}

function isPlain(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}
