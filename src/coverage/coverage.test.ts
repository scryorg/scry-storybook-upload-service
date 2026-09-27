import { describe, it, expect } from 'vitest';
import { extractGitContext, normalizeCoverageInput } from './coverage.js';

describe('normalizeCoverageInput()', () => {
  it('normalizes the spec-style payload into BuildCoverage', () => {
    const input = {
      reportUrl: 'https://example.invalid/original.json',
      summary: {
        componentCoverage: 0.9,
        propCoverage: 0.8,
        variantCoverage: 0.7,
        passRate: 0.95,
        totalComponents: 100,
        componentsWithStories: 80,
        failingStories: 2,
      },
      qualityGate: {
        passed: true,
        checks: [
          { name: 'componentCoverage', threshold: 0.8, actual: 0.9, passed: true },
        ],
      },
      generatedAt: '2026-01-01T00:00:00.000Z',
    };

    const normalized = normalizeCoverageInput(input, {
      reportUrl: 'https://r2.example/coverage-report.json',
    });

    expect(normalized.reportUrl).toBe('https://r2.example/coverage-report.json');
    expect(normalized.generatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(normalized.summary.componentCoverage).toBe(0.9);
    expect(normalized.qualityGate.passed).toBe(true);
  });

  it('normalizes the nested (metrics/health) payload into BuildCoverage', () => {
    const input = {
      summary: {
        metrics: {
          componentCoverage: 0.91,
          propCoverage: 0.81,
          variantCoverage: 0.71,
        },
        health: {
          passRate: 0.96,
          failingStories: 1,
        },
        totalComponents: 50,
        componentsWithStories: 45,
      },
      qualityGate: {
        passed: false,
        checks: [
          { name: 'passRate', threshold: 0.98, actual: 0.96, passed: false },
        ],
      },
      generatedAt: '2026-01-02T00:00:00.000Z',
    };

    const normalized = normalizeCoverageInput(input, {
      reportUrl: 'https://r2.example/coverage-report.json',
    });

    expect(normalized.summary).toEqual({
      componentCoverage: 0.91,
      propCoverage: 0.81,
      variantCoverage: 0.71,
      passRate: 0.96,
      totalComponents: 50,
      componentsWithStories: 45,
      failingStories: 1,
    });
  });

  it('throws on invalid payloads', () => {
    expect(() =>
      normalizeCoverageInput(
        {
          summary: { componentCoverage: 'nope' },
          qualityGate: { passed: true, checks: [] },
          generatedAt: '2026-01-01',
        },
        { reportUrl: 'https://r2.example/coverage-report.json' }
      )
    ).toThrow();
  });
});

// P13a: scry-sbcov has always written the commit into the coverage report and
// the normaliser has always dropped it, so a build knew its deploy but not its
// code (roadmap-open-questions-code-answers.md B.2).
describe('extractGitContext()', () => {
  it('reads the coverage report\'s nested git object', () => {
    expect(
      extractGitContext({
        git: {
          commitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
          branch: 'main',
          baseBranch: 'main',
          baseCommitSha: 'ffff',
        },
      })
    ).toEqual({ commitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', branch: 'main' });
  });

  it('accepts a flat commitSha/branch pair', () => {
    expect(extractGitContext({ commitSha: 'abc1234', branch: 'release' })).toEqual({
      commitSha: 'abc1234',
      branch: 'release',
    });
  });

  // A report generated with git analysis disabled carries empty strings. That
  // is the report saying "unknown"; it must not become a build's commit.
  it('treats the empty strings of a git-less report as unknown', () => {
    expect(extractGitContext({ git: { commitSha: '', branch: '', baseBranch: null, baseCommitSha: null } })).toEqual({});
  });

  it('returns nothing for a payload with no git information at all', () => {
    expect(extractGitContext({ summary: {} })).toEqual({});
    expect(extractGitContext(undefined)).toEqual({});
    expect(extractGitContext(null)).toEqual({});
  });

  it('returns only the member it knows', () => {
    expect(extractGitContext({ git: { branch: 'main' } })).toEqual({ branch: 'main' });
  });
});

// storybook-preview-ci-runtime: sbcov's report has always carried how long
// execution took; the normaliser dropped it, so builds from deployer 0.7.x
// recorded no execute time at all.
describe('normalizeCoverageInput() coverage.execution', () => {
  const base = {
    summary: {
      componentCoverage: 0.9,
      propCoverage: 0.8,
      variantCoverage: 0.7,
      passRate: 0.95,
      totalComponents: 100,
      componentsWithStories: 80,
      failingStories: 2,
    },
    qualityGate: { passed: true, checks: [] },
    generatedAt: '2026-09-27T00:00:00.000Z',
  };
  const opts = { reportUrl: 'https://r2.example/coverage-report.json' };

  it('regression-storybook-preview-ci-runtime: keeps execution.summary as coverage.execution', () => {
    const normalized = normalizeCoverageInput(
      {
        ...base,
        execution: {
          executed: true,
          executedAt: '2026-09-27T00:00:00.000Z',
          summary: { total: 461, passed: 417, failed: 44, skipped: 0, duration: 1_064_000, declared: 461, notIndexed: 44 },
          stories: [],
        },
      },
      opts
    );
    expect(normalized.execution).toEqual({
      durationMs: 1_064_000,
      total: 461,
      passed: 417,
      failed: 44,
      notIndexed: 44,
    });
  });

  it('prefers durationMs when a newer sbcov sends it', () => {
    const normalized = normalizeCoverageInput(
      { ...base, execution: { summary: { total: 1, passed: 1, failed: 0, duration: 5, durationMs: 212_000 } } },
      opts
    );
    expect(normalized.execution?.durationMs).toBe(212_000);
  });

  it('guarantee-7 absent-not-zero: no execution in the report means no coverage.execution, and missing members stay missing', () => {
    expect('execution' in normalizeCoverageInput(base, opts)).toBe(false);
    expect('execution' in normalizeCoverageInput({ ...base, execution: null }, opts)).toBe(false);
    expect('execution' in normalizeCoverageInput({ ...base, execution: { executed: false } }, opts)).toBe(false);
    // sbcov writes zeros when it did not execute: that is "not run", not "ran in 0 ms".
    expect(
      'execution' in
        normalizeCoverageInput(
          { ...base, execution: { executed: false, summary: { total: 0, passed: 0, failed: 0, skipped: 0, duration: 0, notIndexed: 0 } } },
          opts
        )
    ).toBe(false);

    const partial = normalizeCoverageInput(
      { ...base, execution: { summary: { total: 3, passed: 3, failed: 0, duration: -1, notIndexed: 'x' } } },
      opts
    );
    expect(partial.execution).toEqual({ total: 3, passed: 3, failed: 0 });
  });
});
