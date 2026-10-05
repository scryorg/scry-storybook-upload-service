import { describe, expect, it } from 'vitest';
import { quoteFieldPath } from './firestore.worker.js';

/**
 * staff-builds-view (security review finding 9): pins how an update-mask path is written.
 * A dotted name is a NESTED path, each segment quoted on its own. Safe today because every
 * `patchDocument` caller uses static identifiers or `stepSummary.*`; these tests fail if the
 * quoting changes, so a future top-level field name containing a dot cannot be mis-handled silently.
 */
describe('quoteFieldPath', () => {
  it('a plain name is left alone', () => {
    expect(quoteFieldPath('processingStatus')).toBe('processingStatus');
    expect(quoteFieldPath('_private1')).toBe('_private1');
  });

  it('a dotted name is a nested path: a.b stays a.b, and stepSummary.lastStep stays unquoted', () => {
    expect(quoteFieldPath('a.b')).toBe('a.b');
    expect(quoteFieldPath('stepSummary.lastStep')).toBe('stepSummary.lastStep');
  });

  it('a segment that is not an identifier is wrapped in backticks, on its own', () => {
    expect(quoteFieldPath('weird-key')).toBe('`weird-key`');
    expect(quoteFieldPath('1abc')).toBe('`1abc`');
    expect(quoteFieldPath('stepSummary.weird-key')).toBe('stepSummary.`weird-key`');
    expect(quoteFieldPath('weird-key.lastStep')).toBe('`weird-key`.lastStep');
  });

  it('a backtick inside a segment is escaped', () => {
    expect(quoteFieldPath('we`ird')).toBe('`we\\`ird`');
  });

  it('a name that itself contains a dot is read as nested (not addressable as one field)', () => {
    expect(quoteFieldPath('latestBuildIds.storybook:web')).toBe('latestBuildIds.`storybook:web`');
  });
});
