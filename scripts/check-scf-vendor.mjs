#!/usr/bin/env node
/**
 * Fails if the vendored @scrymore/scf copy in src/vendor/scf/ is stale (contract §2).
 *
 * scryorg/scry-capture-format has no version tags yet (it isn't published to npm — see the
 * contract's vendoring note), so "the latest tag" falls back to the `stage` branch's tip commit,
 * the same ref every other capture-sources PR builds against. Once that repo starts cutting tags,
 * switch the primary check back to them and drop the fallback.
 *
 * Requires `gh` authenticated against scryorg (this box already is). If `gh` isn't available or the
 * API call fails — no network, no auth, run somewhere else — this prints a warning and exits 0
 * rather than failing a build that has nothing to do with connectivity; it's a developer/CI
 * convenience, not a hard gate on every PR.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = 'scryorg/scry-capture-format';
const VERSION_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'vendor', 'scf', 'VERSION');

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' }).trim();
}

function latestRef() {
  // Preferred: a real release tag, once the repo has one.
  try {
    const sha = gh(['api', `repos/${REPO}/tags`, '--jq', '.[0].commit.sha']);
    if (sha) return { sha, source: 'latest tag' };
  } catch {
    // fall through to the branch fallback
  }
  // Fallback: no tags yet — compare against `stage`'s tip, same ref every capture-sources PR uses.
  const sha = gh(['api', `repos/${REPO}/commits/stage`, '--jq', '.sha']);
  return { sha, source: "stage branch HEAD (no tags exist yet in scry-capture-format)" };
}

function main() {
  const vendored = readFileSync(VERSION_FILE, 'utf8').trim();

  let latest;
  try {
    latest = latestRef();
  } catch (e) {
    console.warn(
      `[check-scf-vendor] Could not reach ${REPO} via 'gh api' (no auth / no network / gh missing): ${e.message}`
    );
    console.warn('[check-scf-vendor] Skipping the freshness check (not failing the build for a connectivity issue).');
    process.exit(0);
  }

  if (latest.sha === vendored) {
    console.log(`[check-scf-vendor] src/vendor/scf/ is current: ${vendored} matches ${latest.source}.`);
    process.exit(0);
  }

  console.error(
    `[check-scf-vendor] src/vendor/scf/ is STALE.\n` +
      `  vendored: ${vendored}\n` +
      `  ${latest.source}: ${latest.sha}\n` +
      `Re-vendor: clone ${REPO} at ${latest.sha}, 'nvm use v22.19.0', 'npm ci && npm run build' in packages/scf,\n` +
      `copy dist/ into src/vendor/scf/dist/, and write ${latest.sha} into src/vendor/scf/VERSION.`
  );
  process.exit(1);
}

main();
