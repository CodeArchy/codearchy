#!/usr/bin/env node
/**
 * Scaffolds a new language pack end to end:
 *
 *   packages/languages/<id>/            the pack (@codearchy/lang-<id>), sdk-only
 *   packages/grammars/grammars.json     the pinned grammar, with its npm integrity hash
 *   packages/core                       dependency + registry entry
 *   packages/platform-node/test/languages/<id>.test.ts   extraction tests to fill in
 *   apps/vscode/package.json            the `codearchy.includedLanguages` setting
 *
 * Usage:
 *   pnpm new:language <id> --name <Display Name> --ext .a,.b \
 *       --grammar <npm package> --version <grammar version> [--wasm <file.wasm>]
 *
 * Example:
 *   pnpm new:language ruby --name Ruby --ext .rb,.rake --grammar tree-sitter-ruby --version 0.23.1
 *
 * The grammar must be an npm package that ships a prebuilt .wasm (most
 * tree-sitter-<lang> packages do). Nothing is installed: the tarball is only
 * downloaded to check that the .wasm is there, then fetched again (and
 * verified against the same hash) by `@codearchy/grammars`.
 * See docs/guides/adding-a-language.md for what to do next.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'https://registry.npmjs.org';
/** Licences that are fine to bundle into an MIT extension and web app. */
const PERMISSIVE = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'Unlicense']);

function fail(message) {
    console.error(`new:language: ${message}`);
    process.exit(1);
}

const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        name: { type: 'string' },
        ext: { type: 'string' },
        grammar: { type: 'string' },
        version: { type: 'string' },
        wasm: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
    },
});

const id = positionals[0];
if (!id || !values.name || !values.ext || !values.grammar || !values.version) {
    fail('usage: pnpm new:language <id> --name <Display Name> --ext .a,.b --grammar <npm package> --version <version> [--wasm <file>]');
}
if (!/^[a-z][a-z0-9]*$/.test(id)) fail(`id must be lowercase letters and digits ("csharp", not "c#"): ${id}`);
const extensions = values.ext.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
if (extensions.some((e) => !/^\.[a-z0-9]+$/.test(e))) fail(`extensions look like ".rb,.rake": ${values.ext}`);
const pkgDir = path.join(ROOT, 'packages', 'languages', id);
if (fs.existsSync(pkgDir)) fail(`packages/languages/${id} already exists`);
const bareGrammar = values.grammar.startsWith('@') ? values.grammar.split('/')[1] : values.grammar;
const wasm = values.wasm ?? `${bareGrammar}.wasm`;
const dryRun = values['dry-run'];

// ─── 1. the grammar: version metadata, licence, and the .wasm in the tarball ──

async function getJson(url) {
    const res = await fetch(url, { headers: { 'User-Agent': 'codearchy-build' } });
    if (!res.ok) fail(`HTTP ${res.status} for ${url}`);
    return res.json();
}

/** File names in a .tgz (ustar), enough to check the .wasm exists. */
function tarNames(gz) {
    const buf = zlib.gunzipSync(gz);
    const names = [];
    for (let off = 0; off + 512 <= buf.length; ) {
        const header = buf.subarray(off, off + 512);
        if (header.every((b) => b === 0)) break;
        const field = (s, n) => header.subarray(s, s + n).toString('utf8').replace(/\0.*$/s, '');
        const size = parseInt(field(124, 12).trim() || '0', 8);
        const prefix = field(345, 155);
        names.push(prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
        off += 512 + Math.ceil(size / 512) * 512;
    }
    return names;
}

const meta = await getJson(`${REGISTRY}/${values.grammar}/${values.version}`);
const integrity = meta.dist?.integrity;
if (!integrity) fail(`no integrity hash for ${values.grammar}@${values.version}`);
const license = typeof meta.license === 'string' ? meta.license : meta.license?.type;
if (!PERMISSIVE.has(license)) {
    fail(`${values.grammar}@${values.version} is licensed "${license}"; only permissive licences can be bundled (${[...PERMISSIVE].join(', ')})`);
}
const tgz = Buffer.from(await (await fetch(meta.dist.tarball)).arrayBuffer());
const names = tarNames(tgz);
if (!names.includes(`package/${wasm}`)) {
    const found = names.filter((n) => n.endsWith('.wasm')).map((n) => n.replace(/^package\//, ''));
    fail(`${wasm} is not in ${values.grammar}@${values.version}${found.length ? `; it has: ${found.join(', ')} (pass --wasm)` : ' (it ships no .wasm; build one with tree-sitter-cli or pick another version)'}`);
}
console.log(`✓ ${values.grammar}@${values.version} (${license}) ships ${wasm}`);

// ─── 2. the files ────────────────────────────────────────────────────────────

const writes = new Map();
const edit = (rel, fn) => {
    const file = path.join(ROOT, rel);
    const before = writes.get(file) ?? fs.readFileSync(file, 'utf8');
    const after = fn(before);
    if (after === before) fail(`could not update ${rel} (its new:language marker or shape changed)`);
    writes.set(file, after);
};
const create = (rel, text) => writes.set(path.join(ROOT, rel), text);
const json = (v) => `${JSON.stringify(v, null, 4)}\n`;
const pkgName = `@codearchy/lang-${id}`;
const camel = id;

create(`packages/languages/${id}/package.json`, json({
    name: pkgName,
    version: '0.1.0',
    description: `CodeArchy language pack for ${values.name}: tree-sitter query, export rules and import hooks.`,
    license: 'MIT',
    type: 'module',
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' }, './package.json': './package.json' },
    files: ['dist'],
    scripts: { build: 'tsc -p tsconfig.json', typecheck: 'tsc -p tsconfig.json --noEmit' },
    dependencies: { '@codearchy/sdk': 'workspace:*' },
    devDependencies: { typescript: '5.9.3' },
    repository: { type: 'git', url: 'https://github.com/CodeArchy/codearchy', directory: `packages/languages/${id}` },
}));
create(`packages/languages/${id}/tsconfig.json`, '{\n    "extends": "../../../tsconfig.base.json",\n    "compilerOptions": { "rootDir": "src", "outDir": "dist" },\n    "include": ["src"]\n}\n');
create(`packages/languages/${id}/src/index.ts`, `/**
 * ${pkgName} — the ${values.name} language pack (tree-sitter query + rules).
 * See docs/guides/adding-a-language.md.
 */
import { defineLanguage } from '@codearchy/sdk';

const pack = defineLanguage({
    id: '${id}',
    displayName: '${values.name}',
    extensions: [${extensions.map((e) => `'${e}'`).join(', ')}],
    grammar: '${wasm}',
    // TODO: a few lines of ${values.name} that the query below matches.
    sample: '',
    // TODO: capture definitions and imports; node types are in the grammar's
    // node-types.json (or try queries at https://tree-sitter.github.io/tree-sitter/7-playground.html).
    query: \`
\`,
    // TODO: the language's visibility rule.
    isExported: ({ topLevel }) => topLevel,
});

export default pack;
`);
create(`packages/platform-node/test/languages/${id}.test.ts`, `import { describe, test } from 'vitest';
import * as assert from 'node:assert';
import { analyzeSource, assertSymbols } from '../helpers.js';

describe('${values.name}', () => {
    test('definitions, exports and imports', async () => {
        const r = await analyzeSource('example${extensions[0]}', \`
\`);
        assert.strictEqual(r.parser, 'tree-sitter');
        // \`kind Container.name\`, with * when exported.
        assertSymbols(r, []);
        assert.deepStrictEqual(r.imports.map((i) => i.source), []);
    });
});
`);

edit('packages/grammars/grammars.json', (s) => {
    if (JSON.parse(s).grammars.some((g) => g.package === values.grammar)) fail(`${values.grammar} is already in grammars.json`);
    // Text insert (not JSON.stringify) keeps the file's one-line "files" arrays.
    const entry = [
        '        {',
        `            "package": ${JSON.stringify(values.grammar)},`,
        `            "version": ${JSON.stringify(values.version)},`,
        `            "integrity": ${JSON.stringify(integrity)},`,
        `            "files": [${JSON.stringify(wasm)}]`,
        '        }',
    ].join('\n');
    return s.replace(/\n    \]\n\}\s*$/, `,\n${entry}\n    ]\n}\n`);
});
edit('packages/core/package.json', (s) => {
    const p = JSON.parse(s);
    p.dependencies[pkgName] = 'workspace:*';
    p.dependencies = Object.fromEntries(Object.entries(p.dependencies).sort(([a], [b]) => a.localeCompare(b)));
    return json(p);
});
edit('packages/core/src/languages/index.ts', (s) =>
    s
        .replace('// new:language — imports above this line', `import ${camel} from '${pkgName}';\n// new:language — imports above this line`)
        .replace('    // new:language — packs above this line', `    ${camel},\n    // new:language — packs above this line`)
);
edit('apps/vscode/package.json', (s) => {
    const p = JSON.parse(s);
    const setting = p.contributes.configuration.properties['codearchy.includedLanguages'];
    setting.default.push(id);
    setting.items.enum.push(id);
    return json(p);
});

if (dryRun) {
    for (const file of writes.keys()) console.log(`would write ${path.relative(ROOT, file)}`);
    process.exit(0);
}
for (const [file, text] of writes) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    console.log(`  ${path.relative(ROOT, file)}`);
}

// ─── 3. link the workspace and fetch the grammar ─────────────────────────────

// Run pnpm the way this script was launched (`pnpm new:language` sets npm_execpath),
// which works with Corepack and on Windows, where a bare `pnpm` isn't executable.
const pnpm = process.env.npm_execpath;
if (pnpm && /pnpm/.test(path.basename(pnpm))) execFileSync(process.execPath, [pnpm, 'install'], { cwd: ROOT, stdio: 'inherit' });
else execFileSync('pnpm', ['install'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
execFileSync(process.execPath, [path.join(ROOT, 'packages/grammars/scripts/fetch.cjs')], { cwd: ROOT, stdio: 'inherit' });

console.log(`
${values.name} is wired in. Next:
  1. Write the query, sample and rules in packages/languages/${id}/src/index.ts
  2. Fill in packages/platform-node/test/languages/${id}.test.ts
  3. pnpm build && pnpm test:unit        (the conformance suite checks the sample on every grammar)
  4. Add a small fixture under fixtures/polyglot if imports between files should resolve,
     then refresh the golden graph: pnpm --filter @codearchy/platform-node run golden
See docs/guides/adding-a-language.md.`);
