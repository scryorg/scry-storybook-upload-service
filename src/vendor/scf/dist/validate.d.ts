import type { BundleFiles, ValidationResult } from './types.js';
/** Reads a directory recursively into a BundleFiles map. Node only — never imported by a Worker
 *  build, since callers only reach this path when `input` is a string (a filesystem path). */
/**
 * Ledger F27: every bundle path (members and paths a capture references) must be a plain relative
 * POSIX path inside the bundle — no absolute paths, drive letters, backslashes, empty, `.` or `..`
 * segments. Nothing writes raw paths to storage today (keys are hash-derived), but the validator is
 * the shared G6/G7 gate, so it refuses them outright instead of relying on every consumer.
 */
export declare function isSafeRelPath(path: string): boolean;
/**
 * Validates an SCF bundle (or a legacy sbcov bundle, converted first) against spec/scf-1.0.md.
 * `input` is either an in-memory bundle (a Map of bundle-relative POSIX path -> bytes — the shape
 * a Worker or the upload service already has after reading a ZIP) or a directory path (Node only).
 */
export declare function validateBundle(input: BundleFiles | string): Promise<ValidationResult>;
//# sourceMappingURL=validate.d.ts.map