// build.step events (feature staff-builds-view). One structured log line per pipeline step, so a
// support person can answer "where is this build and why" from `scry-logs.py --build <id>`.
//
// The BUILD_STEPS and BUILD_STEP_OUTCOMES lists below are the same strings in scry-storybook-upload-service
// (src/lib/build-steps.ts) and scry-build-processing-service (src/lib/build-steps.ts); change both together.
// Upload emits the first four, build processing the rest. Every value is a lowercase code
// (^[a-z][a-z0-9_.]{0,47}$) so it passes the scry-log schema as-is.

import type { Context } from 'hono';
import { log, reqFields } from './log';
import { scrubString, type LineFields } from './scry-log';

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

/** `reason` is bounded to this many chars (the log schema allows 256). */
export const REASON_MAX = 200;

/** Scrub with the repo's scrubber, then bound. Returns undefined when nothing usable is left. Never throws. */
export function boundReason(raw: unknown): string | undefined {
  try {
    if (typeof raw !== 'string') return undefined;
    const cleaned = scrubString(raw.slice(0, 1024)).replace(/\s+/g, ' ').trim().slice(0, REASON_MAX);
    return cleaned.length > 0 ? cleaned : undefined;
  } catch {
    return undefined;
  }
}

export interface StepEvent {
  step: BuildStep;
  outcome: BuildStepOutcome;
  buildId?: string;
  ms?: number;
  attempt?: number;
  chunk?: number;
  chunksTotal?: number;
  /** Short fixed-ish reason; scrubbed and bounded here. Never an exception message from user data. */
  reason?: string;
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
    const reason = boundReason(ev.reason);
    if (reason) fields.reason = reason;
    if (ev.outcome === 'fail') log.warn('build.step', reqFields(c, fields));
    else log.info('build.step', reqFields(c, fields));
  } catch {
    // logging must never fail the request
  }
}
