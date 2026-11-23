#!/usr/bin/env node
/**
 * Builds the playground into dist/:
 *
 *   main.js, engine.worker.js, parse.worker.js   ESM bundles (esbuild)
 *   index.html, styles.css
 *   parsers/      pinned grammars (@codearchy/grammars) + web-tree-sitter.wasm
 *   sqlite3.wasm  SQLite WASM (OPFS storage)
 *   fixture.json  fixtures/polyglot, for "Load sample"
 *
 * Usage: node scripts/build.mjs [--watch] [--serve [port]]
 *   pnpm --filter @codearchy/playground dev     → http://127.0.0.1:5178/
 */
import { execFileSync } from 'node:child_process';
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist');
const require = createRequire(path.join(ROOT, 'package.json'));
const args = process.argv.slice(2);

function copyAssets() {
    fs.mkdirSync(path.join(OUT, 'parsers'), { recursive: true });
    for (const f of ['index.html', 'styles.css']) fs.copyFileSync(path.join(ROOT, 'src', f), path.join(OUT, f));

    const grammarsPkg = path.dirname(require.resolve('@codearchy/grammars/package.json'));
    const manifest = JSON.parse(fs.readFileSync(path.join(grammarsPkg, 'grammars.json'), 'utf8'));
    const wanted = manifest.grammars.flatMap((g) => g.files);
    const wasmDir = path.join(grammarsPkg, 'wasm');
    if (!wanted.every((f) => fs.existsSync(path.join(wasmDir, f)))) {
        execFileSync(process.execPath, [path.join(grammarsPkg, 'scripts', 'fetch.cjs')], { stdio: 'inherit' });
    }
    for (const f of wanted) fs.copyFileSync(path.join(wasmDir, f), path.join(OUT, 'parsers', f));
    // The runtime wasm must match the web-tree-sitter JS that @codearchy/treesitter bundles.
    const treesitterPkg = path.dirname(require.resolve('@codearchy/treesitter/package.json'));
    fs.copyFileSync(createRequire(path.join(treesitterPkg, 'package.json')).resolve('web-tree-sitter/web-tree-sitter.wasm'), path.join(OUT, 'parsers', 'web-tree-sitter.wasm'));
    fs.copyFileSync(require.resolve('@sqlite.org/sqlite-wasm/sqlite3.wasm'), path.join(OUT, 'sqlite3.wasm'));

    const fixture = path.resolve(ROOT, '..', '..', 'fixtures', 'polyglot');
    const files = {};
    const walk = (dir, rel) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) walk(path.join(dir, e.name), r);
            else files[r] = fs.readFileSync(path.join(dir, e.name), 'utf8');
        }
    };
    walk(fixture, '');
    fs.writeFileSync(path.join(OUT, 'fixture.json'), JSON.stringify(files));
    return wanted.length;
}

const options = {
    entryPoints: {
        main: path.join(ROOT, 'src', 'main.ts'),
        'engine.worker': path.join(ROOT, 'src', 'engine.worker.ts'),
        'parse.worker': path.join(ROOT, 'src', 'parse.worker.ts'),
    },
    outdir: OUT,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    // web-tree-sitter's ESM build has Node-only branches (guarded at runtime).
    external: ['module', 'fs/promises', 'node:*'],
    logLevel: 'warning',
};

fs.rmSync(OUT, { recursive: true, force: true });
const grammars = copyAssets();
if (args.includes('--watch')) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
} else {
    await esbuild.build(options);
}
console.log(`[playground] dist/: 3 bundles, ${grammars} grammars, sqlite3.wasm, fixture.json`);

if (args.includes('--serve')) {
    const port = Number(args[args.indexOf('--serve') + 1]) || 5178;
    const { url } = await serve(OUT, port);
    console.log(`[playground] ${url}`);
}
