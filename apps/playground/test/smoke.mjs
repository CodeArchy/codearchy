#!/usr/bin/env node
/**
 * Playground smoke test in Chromium, Firefox and WebKit: load the sample,
 * check the numbers against the golden graph, search, open a file, then
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
import { serve } from '../scripts/serve.mjs';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
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

        // A second session on the same profile: the persisted index is reused.
        await page.reload();
        await page.click('#load-sample');
        await page.waitForSelector('body[data-state="ready"]');
        if (storage.startsWith('OPFS')) assert.equal(await stat(page, 'parsed'), '0', 'warm reload parses nothing');
        assert.deepEqual(errors, [], 'no page errors');
        console.log(`✓ ${name.padEnd(8)} sample indexed, searched, inspected; storage ${storage} (${Date.now() - started} ms)`);
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
