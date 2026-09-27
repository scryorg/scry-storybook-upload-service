import { z } from 'zod';

/**
 * How much CI time a Scry deploy took, as the deployer measured it
 * (storybook-preview-ci-runtime, ISSUES.md #54; contract in that feature's plan.md
 * "Data, API and library surface").
 *
 * Every member is optional: a deployer that could not measure something sends
 * nothing for it, and the build document then has no such field. It never
 * becomes a 0, because a 0 reads as "Scry took no time" to the KPI routes and the
 * ci-time-budget alert.
 *
 * Numbers are bounded (non-negative, finite, under 24 h), strings are short and
 * plain, and unknown keys are dropped (zod's default strip), so a client cannot
 * park arbitrary data on the build document through this field.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const Ms = z.number().finite().nonnegative().lt(DAY_MS);
const Count = z.number().int().nonnegative().lt(1_000_000);
const ShortText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[\w .:@+\/()-]+$/, 'must be plain text');

/** Reason keys as sbcov writes them (`timeout`, `console_error`, `render_timeout`). */
const REASON_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_REASONS = 32;

/**
 * `timeLostMs` is a copy of sbcov's manifest `execution.timeLostMs`: a record of
 * short reason keys to milliseconds. An entry with an odd key or an out-of-range
 * value is dropped on its own (the rest of the block is still worth keeping);
 * the whole record is capped at 32 entries.
 */
const TimeLostMs = z.record(z.string(), z.unknown()).transform((record) => {
  const kept: Record<string, number> = {};
  for (const [key, value] of Object.entries(record)) {
    if (Object.keys(kept).length >= MAX_REASONS) break;
    if (!REASON_KEY.test(key)) continue;
    if (!Ms.safeParse(value).success) continue;
    kept[key] = value as number;
  }
  return kept;
});

export const CiTimingsSchema = z.object({
  analyzeMs: Ms.optional(),
  executeMs: Ms.optional(),
  executeSource: z.enum(['sbcov', 'deployer-wall']).optional(),
  archiveMs: Ms.optional(),
  uploadMs: Ms.optional(),
  deployerTotalMs: Ms.optional(),
  jobElapsedMs: Ms.optional(),
  jobTimeSource: z.enum(['actions-api', 'deployer-only']).optional(),
  /** Why the whole-job time is unknown: no-token, forbidden, timeout, not-github, … */
  jobTimeReason: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, 'must be a short kebab-case reason').optional(),
  stories: z
    .object({
      declared: Count.optional(),
      passed: Count.optional(),
      failed: Count.optional(),
      timeouts: Count.optional(),
      notIndexed: Count.optional(),
    })
    .optional(),
  timeLostMs: TimeLostMs.optional(),
  sbcovVersion: ShortText(64).optional(),
  deployerVersion: ShortText(64).optional(),
  runner: z.enum(['github-hosted', 'self-hosted', 'unknown']).optional(),
  ci: z
    .object({
      provider: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/).optional(),
      runId: z
        .union([z.string().regex(/^\d{1,20}$/, 'must be digits'), z.number().int().nonnegative()])
        .transform((v) => String(v))
        .optional(),
      runAttempt: z.number().int().min(1).max(1000).optional(),
      workflow: ShortText(200).optional(),
      job: ShortText(200).optional(),
    })
    .optional(),
  budgetMs: Ms.optional(),
  overBudget: z.boolean().optional(),
  /** Share of execute time spent on stories that failed, 0..1 (the >25% alert check). */
  failedTimeShare: z.number().finite().min(0).max(1).optional(),
  /** sbcov worker count the run used. */
  concurrency: z.number().int().min(1).max(64).optional(),
});

export type CiTimings = z.infer<typeof CiTimingsSchema>;

export type CiTimingsParse =
  | { status: 'absent' }
  | { status: 'invalid'; issues: string[] }
  | { status: 'ok'; ciTimings: CiTimings };

/** Drop keys whose value is undefined or an empty nested object, so nothing absent is written. */
function prune<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = prune(v as Record<string, unknown>);
      if (Object.keys(inner).length === 0) continue;
      out[k] = inner;
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/**
 * Validate a `ciTimings` block from a request body.
 *
 * `absent` when the client sent none (an older deployer), `invalid` with the
 * offending paths when any value is out of bounds, else the cleaned block.
 * A block that validates to nothing at all (`{}`, or only unknown keys) is
 * reported as absent: there is nothing to store.
 */
export function parseCiTimings(input: unknown): CiTimingsParse {
  if (input === undefined || input === null) return { status: 'absent' };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { status: 'invalid', issues: ['ciTimings: expected an object'] };
  }
  const result = CiTimingsSchema.safeParse(input);
  if (!result.success) {
    return {
      status: 'invalid',
      issues: result.error.issues.map((i) => `ciTimings.${i.path.join('.')}: ${i.message}`),
    };
  }
  const cleaned = prune(result.data as Record<string, unknown>) as CiTimings;
  if (Object.keys(cleaned).length === 0) return { status: 'absent' };
  return { status: 'ok', ciTimings: cleaned };
}

const NESTED: ReadonlyArray<keyof CiTimings> = ['stories', 'ci', 'timeLostMs'];

/**
 * Merge a later record into what the build already holds. Nested blocks merge
 * one level deep; later values win. Pure, so the same record applied twice
 * gives the same document (the route is idempotent).
 */
export function mergeCiTimings(existing: CiTimings | undefined, update: CiTimings): CiTimings {
  const merged: Record<string, unknown> = { ...(existing ?? {}), ...update };
  for (const key of NESTED) {
    const before = existing?.[key];
    const after = update[key];
    if (before && after && typeof before === 'object' && typeof after === 'object') {
      merged[key] = { ...(before as object), ...(after as object) };
    }
  }
  return merged as CiTimings;
}

/**
 * The key CI fields for the `storybook_uploaded` event, only those present.
 * Deployer and whole-job time arrive after the event fires, so they live on the
 * build document only.
 */
export function ciEventFields(ciTimings: CiTimings | undefined): Record<string, number | string | boolean> {
  if (!ciTimings) return {};
  return {
    ...(ciTimings.executeMs !== undefined ? { ciExecuteMs: ciTimings.executeMs } : {}),
    ...(ciTimings.runner !== undefined ? { ciRunner: ciTimings.runner } : {}),
    ...(ciTimings.stories?.declared !== undefined ? { ciStoryCount: ciTimings.stories.declared } : {}),
    ...(ciTimings.overBudget !== undefined ? { ciOverBudget: ciTimings.overBudget } : {}),
  };
}
