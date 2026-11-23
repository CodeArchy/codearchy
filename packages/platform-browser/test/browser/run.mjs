#!/usr/bin/env node
/**
 * Browser conformance: bundles the suite and runs it in Chromium, Firefox and
 * WebKit via Playwright, against a static server that sends NO COOP/COEP
 * headers (the PWA runs without cross-origin isolation; Spike D).
 *
 *   pnpm --filter @codearchy/platform-browser run test:browser [-- chromium,firefox,webkit]
 */
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, '..', '..');
const repo = path.resolve(pkg, '..', '..');
const require = createRequire(path.join(pkg, 'package.json'));
const out = path.join(pkg, 'dist-test');

// 1. Bundle the conformance worker and the parse worker (ESM module workers).
await esbuild.build({
    entryPoints: { 'conformance-worker': path.join(here, 'conformance-worker.ts'), 'parse-worker': path.join(here, 'parse-worker.ts') },
    outdir: out,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    // web-tree-sitter's ESM build has Node-only branches (guarded at runtime).
    external: ['module', 'fs/promises', 'node:*'],
    logLevel: 'warning',
});

// 2. Static assets: grammars + runtime wasm, sqlite wasm, fixture.
const grammarsDir = path.join(path.dirname(require.resolve('@codearchy/grammars/package.json')), 'wasm');
const treesitterPkg = path.dirname(require.resolve('@codearchy/treesitter/package.json'));
const runtimeWasm = createRequire(path.join(treesitterPkg, 'package.json')).resolve('web-tree-sitter/web-tree-sitter.wasm');
const sqliteDist = path.dirname(require.resolve('@sqlite.org/sqlite-wasm/sqlite3.wasm'));
const fixtureRoot = path.join(repo, 'fixtures', 'polyglot');
const listFiles = (dir, rel = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? listFiles(path.join(dir, e.name), r) : [r];
});
const fixtureFiles = listFiles(fixtureRoot);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };

const server = http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const send = (file) => {
        if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
        res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
        fs.createReadStream(file).pipe(res);
    };
    const inside = (base, rel) => { const p = path.resolve(base, rel); return p.startsWith(base + path.sep) ? p : undefined; };
    if (url === '/') return send(path.join(here, 'index.html'));
    if (url.startsWith('/dist-test/')) return send(inside(out, url.slice(11)));
    if (url === '/parsers/web-tree-sitter.wasm') return send(runtimeWasm);
    if (url.startsWith('/parsers/')) return send(inside(grammarsDir, url.slice(9)));
    if (url === '/sqlite/sqlite3.wasm') return send(path.join(sqliteDist, 'sqlite3.wasm'));
    if (url === '/fixture/index.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(fixtureFiles)); }
    if (url.startsWith('/fixture/files/')) return send(inside(fixtureRoot, url.slice(15)));
    res.writeHead(404).end();
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/`;

// 3. Run in each engine.
const wanted = (process.argv[2] ?? 'chromium,firefox,webkit').split(',');
const engines = { chromium, firefox, webkit };
let failed = 0;
for (const name of wanted) {
    // WebKit's default (ephemeral) context behaves like Private Browsing: no OPFS sync access.
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), `codearchy-${name}-`));
    const browser = name === 'webkit' ? undefined : await engines[name].launch();
    const context = browser ? await browser.newContext() : await engines[name].launchPersistentContext(profile);
    const page = await context.newPage();
    page.setDefaultTimeout(Number(process.env.CONFORMANCE_TIMEOUT_MS ?? 300_000));
    // Surface worker/page errors: a module worker that fails to load stays silent otherwise.
    page.on('console', (m) => { if (m.type() === 'error' || process.env.CONFORMANCE_VERBOSE) console.log(`  [${name} console.${m.type()}] ${m.text()}`); });
    page.on('pageerror', (e) => console.log(`  [${name} pageerror] ${e.message}`));
    page.on('worker', (w) => w.on('console', (m) => console.log(`  [${name} worker] ${m.text()}`)));
    await page.goto(base);
    await page.waitForFunction(() => window.ready === true);
    const outcome = await page.evaluate((p) => window.runConformance(p), name);
    await context.close();
    await browser?.close(); // a still-running browser would keep this process alive
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    if (outcome.type === 'fatal') {
        console.log(`✗ ${name}: harness failed\n${outcome.message}`);
        failed++;
        continue;
    }
    for (const r of outcome.results) {
        const mark = r.skipped ? '-' : r.ok ? '✓' : '✗';
        console.log(`${mark} ${name.padEnd(8)} ${r.name} (${r.ms} ms)${r.ok ? '' : `\n    ${r.error}`}`);
        if (!r.ok) failed++;
    }
}
server.close();
if (failed) {
    console.log(`\n${failed} failure(s)`);
    process.exit(1);
}
console.log('\nall engines pass the conformance suite');
process.exit(0);
