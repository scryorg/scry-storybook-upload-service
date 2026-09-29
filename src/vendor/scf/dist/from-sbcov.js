const KNOWN_SKIP_REASONS = new Set(['error', 'timeout', 'filtered', 'unsupported', 'empty']);
function mapSkipReason(raw) {
    return raw && KNOWN_SKIP_REASONS.has(raw) ? raw : 'error';
}
const ID_SANITIZE_RE = /[ ,'’()!@#$%^&*+=<>{}[\]|\\;:/?.]+/g;
/** Mirrors Storybook's `toId(kind, name)` closely enough to reproduce the same identity that the
 *  dashboard's suggest feature already derives from `storyTitle` + `testName` when no `storyId`
 *  field is present in metadata.json (the normal case — see search-api-client.ts:208-228). This id
 *  is for capture identity only; the legacy storage key stays `basename(screenshotPath)` (contract §3,
 *  guarantee G1), so byte-identical web rows do not depend on this function. */
/** Trims leading/trailing `-` without a regex anchored on `$`, which sonarjs flags as
 *  super-linear: an unanchored quantifier run ending in a literal that never matches the
 *  string's actual end backtracks once per run position (O(n^2) on adversarial input). */
function trimDashes(value) {
    let start = 0;
    let end = value.length;
    while (start < end && value[start] === '-')
        start++;
    while (end > start && value[end - 1] === '-')
        end--;
    return value.slice(start, end);
}
export function toStorybookId(title, name) {
    const sanitize = (value) => trimDashes(value
        .toLowerCase()
        .replace(ID_SANITIZE_RE, '-')
        .replace(/-+/g, '-'));
    const kind = sanitize(title || 'unknown');
    const leaf = name ? sanitize(name) : '';
    return leaf ? `${kind}--${leaf}` : kind;
}
/** A non-empty `storyId` (or `story_id`) string from an entry, else `undefined` — a present-but-blank
 *  field counts as absent, the same as a missing one. */
function realStoryId(entry) {
    for (const raw of [entry.storyId, entry.story_id]) {
        if (typeof raw === 'string' && raw.length > 0)
            return raw;
    }
    return undefined;
}
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
export function fromSbcov(metadataJson, manifestJson) {
    const entries = Array.isArray(metadataJson)
        ? metadataJson
        : (metadataJson?.stories ?? []);
    const manifest = manifestJson;
    const withRepo = entries.find((e) => e.repository);
    let idDerivedCount = 0;
    const captures = entries.map((entry) => {
        const storyId = realStoryId(entry);
        let id;
        if (storyId) {
            id = storyId;
        }
        else {
            id = toStorybookId(entry.storyTitle ?? '', entry.testName ?? '');
            idDerivedCount++;
        }
        const capture = entry.capture
            ? {
                method: 'browser',
                viewport: entry.capture.viewport,
                scale: entry.capture.scale ?? entry.capture.dpr,
                size: entry.capture.imageSize,
                crop: entry.capture.mode === 'root' ? 'root' : 'viewport',
            }
            : undefined;
        const capObj = {
            id,
            image: entry.screenshotPath,
            kind: 'component',
            name: entry.testName,
            code: {
                file: entry.filepath,
                line: entry.location?.startLine,
                componentFile: entry.componentFilePath || undefined,
            },
            tags: [],
            'x-sbcov': { storyId: storyId ?? null },
        };
        if (entry.storyTitle)
            capObj.title = entry.storyTitle.split('/');
        if (capture)
            capObj.capture = capture;
        return capObj;
    });
    const dropped = manifest?.dropped ?? [];
    const result = {
        scf: '1.0',
        source: { kind: 'storybook', platform: 'web', tool: { name: 'scry-sbcov', version: manifest?.sbcovVersion } },
        counts: {
            declared: manifest?.declared ?? captures.length + dropped.length,
            captured: manifest?.captured ?? captures.length,
            skipped: dropped.map((d) => ({
                id: d.storyId ?? '(unknown)',
                reason: mapSkipReason(d.reason),
                detail: d.detail ?? d.reason,
            })),
        },
        captures,
    };
    if (withRepo?.repository) {
        result.repository = { url: withRepo.repository, commit: withRepo.commitSha, branch: withRepo.branch };
    }
    if (idDerivedCount > 0) {
        const warning = {
            code: 'sbcov.id_derived',
            message: `${idDerivedCount} of ${captures.length} capture id(s) had no storyId (or story_id) in metadata.json ` +
                'and were derived from storyTitle + testName instead. Derived ids are not guaranteed to survive a ' +
                'Storybook rename; upgrade sbcov to a version that writes storyId to avoid this.',
        };
        result.warnings = [warning];
    }
    return result;
}
//# sourceMappingURL=from-sbcov.js.map