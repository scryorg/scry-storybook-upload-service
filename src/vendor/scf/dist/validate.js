import { fromSbcov } from './from-sbcov.js';
import { readImageDimensions } from './image-dimensions.js';
import { sidecarCapturesFromImages } from './sidecars-internal.js';
import { bundleFileFull, bundleFileHead, bundleFileSize, isCheckedBundleFile } from './types.js';
const SUPPORTED_SCF_VERSIONS = new Set(['1.0']);
const ALLOWED_IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp']);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 16384;
const MAX_STRUCTURE_BYTES = 2 * 1024 * 1024; // soft (warning) threshold, spec's SHOULD
const MAX_STRUCTURE_HARD_BYTES = 10 * 1024 * 1024; // hard (error) threshold
const MAX_SOURCE_TEXT_BYTES = 1 * 1024 * 1024;
const MAX_LINK_URL_LENGTH = 2048;
const decoder = new TextDecoder();
function extOf(path) {
    const m = /\.([a-zA-Z0-9]+)$/.exec(path);
    return m ? m[1].toLowerCase() : '';
}
/**
 * The only two member prefixes a `{checked: true, size}` entry (ledger F60) is ever accepted for —
 * a streaming caller may only skip retaining full bytes for these, since `checkStructureMember`/
 * `checkSourceTextMember` are the only two extracted per-member checks this package exposes for
 * that purpose. Anything else (scf.json, sidecar JSON, an image) must still be supplied in full or
 * as the images-only `{head, size}` shape (F50).
 */
function isCheckableStructureOrSourcePath(path) {
    return (path.startsWith('structure/') && extOf(path) === 'json') || path.startsWith('source/');
}
const EXT_FAMILY = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp' };
/** Sniffs the magic bytes so a `.png` with the wrong content (or vice versa) is still caught. */
function detectImageFamily(bytes) {
    if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
        return 'png';
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return 'jpeg';
    }
    if (bytes.length >= 12 &&
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50) {
        return 'webp';
    }
    return null;
}
function issue(code, message, extra) {
    return { code, message, ...extra };
}
/** Reads a directory recursively into a BundleFiles map. Node only — never imported by a Worker
 *  build, since callers only reach this path when `input` is a string (a filesystem path). */
/**
 * Ledger F27: every bundle path (members and paths a capture references) must be a plain relative
 * POSIX path inside the bundle — no absolute paths, drive letters, backslashes, empty, `.` or `..`
 * segments. Nothing writes raw paths to storage today (keys are hash-derived), but the validator is
 * the shared G6/G7 gate, so it refuses them outright instead of relying on every consumer.
 */
export function isSafeRelPath(path) {
    if (path.length === 0 || path.length > 1024)
        return false;
    if (path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path) || path.includes('\0'))
        return false;
    return path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}
async function readDir(dir) {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const files = new Map();
    async function walk(current, rel) {
        const entries = await fs.readdir(current, { withFileTypes: true });
        for (const entry of entries) {
            const abs = path.join(current, entry.name);
            const relPath = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                await walk(abs, relPath);
            }
            else if (entry.isFile()) {
                const buf = await fs.readFile(abs);
                files.set(relPath.split(path.sep).join('/'), new Uint8Array(buf));
            }
        }
    }
    await walk(dir, '');
    return files;
}
function parseJson(files, path) {
    const bytes = bundleFileFull(files.get(path));
    if (bytes === undefined)
        throw new Error(`${path} must be supplied in full, not as a {head, size} entry`);
    return JSON.parse(decoder.decode(bytes));
}
/**
 * `links.live` is auto-embedded as an iframe wherever Storybook is embedded today (contract §8);
 * `links.page` is rendered as a clickable link. Both are adapter-controlled (any CI job holding the
 * project's API key, on every capture) — a much wider surface than today's single admin-configured
 * Storybook URL. Security review finding #1 / ledger F18: reject anything that isn't an absolute
 * `https:` URL with no embedded credentials, so a malicious or compromised adapter can't set
 * `javascript:`, `data:`, plain `http:`, or a userinfo-bearing URL. This does not by itself make
 * embedding *safe* — see spec/scf-1.0.md's `links.live` row: a reader MUST NOT actually embed it
 * unless its origin is one already trusted for that project.
 */
function checkLinkIsSafeHttps(url) {
    if (url.length > MAX_LINK_URL_LENGTH)
        return false;
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return false;
    }
    if (parsed.protocol !== 'https:')
        return false;
    if (parsed.username !== '' || parsed.password !== '')
        return false;
    return true;
}
const BINARY_MAGIC_PREFIXES = [
    [0x89, 0x50, 0x4e, 0x47], // PNG
    [0xff, 0xd8, 0xff], // JPEG
    [0x47, 0x49, 0x46, 0x38], // GIF8
    [0x50, 0x4b, 0x03, 0x04], // ZIP (also docx/xlsx/jar/…)
    [0x50, 0x4b, 0x05, 0x06], // empty ZIP
    [0x7f, 0x45, 0x4c, 0x46], // ELF
    [0x1f, 0x8b], // gzip
    [0x25, 0x50, 0x44, 0x46], // %PDF
    [0x52, 0x49, 0x46, 0x46], // RIFF (webp/wav/avi)
];
function startsWithAny(bytes, prefixes) {
    return prefixes.some((prefix) => prefix.length <= bytes.length && prefix.every((b, i) => bytes[i] === b));
}
/**
 * `sourceText` is meant to hold plain source code, copied verbatim into the bundle (spec:
 * "opt-in only"). Security review finding #2 / ledger F24: reject anything that isn't actually
 * UTF-8 text — a NUL byte, a recognised binary magic number, or a decode failure — so a
 * `sourceText.file` can't be used to smuggle an arbitrary binary (or an executable-flavoured file
 * masquerading as "source") past the member allow-list.
 */
function looksLikeBinary(bytes) {
    if (startsWithAny(bytes, BINARY_MAGIC_PREFIXES))
        return true;
    const scanLength = Math.min(bytes.length, 8192);
    for (let i = 0; i < scanLength; i++) {
        if (bytes[i] === 0x00)
            return true;
    }
    return false;
}
function isValidUtf8(bytes) {
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return true;
    }
    catch {
        return false;
    }
}
/** Loose shape check for scf-tree/1 (spec/scf-1.0.md) — not a full recursive schema validation,
 *  just enough to confirm this is actually a structure tree and not an arbitrary JSON payload. */
function looksLikeScfTree(parsed) {
    if (!parsed || typeof parsed !== 'object')
        return false;
    const tree = parsed;
    if (tree.format !== 'scf-tree/1')
        return false;
    if (!tree.root || typeof tree.root !== 'object')
        return false;
    return typeof tree.root.type === 'string';
}
/**
 * The content checks `validateBundle` applies to a `structure.file` member — a hard 10 MB size cap,
 * a 2 MB soft (warning) threshold, and a shape check (parses as JSON and looks like a scf-tree/1
 * document). Extracted (ledger F60) so a caller that streams a large bundle member-by-member rather
 * than buffering the whole thing (e.g. a Worker-safe bundle-upload route, or `scry-build-processing-
 * service`'s own streaming read) can run exactly these checks the moment a `structure/*.json` member
 * is fully inflated, record the result, and then discard the bytes — passing `{checked: true, size}`
 * for that member to `validateBundle` afterwards instead of its full content (see `BundleFileChecked`).
 * `path` is only used in issue messages/paths, never re-derived from it; the caller decides which
 * member this is. Returns no `id` — the caller (`validateBundle`, or a streaming caller once it has
 * matched this path back to a capture) attaches that itself.
 */
export function checkStructureMember(path, bytes) {
    const errors = [];
    const warnings = [];
    if (bytes.byteLength > MAX_STRUCTURE_HARD_BYTES) {
        errors.push(issue('STRUCTURE_TREE_TOO_LARGE', `structure file is over 10 MB: ${path}`, { path }));
        return { errors, warnings };
    }
    if (bytes.byteLength > MAX_STRUCTURE_BYTES) {
        warnings.push(issue('STRUCTURE_TREE_LARGE', `structure file is over 2 MB: ${path}`, { path }));
    }
    let parsedTree;
    try {
        parsedTree = JSON.parse(decoder.decode(bytes));
    }
    catch {
        parsedTree = undefined;
    }
    if (!looksLikeScfTree(parsedTree)) {
        errors.push(issue('STRUCTURE_FORMAT_INVALID', `structure.file does not parse as a scf-tree/1 document: ${path}`, { path }));
    }
    return { errors, warnings };
}
/**
 * The content checks `validateBundle` applies to a `sourceText.file` member — a 1 MB size cap and a
 * plausible-UTF-8-text check (`looksLikeBinary`/`isValidUtf8`, ledger F24). Extracted (ledger F60)
 * for the same streaming reason as `checkStructureMember` above — see its doc comment.
 *
 * `optedIn` is a fast-path only: when a caller already knows, at check time, that the manifest does
 * NOT set `optIn.sourceText: true` (e.g. it read `scf.json` earlier in the same stream), passing
 * `false` raises `SOURCE_TEXT_NOT_OPT_IN` immediately for this member instead of spending time on the
 * size/binary/UTF-8 scan. It is never required for correctness: `validateBundle`'s own aggregate
 * `SOURCE_TEXT_NOT_OPT_IN` check (across every capture, once the whole manifest is known) is always
 * the source of truth and runs regardless, which is why `validateBundle` itself always calls this
 * with `optedIn: true` — it would otherwise duplicate its own aggregate error.
 */
export function checkSourceTextMember(path, bytes, optedIn) {
    const errors = [];
    const warnings = [];
    if (bytes.byteLength > MAX_SOURCE_TEXT_BYTES) {
        errors.push(issue('SOURCE_TEXT_TOO_LARGE', `sourceText.file is over 1 MB: ${path}`, { path }));
    }
    else if (looksLikeBinary(bytes) || !isValidUtf8(bytes)) {
        errors.push(issue('SOURCE_TEXT_NOT_TEXT', `sourceText.file is not valid UTF-8 text: ${path}`, { path }));
    }
    if (optedIn === false) {
        errors.push(issue('SOURCE_TEXT_NOT_OPT_IN', `sourceText.file present but the manifest does not set optIn.sourceText: true: ${path}`, { path }));
    }
    return { errors, warnings };
}
/**
 * Validates an SCF bundle (or a legacy sbcov bundle, converted first) against spec/scf-1.0.md.
 * `input` is either an in-memory bundle (a Map of bundle-relative POSIX path -> bytes — the shape
 * a Worker or the upload service already has after reading a ZIP) or a directory path (Node only).
 */
export async function validateBundle(input) {
    const files = typeof input === 'string' ? await readDir(input) : input;
    const errors = [];
    const warnings = [];
    const unsafeMembers = [...files.keys()].filter((p) => !isSafeRelPath(p));
    if (unsafeMembers.length > 0) {
        for (const p of unsafeMembers) {
            errors.push(issue('UNSAFE_PATH', `Bundle member has an unsafe path (absolute, backslash, "." or ".."): ${JSON.stringify(p)}`, { path: p }));
        }
        return { ok: false, errors, warnings, manifest: null };
    }
    // Ledger F50: the {head, size} shape is for images only. Ledger F60: a NEW, distinct shape,
    // {checked: true, size}, is additionally accepted for structure/*.json and source/* members only —
    // it means a streaming caller already ran checkStructureMember/checkSourceTextMember against this
    // member's full inflated bytes, recorded whatever issues that produced, and discarded the bytes to
    // stay within a bounded memory budget. Any other member given either partial shape (including a
    // {checked, size} entry outside those two prefixes, or a {head, size} entry that isn't an image) is
    // refused outright, so scf.json, sidecars and anything not explicitly exempted are always validated
    // from their full bytes.
    const partialNonImages = [...files.entries()]
        .filter(([p, entry]) => {
        if (entry instanceof Uint8Array)
            return false;
        if (isCheckedBundleFile(entry))
            return !isCheckableStructureOrSourcePath(p);
        return !ALLOWED_IMAGE_EXT.has(extOf(p));
    })
        .map(([p]) => p);
    if (partialNonImages.length > 0) {
        for (const p of partialNonImages) {
            errors.push(issue('MEMBER_BYTES_REQUIRED', `Only images may be supplied as {head, size}; ${p} must be supplied in full.`, { path: p }));
        }
        return { ok: false, errors, warnings, manifest: null };
    }
    let manifest;
    let isLegacy = false;
    if (files.has('scf.json')) {
        try {
            manifest = parseJson(files, 'scf.json');
        }
        catch {
            errors.push(issue('SCF_JSON_INVALID', 'scf.json is not valid JSON.', { path: 'scf.json' }));
            return { ok: false, errors, warnings, manifest: null };
        }
    }
    else if (files.has('metadata.json')) {
        isLegacy = true;
        try {
            const metadataJson = parseJson(files, 'metadata.json');
            const manifestJson = files.has('sbcov-manifest.json') ? parseJson(files, 'sbcov-manifest.json') : undefined;
            manifest = fromSbcov(metadataJson, manifestJson);
            // Surface converter-side warnings (e.g. sbcov.id_derived) through the same channel as every
            // other warning, so `scf validate` on a legacy bundle prints them instead of dropping them.
            if (Array.isArray(manifest.warnings)) {
                warnings.push(...manifest.warnings);
            }
        }
        catch (e) {
            errors.push(issue('SCF_JSON_INVALID', `Legacy metadata.json could not be converted: ${e.message}`, {
                path: 'metadata.json',
            }));
            return { ok: false, errors, warnings, manifest: null };
        }
    }
    else {
        errors.push(issue('SCF_JSON_MISSING', 'No scf.json at the bundle root, and no legacy metadata.json to convert.'));
        return { ok: false, errors, warnings, manifest: null };
    }
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
        errors.push(issue('SCF_JSON_INVALID', 'scf.json must be a JSON object.', { path: 'scf.json' }));
        return { ok: false, errors, warnings, manifest: null };
    }
    if (typeof manifest.scf !== 'string' || !SUPPORTED_SCF_VERSIONS.has(manifest.scf)) {
        errors.push(issue('SCF_VERSION_UNSUPPORTED', `Unsupported scf version: ${JSON.stringify(manifest.scf)}.`));
    }
    const rawCaptures = manifest.captures;
    const isSidecarMode = rawCaptures === 'sidecars';
    let captures;
    if (isSidecarMode) {
        const imagePaths = [...files.keys()].filter((p) => p.startsWith('images/') && ALLOWED_IMAGE_EXT.has(extOf(p)));
        captures = sidecarCapturesFromImages(files, imagePaths);
    }
    else if (Array.isArray(rawCaptures)) {
        captures = rawCaptures;
    }
    else {
        errors.push(issue('CAPTURES_MISSING', 'captures is missing, and not "sidecars" either.'));
        captures = [];
    }
    const seenIds = new Map();
    const seenImages = new Map();
    const referencedPaths = new Set(['scf.json']);
    const sourceTextCaptureIds = [];
    for (const capture of captures) {
        const id = typeof capture?.id === 'string' ? capture.id : undefined;
        if (!id || id.length > 512) {
            errors.push(issue('CAPTURE_ID_INVALID', 'Capture id is missing, empty, or over 512 characters.', { id }));
        }
        else {
            seenIds.set(id, (seenIds.get(id) ?? 0) + 1);
        }
        const image = typeof capture?.image === 'string' && capture.image.length > 0 ? capture.image : undefined;
        if (!image) {
            errors.push(issue('CAPTURE_IMAGE_MISSING', "Capture's image field is missing or empty.", { id }));
        }
        else if (!isSafeRelPath(image)) {
            errors.push(issue('UNSAFE_PATH', `Capture image path is unsafe (absolute, backslash, "." or ".."): ${JSON.stringify(image)}`, { id, path: image }));
        }
        else {
            referencedPaths.add(image);
            if (!files.has(image)) {
                errors.push(issue('IMAGE_FILE_MISSING', `Image file not found in bundle: ${image}`, { id, path: image }));
            }
            else {
                const ext = extOf(image);
                const imageEntry = files.get(image);
                // `head` is the whole file for a plain entry, or just its first bytes for a `{head, size}`
                // partial image entry (ledger F31/F32) — either is enough for magic-byte + header-only
                // dimension checks. `size` is always the image's real total byte length.
                const head = bundleFileHead(imageEntry);
                const size = bundleFileSize(imageEntry) ?? 0;
                const family = head ? detectImageFamily(head) : null;
                if (!ALLOWED_IMAGE_EXT.has(ext) || !family || EXT_FAMILY[ext] !== family) {
                    errors.push(issue('IMAGE_FORMAT_INVALID', `Image is not PNG/JPEG/WebP: ${image}`, { id, path: image }));
                }
                if (size > MAX_IMAGE_BYTES) {
                    errors.push(issue('IMAGE_TOO_LARGE', `Image is over 20 MB: ${image}`, { id, path: image }));
                }
                if (head && family) {
                    // Header-only read (no decode): a tiny file can still declare an enormous canvas, which
                    // is a resource-exhaustion risk for whatever decodes it later (ledger F25). An unreadable
                    // header (truncated file, or a WebP shape this parser doesn't cover) fails closed.
                    const dims = readImageDimensions(head, family);
                    if (!dims) {
                        errors.push(issue('IMAGE_HEADER_UNREADABLE', `Could not read image dimensions from the header: ${image}`, {
                            id,
                            path: image,
                        }));
                    }
                    else if (dims.width > MAX_IMAGE_DIMENSION || dims.height > MAX_IMAGE_DIMENSION) {
                        errors.push(issue('IMAGE_DIMENSION_TOO_LARGE', `Image is ${dims.width}x${dims.height}px, over the ${MAX_IMAGE_DIMENSION}px limit: ${image}`, { id, path: image }));
                    }
                }
            }
            const list = seenImages.get(image) ?? [];
            list.push(id ?? '(no id)');
            seenImages.set(image, list);
        }
        const scale = capture?.capture?.scale;
        if (scale !== undefined && (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0)) {
            errors.push(issue('INVALID_SCALE', `capture.scale must be a positive finite number: ${JSON.stringify(scale)}`, { id }));
        }
        const structure = capture?.structure;
        if (structure && typeof structure === 'object' && typeof structure.file === 'string') {
            const structPath = structure.file;
            // Ledger F24: structure.file must live under structure/, end in .json, and actually be a
            // scf-tree/1 document — otherwise it's a member-allow-list bypass (point it at an arbitrary
            // .html/.js payload). A path failing this is NOT added to referencedPaths, so if the file
            // exists at all it is also flagged FORBIDDEN_MEMBER.
            const pathOk = isSafeRelPath(structPath) && structPath.startsWith('structure/') && extOf(structPath) === 'json';
            if (!pathOk) {
                errors.push(issue('STRUCTURE_PATH_INVALID', `structure.file must be a .json path under structure/: ${structPath}`, { id, path: structPath }));
            }
            else {
                referencedPaths.add(structPath);
                const entry = files.get(structPath);
                if (isCheckedBundleFile(entry)) {
                    // Ledger F60: this member was already content-checked (checkStructureMember) and its bytes
                    // discarded by a streaming caller before validateBundle ever saw them. The cross-checks
                    // above (referenced-by-a-capture) and existence (an entry is present at all) are all that's
                    // left to do here — there is nothing left to re-check content-wise, and no bytes to do it
                    // with even if there were.
                }
                else {
                    const structBytes = bundleFileFull(entry);
                    if (!structBytes) {
                        errors.push(issue('STRUCTURE_FILE_MISSING', `structure.file not found in bundle: ${structPath}`, { id, path: structPath }));
                    }
                    else {
                        const result = checkStructureMember(structPath, structBytes);
                        for (const e of result.errors)
                            errors.push({ ...e, id });
                        for (const w of result.warnings)
                            warnings.push({ ...w, id });
                    }
                }
            }
        }
        const sourceText = capture?.sourceText;
        if (sourceText && typeof sourceText === 'object' && typeof sourceText.file === 'string') {
            const sourcePath = sourceText.file;
            sourceTextCaptureIds.push(id ?? '(no id)');
            // Ledger F24: sourceText.file must live under source/, exist, be plausible UTF-8 text (never
            // a binary payload), and stay under the size cap. A path failing the prefix/extension check
            // is NOT added to referencedPaths (same reasoning as structure.file above).
            const pathOk = isSafeRelPath(sourcePath) && sourcePath.startsWith('source/');
            if (!pathOk) {
                errors.push(issue('SOURCE_TEXT_PATH_INVALID', `sourceText.file must be a path under source/: ${sourcePath}`, {
                    id,
                    path: sourcePath,
                }));
            }
            else {
                referencedPaths.add(sourcePath);
                const entry = files.get(sourcePath);
                if (isCheckedBundleFile(entry)) {
                    // Ledger F60: already content-checked (checkSourceTextMember) upstream; see the structure.file
                    // branch above for the full reasoning — same shape, same trust boundary.
                }
                else {
                    const sourceBytes = bundleFileFull(entry);
                    if (!sourceBytes) {
                        errors.push(issue('SOURCE_TEXT_FILE_MISSING', `sourceText.file not found in bundle: ${sourcePath}`, {
                            id,
                            path: sourcePath,
                        }));
                    }
                    else {
                        // optedIn: true — the aggregate SOURCE_TEXT_NOT_OPT_IN check below (sourceTextCaptureIds vs.
                        // manifest.optIn.sourceText) is this function's sole authority on opt-in; see
                        // checkSourceTextMember's own doc comment for why validateBundle always passes true here.
                        const result = checkSourceTextMember(sourcePath, sourceBytes, true);
                        for (const e of result.errors)
                            errors.push({ ...e, id });
                        for (const w of result.warnings)
                            warnings.push({ ...w, id });
                    }
                }
            }
        }
        const live = capture?.links?.live;
        if (live !== undefined && live !== null && !checkLinkIsSafeHttps(live)) {
            errors.push(issue('links.live.not_https', `links.live must be an absolute https: URL with no credentials: ${live}`, {
                id,
            }));
        }
        const page = capture?.links?.page;
        if (page !== undefined && page !== null && !checkLinkIsSafeHttps(page)) {
            errors.push(issue('links.page.not_https', `links.page must be an absolute https: URL with no credentials: ${page}`, {
                id,
            }));
        }
    }
    for (const [id, count] of seenIds) {
        if (count > 1) {
            errors.push(issue('DUPLICATE_ID', `Duplicate capture id (${count}×): ${id}`, { id }));
        }
    }
    for (const [image, ids] of seenImages) {
        if (ids.length > 1) {
            errors.push(issue('SHARED_IMAGE', `Image shared by ${ids.length} captures: ${image} (${ids.join(', ')})`, { path: image }));
        }
    }
    if (isSidecarMode) {
        for (const path of files.keys()) {
            if (path.startsWith('images/') && path.endsWith('.json'))
                referencedPaths.add(path);
        }
    }
    if (!isLegacy) {
        for (const path of files.keys()) {
            if (referencedPaths.has(path))
                continue;
            errors.push(issue('FORBIDDEN_MEMBER', `Bundle member is not referenced by any capture: ${path}`, { path }));
        }
    }
    // Ledger F24: sourceText is opt-in only (spec: "Adapters MUST NOT include it unless the user
    // explicitly turns it on"). The manifest must say so explicitly (optIn.sourceText: true) — the
    // validator has no other way to tell an intentional inclusion from an adapter bug or a bundle
    // someone else re-packaged with source text left in from a different run.
    if (sourceTextCaptureIds.length > 0 && manifest.optIn?.sourceText !== true) {
        errors.push(issue('SOURCE_TEXT_NOT_OPT_IN', `${sourceTextCaptureIds.length} capture(s) set sourceText but the manifest does not set optIn.sourceText: true (${sourceTextCaptureIds.join(', ')})`));
    }
    const counts = manifest.counts;
    if (counts && typeof counts.captured === 'number' && !isSidecarMode) {
        if (counts.captured !== captures.length) {
            errors.push(issue('COUNTS_MISMATCH', `counts.captured (${counts.captured}) does not equal captures.length (${captures.length}).`));
        }
    }
    return { ok: errors.length === 0, errors, warnings, manifest };
}
//# sourceMappingURL=validate.js.map