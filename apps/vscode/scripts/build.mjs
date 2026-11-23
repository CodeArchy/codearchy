#!/usr/bin/env node
/**
 * Builds the extension host bundle and its runtime assets.
 *
 *   dist/extension.js   esbuild bundle of src/extension.ts + the @codearchy/* packages
 *                       (CommonJS, `vscode` external). Bundling is required: the VSIX
 *                       is packaged with --no-dependencies, so nothing may be
 *                       resolved from node_modules at runtime.
 *   parsers/            the pinned tree-sitter grammars (@codearchy/grammars, fetched
 *                       and integrity-checked if missing) + the web-tree-sitter.wasm
 *                       matching the bundled web-tree-sitter JavaScript.
 *
 * Usage: node scripts/build.mjs [--watch] [--parsers-only]
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const args = new Set(process.argv.slice(2));

function prepareParsers() {
    const grammarsPkg = path.dirname(require.resolve('@codearchy/grammars/package.json'));
    const manifest = JSON.parse(fs.readFileSync(path.join(grammarsPkg, 'grammars.json'), 'utf8'));
    const wanted = manifest.grammars.flatMap((g) => g.files);
    const wasmDir = path.join(grammarsPkg, 'wasm');
    if (!wanted.every((f) => fs.existsSync(path.join(wasmDir, f)))) {
        execFileSync(process.execPath, [path.join(grammarsPkg, 'scripts', 'fetch.cjs')], { stdio: 'inherit' });
    }
    // The runtime wasm must match the web-tree-sitter JS that @codearchy/treesitter bundles.
    const treesitterPkg = path.dirname(require.resolve('@codearchy/treesitter/package.json'));
    const runtimeWasm = createRequire(path.join(treesitterPkg, 'package.json')).resolve('web-tree-sitter/web-tree-sitter.wasm');

    const out = path.join(ROOT, 'parsers');
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    for (const f of wanted) fs.copyFileSync(path.join(wasmDir, f), path.join(out, f));
    fs.copyFileSync(runtimeWasm, path.join(out, 'web-tree-sitter.wasm'));
    console.log(`[build] parsers/: ${wanted.length} grammars + web-tree-sitter.wasm`);
}

async function bundle() {
    const esbuild = await import('esbuild');
    // web-tree-sitter's ESM build sets itself up for Node via createRequire(import.meta.url),
    // which is empty in a CommonJS bundle. Bundle its CommonJS build instead.
    const treesitterPkg = path.dirname(require.resolve('@codearchy/treesitter/package.json'));
    const webTreeSitterCjs = createRequire(path.join(treesitterPkg, 'package.json')).resolve('web-tree-sitter');
    const options = {
        entryPoints: [path.join(ROOT, 'src', 'extension.ts')],
        outfile: path.join(ROOT, 'dist', 'extension.js'),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node18', // VS Code 1.85 (engines) runs Node 18
        external: ['vscode'],
        alias: { 'web-tree-sitter': webTreeSitterCjs },
        // Give any remaining `import.meta.url` the bundle's real file URL instead of undefined.
        define: { 'import.meta.url': '__codearchyImportMetaUrl' },
        banner: { js: "const __codearchyImportMetaUrl = require('url').pathToFileURL(__filename).href;" },
        sourcemap: true,
        logLevel: 'info',
    };
    if (args.has('--watch')) {
        const ctx = await esbuild.context(options);
        await ctx.watch();
    } else {
        await esbuild.build(options);
    }
}

prepareParsers();
if (!args.has('--parsers-only')) await bundle();
