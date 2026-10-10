#!/usr/bin/env node
// Print the scry-log schema {hash, entries, tokens} of the vendored copy in <dir> (default src/lib/scry-log).
// Same computation as scry-management/scripts/scry-log-schema.mjs (the one logs-deploy-check.sh uses): transpile the
// copy's .ts files, build the shape from schema.ts + attrs-registry.ts, run schemaHash/schemaTokens. The one difference:
// the hash tool is the schema-hash.ts INSIDE the copy (sync.sh vendors it), because this repo has no lib/scry-log checkout.
//
//   scry-log-schema.mjs [dir] [--hash]
//
// Needs the `typescript` package: found from SCRY_LOG_TS_DIR (a directory holding node_modules/typescript), the repo's
// node_modules, or the cwd. Exit 2 usage, 3 not a scry-log copy / no schema-hash.ts (re-run sync.sh), 4 typescript missing.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--')) ?? 'src/lib/scry-log';
if (!fs.existsSync(dir)) {
  console.error(`scry-log-schema: ${dir} does not exist (run scry-management/lib/scry-log/sync.sh <repo>)`);
  process.exit(2);
}

function findTypescript() {
  const bases = [process.env.SCRY_LOG_TS_DIR, process.cwd(), path.resolve(dir)].filter(Boolean);
  for (const base of bases) {
    try {
      return createRequire(path.join(path.resolve(base), 'x.js'))('typescript');
    } catch {
      // try the next place
    }
  }
  console.error('scry-log-schema: typescript not found (npm install typescript, or set SCRY_LOG_TS_DIR)');
  process.exit(4);
}
const ts = findTypescript();

/** A tiny module system over a directory of .ts files: transpile to CommonJS, resolve ./name inside the directory. */
function loader(d) {
  const cache = new Map();
  const has = (name) => fs.existsSync(path.join(d, `${name}.ts`));
  const load = (name) => {
    if (cache.has(name)) return cache.get(name).exports;
    const out = ts.transpileModule(fs.readFileSync(path.join(d, `${name}.ts`), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    });
    const mod = { exports: {} };
    cache.set(name, mod);
    const req = (spec) => {
      if (spec.startsWith('./')) return load(spec.slice(2).replace(/\.ts$/, ''));
      throw new Error(`unexpected import ${spec} in ${name}.ts`);
    };
    // eslint-disable-next-line sonarjs/code-eval -- evaluates only this repo's own vendored scry-log, transpiled from TypeScript; no external input
    new Function('exports', 'require', 'module', out.outputText)(mod.exports, req, mod);
    return mod.exports;
  };
  return { has, load };
}

const target = loader(path.resolve(dir));
if (!target.has('schema') || !target.has('schema-hash')) {
  console.error(`scry-log-schema: ${dir} is not a current scry-log copy (needs schema.ts and schema-hash.ts): run sync.sh`);
  process.exit(3);
}
const schema = target.load('schema');
const attrs = target.has('attrs-registry') ? target.load('attrs-registry').ATTRS ?? {} : {};
const shape = {
  version: schema.SCHEMA_VERSION,
  allowedKeys: schema.ALLOWED_KEYS ?? [],
  enumValues: schema.ENUM_VALUES ?? {},
  services: schema.SERVICES ?? [],
  envs: schema.ENVS ?? [],
  levels: schema.LEVELS ?? [],
  attrs,
};
const tool = target.load('schema-hash');
const hash = tool.schemaHash(shape);
if (args.includes('--hash')) console.log(hash);
else {
  const tokens = tool.schemaTokens(shape);
  console.log(JSON.stringify({ hash, entries: tokens.length, tokens }));
}
