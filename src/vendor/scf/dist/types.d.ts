/** Types for the Scry Capture Format (SCF) 1.0. See ../../../spec/scf-1.0.md. */
export type Severity = 'error' | 'warning';
export interface ValidationIssue {
    code: string;
    /** The capture id this problem belongs to, when known. */
    id?: string;
    /** The bundle-relative path this problem belongs to, when known. */
    path?: string;
    message: string;
}
export interface ValidationResult {
    ok: boolean;
    errors: ValidationIssue[];
    warnings: ValidationIssue[];
    manifest: ScfManifest | null;
}
export interface DeviceRef {
    name?: string;
    os?: string;
    [key: string]: unknown;
}
export type CaptureMethod = 'browser' | 'simulator' | 'emulator' | 'device' | 'jvm-render' | 'headless-render' | 'design-export' | 'manual';
export type CaptureCrop = 'root' | 'viewport' | 'fullpage' | 'element' | 'none';
export interface CaptureBlock {
    method?: CaptureMethod;
    device?: DeviceRef;
    viewport?: {
        width: number;
        height: number;
    };
    scale?: number;
    size?: {
        width: number;
        height: number;
    };
    crop?: CaptureCrop;
    [key: string]: unknown;
}
export interface ScfSource {
    kind: string;
    platform?: string;
    framework?: string;
    tool?: {
        name?: string;
        version?: string;
    };
    [key: string]: unknown;
}
export interface ScfRepository {
    url?: string;
    commit?: string;
    branch?: string;
}
export type SkipReason = 'error' | 'timeout' | 'filtered' | 'unsupported' | 'empty';
export interface ScfCounts {
    declared?: number;
    captured?: number;
    skipped?: Array<{
        id: string;
        reason: SkipReason;
        detail?: string;
    }>;
}
export type CaptureKind = 'component' | 'screen' | 'page' | 'flow-step' | 'region' | 'doc-image';
export interface CaptureCode {
    file?: string;
    line?: number;
    component?: string;
    componentFile?: string;
}
export interface CaptureVariant {
    theme?: string;
    locale?: string;
    fontScale?: number;
    viewport?: {
        width: number;
        height: number;
    };
    args?: Record<string, unknown>;
    [key: string]: unknown;
}
export interface CaptureLinks {
    live?: string | null;
    page?: string | null;
    figma?: string | null;
}
export interface CaptureFlow {
    id?: string;
    name?: string;
    step?: number;
    order?: number;
}
export type StructureOrigin = 'dom' | 'rn-fiber' | 'compose-semantics' | 'uiautomator' | 'xcui-accessibility' | 'flutter-widgets' | string;
export interface CaptureStructure {
    file: string;
    origin?: StructureOrigin;
    format: 'scf-tree/1';
}
export interface CaptureSourceText {
    file: string;
    path?: string;
}
export interface ScfCapture {
    id: string;
    image: string;
    kind?: CaptureKind;
    title?: string[] | string;
    name?: string;
    code?: CaptureCode;
    variant?: CaptureVariant;
    capture?: CaptureBlock;
    links?: CaptureLinks;
    flow?: CaptureFlow | null;
    structure?: CaptureStructure | null;
    sourceText?: CaptureSourceText | null;
    tags?: string[];
    [key: string]: unknown;
}
export interface ScfManifest {
    $schema?: string;
    scf: string;
    source: ScfSource;
    repository?: ScfRepository;
    createdAt?: string;
    defaults?: {
        capture?: CaptureBlock;
        [key: string]: unknown;
    };
    counts?: ScfCounts;
    /** MUST be `{ sourceText: true }` when any capture sets `sourceText` — the manifest's explicit
     *  opt-in acknowledgement (spec: sourceText is "opt-in only"). See guarantee-6-ish check
     *  SOURCE_TEXT_NOT_OPT_IN in the validator. */
    optIn?: {
        sourceText?: boolean;
    };
    captures: ScfCapture[] | 'sidecars';
    /** Producer-side warnings a converter (e.g. `fromSbcov`) attaches to its own output, on the same
     *  `{code, message}` shape as `ValidationResult.warnings`. `validateBundle` merges these into its own
     *  `warnings` when converting a legacy bundle, so they still surface via the CLI. */
    warnings?: ValidationIssue[];
    [key: string]: unknown;
}
/**
 * Full bytes, or — for an image entry only — a memory-bounded stand-in: the first bytes of the
 * file (enough for magic-byte family detection and a header-only dimension read, see
 * `image-dimensions.ts`) plus its real total size. A caller that streams a large bundle instead of
 * buffering it whole (ledger F31/F32: a Worker-safe bundle-upload route must never hold a full
 * decompressed image, let alone a whole decompressed bundle, in memory) can supply this instead of
 * the full decoded image. Every other bundle member (`scf.json`, `structure.file`/`sourceText.file`,
 * sidecar JSON) MUST still be supplied in full — `validateBundle` only treats the `{head, size}`
 * shape as an image, via the `image` field of a capture (security review F50).
 */
export type BundleFileHeadAndSize = {
    head: Uint8Array;
    size: number;
};
/**
 * A stand-in for a `structure/*.json` or `source/*` member whose full inflated bytes were already
 * run through `checkStructureMember`/`checkSourceTextMember` (this package) by a streaming caller,
 * which recorded whatever issues that produced and then discarded the bytes to stay within a
 * bounded memory budget (security review F60: a Worker-safe bundle-upload route must not retain
 * every non-image member in full up to its own per-entry cap — structure trees especially can run
 * 100s of MB across a large Storybook). `size` is the member's real total byte length. Accepted by
 * `validateBundle` ONLY for those two path prefixes; any other member given this shape is refused
 * with `MEMBER_BYTES_REQUIRED`, same as an ordinary `{head, size}` entry would be.
 */
export type BundleFileChecked = {
    checked: true;
    size: number;
};
export type BundleFileBytes = Uint8Array | BundleFileHeadAndSize | BundleFileChecked;
/** A bundle as an in-memory map of bundle-relative POSIX path -> file bytes (see `BundleFileBytes`). */
export type BundleFiles = Map<string, BundleFileBytes>;
/** True for a `{checked: true, size}` entry (ledger F60) — never for a plain `Uint8Array` or a
 *  `{head, size}` image entry. */
export declare function isCheckedBundleFile(entry: BundleFileBytes | undefined): entry is BundleFileChecked;
/** Normalizes a `BundleFiles` entry to bytes usable for magic-byte/header inspection: the full
 *  bytes for a plain entry, or just the head for a `{head, size}` image entry. `undefined` for a
 *  `{checked, size}` entry (its bytes were never retained) — never the image's real full content
 *  when given a partial entry; use `bundleFileSize` for the true byte length. */
export declare function bundleFileHead(entry: BundleFileBytes | undefined): Uint8Array | undefined;
/** The entry's full bytes, or `undefined` for a `{head, size}` or `{checked, size}` entry. Every
 *  non-image member (JSON, structure trees, source text) is read through this, so a partial entry
 *  can never be validated from its head alone (security review F50). */
export declare function bundleFileFull(entry: BundleFileBytes | undefined): Uint8Array | undefined;
/** The entry's real total byte size: `byteLength` for a full entry, or the caller-reported `size`
 *  for a `{head, size}` or `{checked, size}` entry (its true size, never a head/partial length). */
export declare function bundleFileSize(entry: BundleFileBytes | undefined): number | undefined;
/** scf-tree/1, see ../../../spec/scf-1.0.md. */
export interface ScfTreeNode {
    type: string;
    role?: string;
    testId?: string;
    text?: string;
    bounds?: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    style?: Record<string, unknown>;
    sourceRef?: {
        file?: string;
        line?: number;
    };
    children?: ScfTreeNode[];
}
export interface ScfTree {
    format: 'scf-tree/1';
    units?: 'pt';
    root: ScfTreeNode;
}
//# sourceMappingURL=types.d.ts.map