/**
 * sync-clipboard-push: tell the signal Worker "something new for this person" after a snip is ready
 * (contract section 5). The signal holds only the uid; it never carries text, picture, id or project.
 *
 * Best effort and off the request path: the caller hands `sendClipSignal` to `executionCtx.waitUntil`,
 * so a slow or failed send never changes or delays the answer to the app. Each attempt has a 1500 ms
 * timeout and there is one retry after about 300 ms. A retry logs err_code `clip_signal.send_retried`; a final
 * failure logs err_code `clip_signal.send_failed`, both with an `outcome` (timeout, rejected, network, unexpected). The
 * schema allows no 23-character word in `msg`, so the contract's names ride in err_code and msg is plain words. Neither line carries the uid or the secret.
 * Without the service binding or the secret nothing is sent and nothing is logged.
 */
import { log } from '../lib/log.js';
import type { LineFields } from '../lib/scry-log';

/** The slice of a Worker service binding this module uses. */
export interface ClipSignalBinding {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

export interface ClipSignalConfig {
  binding: ClipSignalBinding;
  secret: string;
  /** Tests only; the Worker never sets it. */
  timing?: ClipSignalTiming;
}

export interface ClipSignalTiming {
  timeoutMs: number;
  retryDelayMs: number;
}

export const CLIP_SIGNAL_TIMING: ClipSignalTiming = { timeoutMs: 1500, retryDelayMs: 300 };

const SIGNAL_URL = 'https://clip-signal/v1/signal';

/** Builds the config from the Worker bindings, or undefined when either half is missing (send nothing). */
export function clipSignalConfig(binding: ClipSignalBinding | undefined, secret: string | undefined): ClipSignalConfig | undefined {
  return binding && secret ? { binding, secret } : undefined;
}

type Outcome = 'ok' | 'timeout' | 'rejected' | 'network';

async function attempt(config: ClipSignalConfig, uid: string, timeoutMs: number): Promise<Outcome> {
  try {
    const res = await config.binding.fetch(SIGNAL_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ u: uid }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Drain the body so the connection is released; the answer itself is not used.
    await res.arrayBuffer().catch(() => undefined);
    return res.ok ? 'ok' : 'rejected';
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network';
  }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Never throws. `fields` are the request's log fields (request id only; never the uid). */
export async function sendClipSignal(
  config: ClipSignalConfig | undefined,
  uid: string | undefined,
  fields: LineFields = {},
  timingOverride?: ClipSignalTiming,
): Promise<void> {
  if (!config || !uid) return;
  const timing = timingOverride ?? config.timing ?? CLIP_SIGNAL_TIMING;
  try {
    let outcome = await attempt(config, uid, timing.timeoutMs);
    if (outcome === 'ok') return;
    log.info('clip signal send retried', { ...fields, err_code: 'clip_signal.send_retried', outcome });
    await wait(timing.retryDelayMs);
    outcome = await attempt(config, uid, timing.timeoutMs);
    if (outcome !== 'ok') log.warn('clip signal send failed', { ...fields, err_code: 'clip_signal.send_failed', outcome });
  } catch {
    log.warn('clip signal send failed', { ...fields, err_code: 'clip_signal.send_failed', outcome: 'unexpected' });
  }
}
