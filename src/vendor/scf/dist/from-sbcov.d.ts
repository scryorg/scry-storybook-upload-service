import type { ScfManifest } from './types.js';
/** Mirrors Storybook's `toId(kind, name)` closely enough to reproduce the same identity that the
 *  dashboard's suggest feature already derives from `storyTitle` + `testName` when no `storyId`
 *  field is present in metadata.json (the normal case — see search-api-client.ts:208-228). This id
 *  is for capture identity only; the legacy storage key stays `basename(screenshotPath)` (contract §3,
 *  guarantee G1), so byte-identical web rows do not depend on this function. */
export declare function toStorybookId(title: string, name: string): string;
/**
 * Converts a legacy sbcov `metadata.json` (+ optional `sbcov-manifest.json`) into an SCF 1.0
 * manifest, per spec/scf-1.0.md "Compatibility". `links` (and so `links.live`) is left absent here:
 * sbcov's metadata.json has no build URL, so the caller (build processing) fills `links.live` in from
 * the build's Storybook view URL.
 *
 * `id` = `entry.storyId`/`entry.story_id` when it is a non-empty string (the normal case — sbcov has
 * always written this). Only when it is absent (bundles from sbcov versions older than the field) does
 * this fall back to deriving an id from `storyTitle` + `testName`, mirroring Storybook's own `toId` —
 * the same derivation the dashboard's suggest feature already uses (search-api-client.ts:208-228). Any
 * fallback is reported on the returned manifest as a `sbcov.id_derived` warning naming how many entries
 * were affected, since a derived id is not guaranteed to survive a Storybook rename.
 */
export declare function fromSbcov(metadataJson: unknown, manifestJson?: unknown): ScfManifest;
//# sourceMappingURL=from-sbcov.d.ts.map