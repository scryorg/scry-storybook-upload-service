#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { validateBundle } from './validate.js';
function printHuman(target, result) {
    if (result.ok) {
        console.log(`OK  ${target}`);
    }
    else {
        console.log(`FAIL  ${target}`);
    }
    const printIssue = (prefix) => (i) => {
        const loc = i.id ? ` [${i.id}]` : i.path ? ` [${i.path}]` : '';
        console.log(`  ${prefix} ${i.code}${loc}: ${i.message}`);
    };
    result.errors.forEach(printIssue('error'));
    result.warnings.forEach(printIssue('warn '));
    console.log(`${result.errors.length} error(s), ${result.warnings.length} warning(s).`);
}
async function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    if (command !== 'validate') {
        console.error('Usage: scf validate <dir|zip> [--json]');
        return 1;
    }
    const asJson = args.includes('--json');
    const target = args.slice(1).find((a) => !a.startsWith('--'));
    if (!target) {
        console.error('Usage: scf validate <dir|zip> [--json]');
        return 1;
    }
    const input = target.endsWith('.zip') ? (await import('./zip.js')).readZip(await readFile(target)) : target;
    const result = await validateBundle(input);
    if (asJson) {
        console.log(JSON.stringify(result, null, 2));
    }
    else {
        printHuman(target, result);
    }
    return result.ok ? 0 : 1;
}
main()
    .then((code) => {
    process.exitCode = code;
})
    .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
});
//# sourceMappingURL=cli.js.map