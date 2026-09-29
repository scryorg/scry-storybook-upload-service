import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';

// F13 (Sonar lint pass): this repo had NO eslint config at all before capture-sources' lint PR, so
// wiring up typescript-eslint's recommended rules alongside sonarjs surfaced pre-existing debt in
// files capture-sources never touched (repo-health H4 "lint unconfigured") -- not just from
// sonarjs/* rules, but from @typescript-eslint/* ones too (mostly no-explicit-any). The mechanical
// fallback demotes every rule that has an out-of-scope finding today to 'warn', so `eslint .
// --max-warnings <N>` in package.json's "lint" script still fails on a NEW error/regression while
// not blocking CI on the 138 pre-existing out-of-scope findings measured on 2026-09-29 (see the
// capture-sources progress log, cs-lint-upload.log, for the exact count and how it was reached).
//
// This list is the exact ruleIds that finding set contains today -- NOT `Object.keys(sonarjs.rules)`
// (all 295 rules the plugin ships, most of which `sonarjs.configs.recommended` itself leaves off).
// Spreading that wholesale would silently turn on ~65 rules recommended never enabled (file-header,
// cyclomatic-complexity, no-duplicate-string, etc.), inflating the warning count by 5x on files this
// repo never asked to be checked against those rules.
const outOfScopeDebtRules = {
  'sonarjs/unused-import': 'warn',
  'sonarjs/no-os-command-from-path': 'warn',
  'sonarjs/cognitive-complexity': 'warn',
  'sonarjs/prefer-specific-assertions': 'warn',
  'sonarjs/no-nested-conditional': 'warn',
  'sonarjs/no-floating-point-equality': 'warn',
  'sonarjs/assertions-in-tests': 'warn',
  'sonarjs/void-use': 'warn',
  'sonarjs/duplicates-in-character-class': 'warn',
  '@typescript-eslint/no-explicit-any': 'warn',
  '@typescript-eslint/no-require-imports': 'warn',
  '@typescript-eslint/ban-ts-comment': 'warn',
  'prefer-const': 'warn',
};

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'artifacts/**',
      // Vendored @scrymore/scf build — copied dist/, not authored in this repo.
      // See src/vendor/scf/VERSION for the upstream source sha.
      'src/vendor/scf/**',
      // Vendored scry-log (scry-management/lib/scry-log, synced by sync.sh --check in CI): fix upstream, never here.
      'src/lib/scry-log/**',
    ],
  },
  ...tseslint.configs.recommended,
  sonarjs.configs.recommended,
  {
    rules: {
      // This codebase's existing convention for an intentionally-unused parameter,
      // binding or destructured field is a leading underscore (e.g. `_hint`, `_p`,
      // `_omit`) — recognize it instead of flagging every one individually.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // sonarjs/no-unused-vars wraps core no-unused-vars but (unlike the
      // typescript-eslint rule above) accepts no options, so it can't recognize
      // the leading-underscore convention — off in favor of the configurable one.
      'sonarjs/no-unused-vars': 'off',
      ...outOfScopeDebtRules,
    },
  },
);
