// build.step events (feature staff-builds-view). One structured log line per pipeline step, so a
// support person can answer "where is this build and why" from `scry-logs.py --build <id>`.
//
// The BUILD_STEPS and BUILD_STEP_OUTCOMES lists below are the same strings in scry-storybook-upload-service
// (src/lib/build-steps.ts) and scry-build-processing-service (src/lib/build-steps.ts); change both together.
// Upload emits the first four, build processing the rest. Every value is a lowercase code
// (^[a-z][a-z0-9_.]{0,47}$) so it passes the scry-log schema as-is.

import type { Context } from 'hono';
import { log, reqFields } from './log';
import type { LineFields } from './scry-log';

export const BUILD_STEPS = [
  'upload_received', // upload service: the ZIP (or metadata ZIP) reached us
  'presign', // upload service: the build record was created and an upload URL issued
  'complete', // upload service: a bundle upload was validated (or rejected)
  'enqueue', // upload service: the build was put on the processing queue
  'queue_pickup', // build processing: a worker took the queue message
  'lease_wait', // build processing: waiting for the indexing turn
  'credits_wait', // build processing: waiting for AI credits
  'chunk_start', // build processing: a chunk attempt began
  'chunk_done', // build processing: a chunk attempt finished
  'retry', // build processing: a step is being retried
  'finalise', // build processing: the build reached its final state
  'fail', // build processing: the build failed
  'dead_letter', // build processing: the queue gave up on the message
  'stall_mark', // build processing: the stall scan marked the build stalled
] as const;
export type BuildStep = (typeof BUILD_STEPS)[number];

export const BUILD_STEP_OUTCOMES = ['start', 'ok', 'wait', 'retry', 'fail', 'dead', 'stalled'] as const;
export type BuildStepOutcome = (typeof BUILD_STEP_OUTCOMES)[number];

/**
 * The closed set of `reason` codes (guarantee G3). A build.step `reason` is one of these and nothing
 * else: never an exception message, a tally line or a stored `processingError` (those can carry story
 * titles and design text). The full message stays only in the stored `processingError`. The dashboard
 * maps each code to plain words. The same list is in scry-storybook-upload-service
 * (src/lib/build-steps.ts); change both together. Every code passes the scry-log pattern as-is.
 */
export const BUILD_STEP_REASONS = [
  'ai_timeout', // an AI call or a step ran past its deadline
  'http_429', // a vendor rate-limited us
  'http_4xx', // a vendor or service refused the request (other than 429)
  'http_5xx', // a vendor or service failed on its side
  'credits_exhausted', // not enough AI credits (the build waits or stops)
  'credits_unavailable', // the credits ledger could not be reached
  'quota', // a plan or vendor quota was hit
  'validation', // the upload or its metadata failed a check
  'source_not_allowed', // the upload's source is not allowed for the project
  'lease_lost', // the indexing turn was lost or could not be taken
  'queue_redelivery', // the queue gave the message back
  'queue_send_failed', // the processing queue refused the message
  'empty_archive', // the archive listed no stories
  'stories_dropped', // the archive declared stories that were not captured
  'stories_failed', // stories inside a chunk that ran produced no row
  'chunks_missing', // chunks never ran (circuit breaker or terminated instance)
  'stalled_no_story', // stalled before the story count was known
  'stalled_no_heartbeat', // stalled with no stage progress ever recorded
  'stalled_total', // stalled after progress stopped for the threshold
  'dead_letter', // the queue gave up on the message
  'unknown', // none of the above
] as const;
export type BuildStepReason = (typeof BUILD_STEP_REASONS)[number];

const REASON_SET: ReadonlySet<string> = new Set(BUILD_STEP_REASONS);

/** True when `value` is one of the closed reason codes. */
export function isReasonCode(value: unknown): value is BuildStepReason {
  return typeof value === 'string' && REASON_SET.has(value);
}

/** Longest slice of a failure's text looked at when deriving a code (text is only matched, never emitted). */
const CLASSIFY_MAX = 512;

/** The numeric HTTP status an error carries, if any. */
function statusOf(error: unknown): number | undefined {
  const e = error as { status?: unknown; statusCode?: unknown } | null;
  const status = e?.status ?? e?.statusCode;
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
}

/** Looked-at facts about a failure; the text is only matched, never emitted. */
interface FailureFacts {
  text: string;
  status: number | undefined;
}

/** First match wins, so the order is the precedence. */
const REASON_RULES: ReadonlyArray<readonly [BuildStepReason, (f: FailureFacts) => boolean]> = [
  ['http_429', (f) => f.status === 429 || /\b429\b|rate.?limit/i.test(f.text)],
  ['credits_unavailable', (f) => /CreditsUnavailable/i.test(f.text)],
  ['credits_exhausted', (f) => /insufficient credits|credits? (?:exhausted|insufficient)|out of credits|credits_exhausted/i.test(f.text)],
  ['quota', (f) => /quota/i.test(f.text)],
  ['lease_lost', (f) => /\blease\b/i.test(f.text)],
  ['ai_timeout', (f) => /DeadlineError|timed?[ -]?out|deadline|aborted/i.test(f.text)],
  ['http_5xx', (f) => (f.status !== undefined && f.status >= 500 && f.status < 600) || /\b(?:http|status|error)\D{0,16}5\d\d\b/i.test(f.text)],
  ['validation', (f) => /ZipSafetyError|ForeignZipKey|BadRequest|Validation|invalid|malformed|metadata\.json/i.test(f.text)],
  ['http_4xx', (f) => (f.status !== undefined && f.status >= 400 && f.status < 500) || /\b(?:http|status|error)\D{0,16}4\d\d\b/i.test(f.text)],
];

function factsOf(input: unknown): FailureFacts | undefined {
  if (input instanceof Error) {
    return {
      status: statusOf(input) ?? statusOf((input as { cause?: unknown }).cause),
      text: `${input.name} ${input.message}`.slice(0, CLASSIFY_MAX),
    };
  }
  return typeof input === 'string' ? { status: undefined, text: input.slice(0, CLASSIFY_MAX) } : undefined;
}

/**
 * The reason code for a failure: a thrown value, or the string `describeFailure` made of one. The
 * text is only matched against fixed patterns; nothing from it is ever returned. Anything not
 * recognised is `unknown`. Never throws.
 */
export function classifyReason(input: unknown): BuildStepReason {
  try {
    if (isReasonCode(input)) return input;
    const facts = factsOf(input);
    if (!facts) return 'unknown';
    return REASON_RULES.find(([, matches]) => matches(facts))?.[0] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * What goes on the wire for a caller-supplied reason: the code when it is one of the closed set,
 * `unknown` for anything else (so a stray free-text string can never reach a line), undefined for none.
 */
function reasonField(raw: unknown): BuildStepReason | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  return isReasonCode(raw) ? raw : 'unknown';
}

export interface StepEvent {
  step: BuildStep;
  outcome: BuildStepOutcome;
  buildId?: string;
  ms?: number;
  attempt?: number;
  chunk?: number;
  chunksTotal?: number;
  /** A closed reason code (G3); anything else is emitted as `unknown`. */
  reason?: BuildStepReason;
}

/** The part of the build document's `stepSummary` that moves on every step (firstStepAt and requestId are written at creation). */
export interface StepSummaryUpdate {
  lastStep: BuildStep;
  outcome: BuildStepOutcome;
  at?: Date;
}

export function stepSummaryFor(step: BuildStep, outcome: BuildStepOutcome): StepSummaryUpdate {
  return { lastStep: step, outcome, at: new Date() };
}

/**
 * Emit one build.step line. `project` and `build_id` ride reqFields, so they are attached only
 * after the API key was verified for the project (guarantee G1). A failure to log never reaches
 * the caller (guarantee G4).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function emitBuildStep(c: Context<any> | undefined, ev: StepEvent): void {
  try {
    const fields: LineFields = { step: ev.step, outcome: ev.outcome };
    if (ev.buildId) fields.build_id = ev.buildId;
    if (ev.ms !== undefined) fields.ms = ev.ms;
    if (ev.attempt !== undefined) fields.attempt = ev.attempt;
    if (ev.chunk !== undefined) fields.chunk = ev.chunk;
    if (ev.chunksTotal !== undefined) fields.chunks_total = ev.chunksTotal;
    const reason = reasonField(ev.reason);
    if (reason) fields.reason = reason;
    if (ev.outcome === 'fail') log.warn('build.step', reqFields(c, fields));
    else log.info('build.step', reqFields(c, fields));
  } catch {
    // logging must never fail the request
  }
}
