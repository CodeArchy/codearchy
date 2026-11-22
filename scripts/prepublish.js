#!/usr/bin/env node
/**
 * scripts/prepublish.js
 *
 * Runs as `vscode:prepublish` before `vsce package` or `vsce publish`.
 *
 * Behaviour:
 *  - In CI (process.env.CI === 'true')  → skips the large Kokoro model
 *    download (models are excluded from the VSIX via .vscodeignore anyway).
 *  - Locally / during real publishing   → downloads the Kokoro model so
 *    developers can test TTS features without a separate manual step.
 *  - Always → fetches the pinned tree-sitter grammars into parsers/.
 */

'use strict';

const { execSync } = require('child_process');

const run = (cmd) => execSync(cmd, { stdio: 'inherit', shell: true });

const isCI = process.env.CI === 'true' || process.env.CI === '1';

if (isCI) {
    console.log('[prepublish] CI environment detected — skipping Kokoro model download.');
} else {
    console.log('[prepublish] Downloading Kokoro TTS model...');
    run('npm run download-kokoro');
}

run('npm run grammars');
run('npm run build:webview');
run('npm run compile');
