#!/usr/bin/env node
/**
 * Playground smoke test in Chromium, Firefox and WebKit: load the sample,
 * check the numbers against the golden graph, drive the Map (drill, expand,
 * inspect, explain an edge, keyboard, ⌘K, Navigator), expand the hierarchy, search,
 * open a file, then
 * reload and check that the OPFS index makes the second run parse nothing.
 *
 *   pnpm --filter @codearchy/playground test:e2e [-- chromium,firefox,webkit]
 * (test:e2e builds first; run test/smoke.mjs directly to reuse dist/.)
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { GOLDEN_POLYGLOT } from '@codearchy/conformance';
import { zipSync } from 'fflate';
import { serve } from '../scripts/serve.mjs';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
// The fixture as a GitHub-style zip (everything under one top folder, which the engine strips).
const fixture = JSON.parse(fs.readFileSync(path.join(dist, 'fixture.json'), 'utf8'));
const zipBase64 = Buffer.from(zipSync(Object.fromEntries(Object.entries(fixture).map(([p, text]) => [`polyglot-main/${p}`, new TextEncoder().encode(text)])))).toString('base64');
const { url, close } = await serve(dist);
const engines = { chromium, firefox, webkit };
const wanted = (process.argv[2] ?? 'chromium,firefox,webkit').split(',');
let failed = 0;

const stat = (page, key) => page.locator(`[data-stat="${key}"]`).textContent();

for (const name of wanted) {
    // WebKit's default context behaves like Private Browsing (no OPFS sync access).
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), `codearchy-playground-${name}-`));
    const browser = name === 'webkit' ? undefined : await engines[name].launch();
    const context = browser ? await browser.newContext() : await engines[name].launchPersistentContext(profile);
    const page = await context.newPage();
    page.setDefaultTimeout(120_000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    const started = Date.now();
    try {
        await page.goto(url);
        await page.click('#load-sample');
        await page.waitForSelector('body[data-state="ready"]');
        assert.equal(await stat(page, 'files'), String(GOLDEN_POLYGLOT.files.length), 'files');
        assert.equal(await stat(page, 'edges'), String(GOLDEN_POLYGLOT.edges.length), 'edges');
        assert.equal(await stat(page, 'symbols'), String(GOLDEN_POLYGLOT.symbols), 'symbols');
        const storage = await stat(page, 'storage');

        // Map (the default tab): @codearchy/ui's CodeArchyMap over the engine worker.
        const mapNode = (key) => page.locator(`.react-flow__node[data-id="${key}"]`);
        const crumb = () => page.locator('.ca-breadcrumb').textContent();
        await mapNode('pkg:rust').waitFor();
        // One canvas: double-click expands in place (the breadcrumb doesn't change).
        await mapNode('pkg:.').dblclick();
        await mapNode('dir:web/src').waitFor();
        assert.doesNotMatch(await crumb(), /›/, 'still the system canvas');
        await mapNode('dir:web/src').locator('.ca-expand').click();
        await mapNode('mod:web/src/index.ts').click();
        await page.locator('.ca-inspector h3', { hasText: 'Depends on (4)' }).waitFor();
        // Selection traces flow: its dependencies animate in the dependency's direction; the rest fades.
        // (A new node's edges are drawn once the node has rendered, so wait for all four.)
        await page.waitForFunction(() => document.querySelectorAll('.react-flow__edge.animated.ca-edge-out').length === 4);
        assert.match(await page.locator('.ca-legend').textContent(), /uses 4/);
        await page.waitForFunction(() => document.querySelectorAll('.react-flow__edge.ca-faded').length > 0); // unrelated edges fade
        await page.locator('.react-flow__edge[data-id="mod:web/src/index.ts->mod:web/src/esm.ts"]').click({ force: true });
        await page.locator('.ca-inspector', { hasText: 'Dependency' }).locator('h2', { hasText: 'index.ts → esm.ts' }).waitFor();
        // Double-clicking an expanded node's header collapses it, in place.
        await mapNode('dir:web/src').locator('.ca-container-head').dblclick();
        await mapNode('mod:web/src/index.ts').waitFor({ state: 'detached' });
        // "Show only this" is the explicit way into a separate view; Backspace comes back.
        await mapNode('pkg:rust').click();
        await page.getByRole('button', { name: 'Show only this' }).click();
        await mapNode('dir:rust/src').waitFor();
        assert.match(await crumb(), /rusty-core$/);
        await page.locator('.ca-root').focus();
        await page.keyboard.press('Backspace');
        await mapNode('pkg:.').waitFor();
        // Search reveals in place: the path expands on this canvas.
        await page.keyboard.press('Control+k');
        await page.locator('.ca-search input').fill('OrderSer');
        await page.locator('.ca-search li', { hasText: 'OrderService' }).first().waitFor();
        await page.keyboard.press('Enter');
        await mapNode('mod:cs/Orders/OrderService.cs').waitFor();
        assert.doesNotMatch(await crumb(), /›/, 'revealed on the system canvas');
        await page.locator('.ca-navigator [data-key="pkg:rust"]').click();
        await page.locator('.ca-inspector[data-key="pkg:rust"]').waitFor();

        // Lenses and the Matrix: badges carry the value as text; matrix cells explain on click.
        await page.selectOption('.ca-lens select', 'health');
        await mapNode('pkg:rust').locator('.ca-lens-badge').waitFor();
        assert.match(await mapNode('pkg:rust').locator('.ca-lens-badge').textContent(), /no issues|in cycles|hub|orphan/);
        await page.selectOption('.ca-lens select', 'tests');
        assert.match(await mapNode('pkg:rust').locator('.ca-lens-badge').textContent(), /% tested|tests only/);
        await page.locator('.ca-inspector h3', { hasText: 'Health & tests' }).waitFor();
        // Reveal web/src's files (they depend on each other), then the Matrix of this view.
        await page.locator('.ca-root').focus();
        await page.keyboard.press('Control+k');
        await page.locator('.ca-search input').fill('esm');
        await page.locator('.ca-search li', { hasText: 'esm.ts' }).first().waitFor();
        await page.keyboard.press('Enter');
        await mapNode('mod:web/src/index.ts').waitFor();
        await page.click('.ca-segmented button:has-text("Matrix")');
        await page.locator('.ca-matrix-cell').first().click();
        await page.locator('.ca-inspector', { hasText: 'Dependency' }).waitFor();
        await page.click('.ca-segmented button:has-text("Map")');
        await page.selectOption('.ca-lens select', 'dependencies');
        await page.click('#tab-tree');

        // Hierarchy (the default tab): packages open under the system; a click collapses and re-expands.
        const rustPkg = page.locator('.tree [data-key="pkg:rust"]');
        const rustSrc = page.locator('.tree [data-key="dir:rust/src"]');
        assert.equal(await rustPkg.locator('.name').textContent(), 'rusty-core');
        await rustSrc.waitFor();
        await rustPkg.click();
        await rustSrc.waitFor({ state: 'detached' });
        await page.locator('.tree [data-key="pkg:rust"]').click();
        await rustSrc.waitFor();

        // View (projector): drill into the root package, see its port stubs, expand in place, explain an edge.
        await page.click('#tab-view');
        await page.click('button[data-action="drill"][data-key="pkg:."]');
        await page.locator('.view tr[data-key="dir:web/src"]').waitFor();
        await page.locator('.view td', { hasText: '@poly/shared' }).first().waitFor();
        await page.click('button[data-action="expand"][data-key="dir:web/src"]');
        await page.locator('.view tr[data-key="mod:web/src/index.ts"]').waitFor();
        await page.locator('.view h3 + div td', { hasText: 'index.ts' }).first().click();
        await page.locator('#detail h2', { hasText: '→' }).waitFor();

        await page.click('#tab-unresolved');
        await page.locator('#list td', { hasText: 'react' }).first().waitFor();

        await page.click('#tab-search');
        await page.fill('#filter', 'OrderSer');
        await page.locator('#list td', { hasText: 'cs/Orders/OrderService.cs' }).first().click();
        await page.locator('#detail h2', { hasText: 'cs/Orders/OrderService.cs' }).waitFor();

        await page.click('#tab-files');
        await page.fill('#filter', 'rb/bin');
        await page.locator('#list td', { hasText: 'rb/bin/run.rb' }).click();
        await page.locator('#detail a', { hasText: 'rb/lib/billing.rb' }).waitFor();

        // A .zip dropped on the page: same files, edges and symbols as the sample.
        await page.evaluate((b64) => {
            const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
            const dt = new DataTransfer();
            dt.items.add(new File([bytes], 'polyglot-main.zip', { type: 'application/zip' }));
            document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
        }, zipBase64);
        await page.waitForFunction(() => /indexed polyglot-main/.test(document.getElementById('status').textContent));
        assert.equal(await stat(page, 'files'), String(GOLDEN_POLYGLOT.files.length), 'zip: files');
        assert.equal(await stat(page, 'edges'), String(GOLDEN_POLYGLOT.edges.length), 'zip: edges');

        // A watched folder (OPFS stands in for a picked one): a new file shows up without reloading.
        const writable = await page.evaluate(async () => !!(await navigator.storage.getDirectory()).getFileHandle && 'createWritable' in FileSystemFileHandle.prototype);
        if (writable) {
            await page.evaluate(async (files) => {
                const root = await navigator.storage.getDirectory();
                await root.removeEntry('watched', { recursive: true }).catch(() => undefined);
                const dir = await root.getDirectoryHandle('watched', { create: true });
                const write = async (p, text) => {
                    const parts = p.split('/');
                    let d = dir;
                    for (const seg of parts.slice(0, -1)) d = await d.getDirectoryHandle(seg, { create: true });
                    const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
                    await w.write(text);
                    await w.close();
                };
                for (const [p, text] of Object.entries(files)) await write(p, text);
                window.__watched = { dir, write };
                await window.codearchyPlayground.load({ kind: 'handle', handle: dir, watch: true }, 'watched');
            }, fixture);
            await page.waitForFunction(() => /watching for changes/.test(document.getElementById('status').textContent));
            await page.evaluate(() => window.__watched.write('web/src/addedLive.ts', "import { util } from './lib/util';\nexport const live = util;\n"));
            await page.waitForFunction(() => /changed on disk/.test(document.getElementById('status').textContent), undefined, { timeout: 20_000 });
            assert.equal(await stat(page, 'files'), String(GOLDEN_POLYGLOT.files.length + 1), 'live: the new file is indexed');
            assert.equal(await stat(page, 'edges'), String(GOLDEN_POLYGLOT.edges.length + 1), 'live: and its import resolved');
        }

        // A second session on the same profile: the persisted index is reused.
        await page.reload();
        await page.click('#load-sample');
        await page.waitForSelector('body[data-state="ready"]');
        if (storage.startsWith('OPFS')) assert.equal(await stat(page, 'parsed'), '0', 'warm reload parses nothing');
        assert.deepEqual(errors, [], 'no page errors');
        console.log(`✓ ${name.padEnd(8)} sample indexed, searched, inspected; zip dropped; ${writable ? 'live folder updated' : 'live folder skipped (no createWritable)'}; storage ${storage} (${Date.now() - started} ms)`);
    } catch (err) {
        failed++;
        console.log(`✗ ${name}: ${err.message}${errors.length ? `\n    page errors: ${errors.join(' | ')}` : ''}`);
    } finally {
        await context.close();
        await browser?.close();
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
}
close();
if (failed) process.exit(1);
console.log('\nplayground smoke passes');
process.exit(0);
