#!/usr/bin/env node
/**
 * Builds the npm package `codearchy` (the CLI) in apps/cli/npm/, ready for
 * `npm publish apps/cli/npm`. The workspace package @codearchy/cli stays private.
 *
 *   dist/main.js   one ESM bundle: the CLI and every @codearchy/* package and npm
 *                  dependency inlined, so installing it fetches nothing else
 *   parsers/       the pinned tree-sitter grammars (@codearchy/grammars, fetched and
 *                  integrity-checked if missing) + the matching web-tree-sitter.wasm
 *   package.json   name, version (from apps/cli), bin, engines, files
 *   README.md, LICENSE
 *
 * Usage: node scripts/package.mjs   (after `pnpm build`)
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.join(CLI, '..', '..');
const OUT = path.join(CLI, 'npm');
const require = createRequire(path.join(CLI, 'package.json'));
const source = JSON.parse(fs.readFileSync(path.join(CLI, 'package.json'), 'utf8'));

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'dist'), { recursive: true });

// ── the bundle ──────────────────────────────────────────────────────────────
const esbuild = await import('esbuild');
await esbuild.build({
    entryPoints: [path.join(CLI, 'src', 'main.ts')],
    outfile: path.join(OUT, 'dist', 'main.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // ws loads these native speed-ups when they're installed, and works without them.
    external: ['bufferutil', 'utf-8-validate'],
    // CommonJS dependencies inside an ES module bundle still call require() for Node's built-ins.
    banner: { js: "import { createRequire as __codearchyRequire } from 'node:module'; const require = __codearchyRequire(import.meta.url);" },
    legalComments: 'none',
    logLevel: 'warning',
});

// ── the grammars ───────────────────────────────────────────────────────────
const grammarsPkg = path.dirname(require.resolve('@codearchy/grammars/package.json'));
const manifest = JSON.parse(fs.readFileSync(path.join(grammarsPkg, 'grammars.json'), 'utf8'));
const wanted = manifest.grammars.flatMap((g) => g.files);
const wasmDir = path.join(grammarsPkg, 'wasm');
if (!wanted.every((f) => fs.existsSync(path.join(wasmDir, f)))) execFileSync(process.execPath, [path.join(grammarsPkg, 'scripts', 'fetch.cjs')], { stdio: 'inherit' });
const treesitterPkg = path.dirname(require.resolve('@codearchy/treesitter/package.json'));
const runtimeWasm = createRequire(path.join(treesitterPkg, 'package.json')).resolve('web-tree-sitter/web-tree-sitter.wasm');
fs.mkdirSync(path.join(OUT, 'parsers'));
for (const f of wanted) fs.copyFileSync(path.join(wasmDir, f), path.join(OUT, 'parsers', f));
fs.copyFileSync(runtimeWasm, path.join(OUT, 'parsers', 'web-tree-sitter.wasm'));

// ── package.json, README, LICENSE ──────────────────────────────────────────
const pkg = {
    name: 'codearchy',
    version: source.version,
    description: 'Your codebase’s architecture, for you and your AI agent: the Companion for the CodeArchy web app (codearchy serve), an MCP server for Claude Code, Codex, Gemini CLI and Copilot (codearchy mcp), and AI authorship reports.',
    keywords: ['architecture', 'codebase', 'visualization', 'mcp', 'model-context-protocol', 'tree-sitter', 'ai', 'authorship', 'code-map'],
    homepage: 'https://codearchy.com',
    repository: { type: 'git', url: 'git+https://github.com/CodeArchy/codearchy.git', directory: 'apps/cli' },
    bugs: { url: 'https://github.com/CodeArchy/codearchy/issues' },
    license: 'MIT',
    type: 'module',
    bin: { codearchy: 'dist/main.js' },
    files: ['dist', 'parsers', 'README.md', 'LICENSE'],
    engines: { node: '>=22' },
};
fs.writeFileSync(path.join(OUT, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
fs.copyFileSync(path.join(CLI, 'README.md'), path.join(OUT, 'README.md'));
fs.copyFileSync(path.join(REPO, 'LICENSE'), path.join(OUT, 'LICENSE'));

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log(`[package] ${pkg.name}@${pkg.version} in ${path.relative(REPO, OUT)}: dist/main.js ${(fs.statSync(path.join(OUT, 'dist', 'main.js')).size / 1e6).toFixed(1)} MB, parsers/ ${wanted.length + 1} files, ${(size(OUT) / 1e6).toFixed(1)} MB in all`);
