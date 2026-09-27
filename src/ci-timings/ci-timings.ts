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
/**
 * Any printable string up to `max` characters: workflow and job names are
 * free text (`Build & test, it's #1`). Control and format characters are
 * refused so nothing can smuggle terminal escapes or NULs into logs or docs.
 */
const ShortText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}\p{Cf}]+$/u, 'must be printable text');

/** Reason keys as sbcov writes them (`timeout`, `console_error`, `render_timeout`). */
const REASON_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_REASONS = 32;

const StoriesShape = {
  declared: Count,
  passed: Count,
  failed: Count,
  timeouts: Count,
  notIndexed: Count,
};

const CiShape = {
  provider: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, 'must be a short lowercase id'),
  runId: z
    .union([z.string().regex(/^\d{1,20}$/, 'must be digits'), z.number().int().nonnegative()])
    .transform((v) => String(v)),
  runAttempt: z.number().int().min(1).max(1000),
  workflow: ShortText(200),
  job: ShortText(200),
};

/** Top-level leaves. `stories`, `ci` and `timeLostMs` are nested and handled below. */
const LeafShape = {
  analyzeMs: Ms,
  executeMs: Ms,
  executeSource: z.enum(['sbcov', 'deployer-wall']),
  archiveMs: Ms,
  uploadMs: Ms,
  deployerTotalMs: Ms,
  jobElapsedMs: Ms,
  jobTimeSource: z.enum(['actions-api', 'deployer-only']),
  /** Why the whole-job time is unknown: no-token, forbidden, timeout, not-github, … */
  jobTimeReason: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, 'must be a short kebab-case reason'),
  sbcovVersion: ShortText(64),
  deployerVersion: ShortText(64),
  runner: z.enum(['github-hosted', 'self-hosted', 'unknown']),
  budgetMs: Ms,
  overBudget: z.boolean(),
  /** Share of execute time spent on stories that failed, 0..1 (the >25% alert check). */
  failedTimeShare: z.number().finite().min(0).max(1),
  /** sbcov worker count the run used. */
  concurrency: z.number().int().min(1).max(64),
};

type Leaves<S extends Record<string, z.ZodTypeAny>> = { [K in keyof S]?: z.output<S[K]> };

export type CiTimings = Leaves<typeof LeafShape> & {
  stories?: Leaves<typeof StoriesShape>;
  ci?: Leaves<typeof CiShape>;
  /** Copy of sbcov's manifest `execution.timeLostMs`: reason key -> ms. */
  timeLostMs?: Record<string, number>;
};

export type CiTimingsParse =
  | { status: 'absent' }
  | { status: 'invalid'; issues: string[] }
  | { status: 'ok'; ciTimings: CiTimings; dropped: string[] };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Validate each leaf on its own: a leaf that fails is dropped and its path
 * reported, the rest is kept. Unknown keys are ignored (never stored).
 */
function pickLeaves(
  input: Record<string, unknown>,
  shape: Record<string, z.ZodTypeAny>,
  prefix: string,
  dropped: string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(shape)) {
    if (!(key in input) || input[key] === undefined) continue;
    const r = schema.safeParse(input[key]);
    if (r.success) out[key] = r.data;
    else dropped.push(`${prefix}.${key}`);
  }
  return out;
}

/**
 * Validate a `ciTimings` block from a request body (storybook-preview-ci-runtime).
 *
 * - `absent`: the client sent none (an older deployer), or only unknown keys.
 * - `invalid`: a structural problem (not an object, or `stories` / `ci` /
 *   `timeLostMs` not objects), or every field it sent was out of bounds; the
 *   issues name the paths.
 * - `ok`: the cleaned block, plus the paths of individual fields that were out
 *   of bounds and dropped (a negative number, a 25 h duration, an unknown
 *   runner, a string with control characters). One bad field never costs the
 *   rest of the record.
 */
export function parseCiTimings(input: unknown): CiTimingsParse {
  if (input === undefined || input === null) return { status: 'absent' };
  if (!isPlainObject(input)) {
    return { status: 'invalid', issues: ['ciTimings: expected an object'] };
  }
  const structural: string[] = [];
  for (const key of ['stories', 'ci', 'timeLostMs'] as const) {
    if (input[key] !== undefined && !isPlainObject(input[key])) structural.push(`ciTimings.${key}: expected an object`);
  }
  if (structural.length > 0) return { status: 'invalid', issues: structural };

  const dropped: string[] = [];
  const out: Record<string, unknown> = pickLeaves(input, LeafShape, 'ciTimings', dropped);

  if (isPlainObject(input.stories)) {
    const stories = pickLeaves(input.stories, StoriesShape, 'ciTimings.stories', dropped);
    if (Object.keys(stories).length > 0) out.stories = stories;
  }
  if (isPlainObject(input.ci)) {
    const ci = pickLeaves(input.ci, CiShape, 'ciTimings.ci', dropped);
    if (Object.keys(ci).length > 0) out.ci = ci;
  }
  if (isPlainObject(input.timeLostMs)) {
    const kept: Record<string, number> = {};
    for (const [key, value] of Object.entries(input.timeLostMs)) {
      if (!REASON_KEY.test(key) || !Ms.safeParse(value).success || Object.keys(kept).length >= MAX_REASONS) {
        // The key is client text: report a safe, bounded form of it.
        dropped.push(`ciTimings.timeLostMs.${key.replace(/[^a-z0-9_]/gi, '?').slice(0, 40)}`);
        continue;
      }
      kept[key] = value as number;
    }
    // `{}` is meaningful: sbcov lost no time to failures (absent means an older
    // sbcov that does not report it), and the ci-time-budget alert tells the two
    // apart. Keep `{}` when `{}` was sent; a record whose every entry was dropped
    // stays absent, because storing `{}` would claim nothing was lost.
    const sentEntries = Object.keys(input.timeLostMs).length;
    if (Object.keys(kept).length > 0 || sentEntries === 0) out.timeLostMs = kept;
  }

  if (Object.keys(out).length === 0) {
    return dropped.length > 0
      ? { status: 'invalid', issues: dropped.map((p) => `${p}: out of bounds`) }
      : { status: 'absent' };
  }
  return { status: 'ok', ciTimings: out as CiTimings, dropped };
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
