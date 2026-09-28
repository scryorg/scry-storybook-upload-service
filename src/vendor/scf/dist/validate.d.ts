import type { BundleFiles, ValidationIssue, ValidationResult } from './types.js';
/** Reads a directory recursively into a BundleFiles map. Node only — never imported by a Worker
 *  build, since callers only reach this path when `input` is a string (a filesystem path). */
/**
 * Ledger F27: every bundle path (members and paths a capture references) must be a plain relative
 * POSIX path inside the bundle — no absolute paths, drive letters, backslashes, empty, `.` or `..`
 * segments. Nothing writes raw paths to storage today (keys are hash-derived), but the validator is
 * the shared G6/G7 gate, so it refuses them outright instead of relying on every consumer.
 */
export declare function isSafeRelPath(path: string): boolean;
interface MemberCheckResult {
    errors: ValidationIssue[];
    warnings: ValidationIssue[];
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
export declare function checkStructureMember(path: string, bytes: Uint8Array): MemberCheckResult;
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
export declare function checkSourceTextMember(path: string, bytes: Uint8Array, optedIn: boolean): MemberCheckResult;
/**
 * Validates an SCF bundle (or a legacy sbcov bundle, converted first) against spec/scf-1.0.md.
 * `input` is either an in-memory bundle (a Map of bundle-relative POSIX path -> bytes — the shape
 * a Worker or the upload service already has after reading a ZIP) or a directory path (Node only).
 */
export declare function validateBundle(input: BundleFiles | string): Promise<ValidationResult>;
export {};
//# sourceMappingURL=validate.d.ts.map