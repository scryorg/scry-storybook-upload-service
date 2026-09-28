import { describe, expect, it } from 'vitest';
import { parseSourceKey } from './source-key.js';

describe('parseSourceKey', () => {
  it.each([
    ['storybook:web', { kind: 'storybook', platform: 'web' }],
    ['storybook-rn:ios', { kind: 'storybook-rn', platform: 'ios' }],
    ['compose-preview:android', { kind: 'compose-preview', platform: 'android' }],
    ['playwright:web', { kind: 'playwright', platform: 'web' }],
    ['x-acme-tool:ios', { kind: 'x-acme-tool', platform: 'ios' }],
    ['upload:other', { kind: 'upload', platform: 'other' }],
  ] as const)('accepts %s', (raw, expected) => {
    expect(parseSourceKey(raw)).toEqual(expected);
  });

  it.each([
    [undefined, 'missing'],
    ['', 'empty'],
    ['storybook', 'no colon'],
    ['storybook:', 'empty platform'],
    [':web', 'empty kind'],
    ['storybook:web:extra', 'more than one colon'],
    ['unknown-kind:web', 'unregistered kind, no x- prefix'],
    ['x-:web', 'x- prefix with nothing after it'],
    ['storybook:mars', 'unregistered platform'],
    ['STORYBOOK:web', 'uppercase kind'],
    ['storybook:WEB', 'uppercase platform'],
    ['a'.repeat(200), 'garbage well over the overall length cap, no colon either'],
  ])('rejects %s (%s)', (raw) => {
    expect(parseSourceKey(raw as string | undefined)).toBeNull();
  });
});
