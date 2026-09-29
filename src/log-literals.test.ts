import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isFixedText } from './lib/scry-log';

// log-standardization M4: a msg that breaks the fixed-text rule (digits, commas, words over 20 chars)
// is stored as "[invalid]" and the text is lost. Scan every literal msg / err_code passed to the
// logger in the source so a bad one fails here, not silently in production.
const ROOTS = [new URL('.', import.meta.url).pathname];
const SKIP_DIR = new Set(['node_modules', 'scry-log', 'vendor']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIR.has(name)) sourceFiles(full, out);
    } else if (/\.ts$/.test(name) && !/\.(test|spec)\.ts$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const Q = String.raw`(['"\x60])((?:\\.|(?!\1)[^\\])*)\1`;
// [call regex, index of the msg literal group, index of the err_code literal group or -1]
const CALLS: Array<[string, RegExp, number, number]> = [
  ['log.<level>', new RegExp(String.raw`\blog\.(?:info|warn|error|debug)\(\s*${Q}`, 'g'), 2, -1],
  ['logInfo', new RegExp(String.raw`\blogInfo\(\s*[^,()]+,\s*${Q}`, 'g'), 2, -1],
  ['logWarn', new RegExp(String.raw`\blogWarn\(\s*[^,()]+,\s*${Q}\s*,\s*${Q}`, 'g'), 2, 4],
  ['reportError', new RegExp(String.raw`\breportError\(\s*[^,()]+,\s*[^,()]+,\s*${Q}\s*,\s*${Q}`, 'g'), 2, 4],
];
const CALL_OPEN: Record<string, RegExp> = {
  'log.<level>': /\blog\.(?:info|warn|error|debug)\(/g,
  logInfo: /\blogInfo\(/g,
  logWarn: /\blogWarn\(/g,
  reportError: /\breportError\(/g,
};
const WRAPPER_FILE = /[\\/]lib[\\/]log\.ts$/; // the wrappers forward a msg parameter

describe('logger msg and err_code literals', () => {
  const files = ROOTS.flatMap((r) => sourceFiles(r));
  const bad: string[] = [];
  const unscanned: string[] = [];
  let checked = 0;
  for (const file of files) {
    if (WRAPPER_FILE.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const [name, re, msgGroup, codeGroup] of CALLS) {
      let matched = 0;
      for (const m of text.matchAll(re)) {
        matched++;
        checked++;
        if (!isFixedText('msg', m[msgGroup])) bad.push(`${file}: ${name} msg ${JSON.stringify(m[msgGroup])}`);
        if (codeGroup > 0 && !isFixedText('err_code', m[codeGroup])) bad.push(`${file}: ${name} err_code ${JSON.stringify(m[codeGroup])}`);
      }
      const opened = [...text.matchAll(CALL_OPEN[name])].length;
      if (opened > matched) unscanned.push(`${file}: ${opened - matched} ${name} call(s) with a non-literal msg`);
    }
    for (const m of text.matchAll(/\berr_code:\s*(['"\x60])((?:\\.|(?!\1)[^\\])*)\1/g)) {
      checked++;
      // A template err_code (`firestore_${status}`) is checked with a 3-digit status substituted.
      const code = m[2].replace(/\$\{[^}]*\}/g, '400');
      if (!isFixedText('err_code', code)) bad.push(`${file}: err_code ${JSON.stringify(m[2])}`);
    }
  }

  it('finds the logger calls (the scan itself is not vacuous)', () => {
    expect(checked).toBeGreaterThan(10);
  });
  it('every literal msg and err_code is valid fixed text (no [invalid] at runtime)', () => {
    expect(bad).toEqual([]);
  });
  it('no logger call hides its msg in a variable or template (cannot be checked statically)', () => {
    expect(unscanned).toEqual([]);
  });
});
