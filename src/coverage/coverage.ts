import { z } from 'zod';
import type { BuildCoverage, CoverageExecution, CoverageSummary, QualityGateResult } from '../services/firestore/firestore.types.js';

/**
 * A normalized summary we store on Firestore build documents.
 */
export const CoverageSummarySchema = z.object({
  componentCoverage: z.number(),
  propCoverage: z.number(),
  variantCoverage: z.number(),
  passRate: z.number(),
  totalComponents: z.number(),
  componentsWithStories: z.number(),
  failingStories: z.number(),
});

export const QualityGateCheckSchema = z.object({
  name: z.string(),
  threshold: z.number(),
  actual: z.number(),
  passed: z.boolean(),
});

export const QualityGateResultSchema = z.object({
  passed: z.boolean(),
  checks: z.array(QualityGateCheckSchema),
});

/**
 * "Spec" style payload (explicit summary fields).
 *
 * We keep this permissive via passthrough to allow adding new fields
 * without breaking older clients.
 */
export const CoverageInputSpecSchema = z
  .object({
    reportUrl: z.string().url().optional(),
    summary: CoverageSummarySchema,
    qualityGate: QualityGateResultSchema,
    generatedAt: z.string(),
  })
  .passthrough();

/**
 * "Nested" style payload (summary.metrics + summary.health), which appears in the spec examples.
 */
export const CoverageInputNestedSchema = z
  .object({
    reportUrl: z.string().url().optional(),
    summary: z
      .object({
        metrics: z
          .object({
            componentCoverage: z.number(),
            propCoverage: z.number(),
            variantCoverage: z.number(),
          })
          .passthrough(),
        health: z
          .object({
            passRate: z.number(),
            failingStories: z.number(),
          })
          .passthrough(),
        totalComponents: z.number(),
        componentsWithStories: z.number(),
      })
      .passthrough(),
    qualityGate: QualityGateResultSchema,
    generatedAt: z.string(),
  })
  .passthrough();

/**
 * Any accepted input shape.
 */
export const CoverageInputSchema = z.union([CoverageInputSpecSchema, CoverageInputNestedSchema]);

export type CoverageInput = z.infer<typeof CoverageInputSchema>;

export type NormalizeCoverageOptions = {
  /**
   * The R2 URL where the raw JSON was uploaded.
   *
   * This is used as the canonical BuildCoverage.reportUrl.
   */
  reportUrl: string;
};

/**
 * The commit and branch a coverage report was generated from.
 *
 * scry-sbcov has always written these into the report as `git.commitSha` and
 * `git.branch` (see the coverage report's GitContext), and the normaliser has
 * always thrown them away — they reached R2 inside the raw JSON and got no
 * further, so a build document knew which deploy it was but never which commit
 * (roadmap-open-questions-code-answers.md B.2).
 *
 * Both members are optional and never defaulted. A report generated with git
 * analysis disabled carries `commitSha: ""`, which is the report's way of
 * saying "unknown" and must not become a build's commit.
 */
export type BuildGitContext = {
  commitSha?: string;
  branch?: string;
};

/**
 * Pull the build's commit and branch out of a coverage payload.
 *
 * Accepts both the report's nested `git` object and a flat `commitSha` /
 * `branch` pair, because the payload shape has varied before and the cost of
 * accepting one more spelling is a line.
 */
export function extractGitContext(input: unknown): BuildGitContext {
  const payload = (input ?? {}) as Record<string, any>;
  const git = (payload.git ?? {}) as Record<string, any>;

  const str = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

  const commitSha = str(git.commitSha) ?? str(payload.commitSha);
  const branch = str(git.branch) ?? str(payload.branch);

  return {
    ...(commitSha ? { commitSha } : {}),
    ...(branch ? { branch } : {}),
  };
}

/**
 * sbcov's own execution summary, kept as `coverage.execution`
 * (storybook-preview-ci-runtime, ISSUES.md #54).
 *
 * The report has always said how long story execution took
 * (`execution.summary.duration`, ms) and how it went; the normaliser dropped it,
 * so a build from deployer 0.7.x recorded no execute time anywhere. Each member
 * is kept only when it is a finite non-negative number; the whole block is
 * absent when the report ran no execution. Never a made-up 0.
 */
export function extractCoverageExecution(input: unknown): CoverageExecution | undefined {
  const execution = (input as Record<string, any> | null | undefined)?.execution;
  if (!execution || typeof execution !== 'object') return undefined;
  const summary = execution.summary;
  if (!summary || typeof summary !== 'object') return undefined;

  const num = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

  const picked: CoverageExecution = {
    durationMs: num(summary.durationMs) ?? num(summary.duration),
    total: num(summary.total),
    passed: num(summary.passed),
    failed: num(summary.failed),
    notIndexed: num(summary.notIndexed),
  };
  const kept = Object.fromEntries(
    Object.entries(picked).filter(([, v]) => v !== undefined)
  ) as CoverageExecution;
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/**
 * Normalize multiple client coverage payload shapes into the stable Firestore shape.
 */
export function normalizeCoverageInput(input: unknown, options: NormalizeCoverageOptions): BuildCoverage {
  const parsed = CoverageInputSchema.parse(input);

  // Distinguish nested vs spec style by checking presence of summary.metrics.
  const anyParsed: any = parsed;

  const summary: CoverageSummary = anyParsed.summary?.metrics
    ? {
        componentCoverage: anyParsed.summary.metrics.componentCoverage,
        propCoverage: anyParsed.summary.metrics.propCoverage,
        variantCoverage: anyParsed.summary.metrics.variantCoverage,
        passRate: anyParsed.summary.health.passRate,
        totalComponents: anyParsed.summary.totalComponents,
        componentsWithStories: anyParsed.summary.componentsWithStories,
        failingStories: anyParsed.summary.health.failingStories,
      }
    : (anyParsed.summary as CoverageSummary);

  const qualityGate: QualityGateResult = anyParsed.qualityGate;

  const execution = extractCoverageExecution(input);

  return {
    reportUrl: options.reportUrl,
    summary,
    qualityGate,
    generatedAt: anyParsed.generatedAt,
    ...(execution ? { execution } : {}),
  };
}
