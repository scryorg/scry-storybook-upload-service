/**
 * Parses and validates the `?source=<sourceKey>` query parameter on the bundle presigned-url route
 * (contract §9, §2: `sourceKeyOf(manifest) = "<kind>:<platform|web>"`). The adapter/CLI computes this
 * before the bundle exists (from its own `source.kind`/`source.platform`, defaulting platform to
 * "web"), so it is always `<kind>:<platform>` with both sides non-empty.
 *
 * Validated enum + `x-` names, with length caps (contract §9): `kind` is one of the registered
 * values in spec/scf-1.0.md's `source.kind` table, or an `x-<name>` vendor extension; `platform` is
 * one of the spec's closed `source.platform` list (an unlisted platform is meant to be sent as
 * `other`, so there is no `x-` escape hatch for it).
 */

/** spec/scf-1.0.md `source.kind` registered values. */
const REGISTERED_SOURCE_KINDS = new Set([
  'storybook',
  'storybook-rn',
  'compose-preview',
  'swiftui-preview',
  'uikit',
  'widgetbook',
  'flutter-golden',
  'playwright',
  'cypress',
  'maestro',
  'xcuitest',
  'crawler',
  'figma',
  'argos',
  'percy',
  'docs',
  'upload',
]);

/** spec/scf-1.0.md `source.platform` values. */
const REGISTERED_SOURCE_PLATFORMS = new Set(['web', 'ios', 'android', 'macos', 'windows', 'email', 'other']);

const MAX_SOURCE_KEY_LENGTH = 100;
const KIND_RE = /^[a-z][a-z0-9-]{0,63}$/;
const VENDOR_KIND_RE = /^x-[a-z0-9-]{1,61}$/;
const PLATFORM_RE = /^[a-z][a-z0-9-]{0,31}$/;

export interface ParsedSourceKey {
  kind: string;
  platform: string;
}

/** Returns the parsed `{kind, platform}`, or `null` if `raw` fails validation. */
export function parseSourceKey(raw: string | undefined): ParsedSourceKey | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_SOURCE_KEY_LENGTH) return null;

  const idx = raw.indexOf(':');
  if (idx <= 0 || idx === raw.length - 1) return null;
  if (raw.indexOf(':', idx + 1) !== -1) return null; // exactly one ':'

  const kind = raw.slice(0, idx);
  const platform = raw.slice(idx + 1);

  const kindOk = (KIND_RE.test(kind) && REGISTERED_SOURCE_KINDS.has(kind)) || VENDOR_KIND_RE.test(kind);
  if (!kindOk) return null;

  if (!PLATFORM_RE.test(platform) || !REGISTERED_SOURCE_PLATFORMS.has(platform)) return null;

  return { kind, platform };
}
