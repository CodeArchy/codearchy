#!/usr/bin/env node
/**
 * scripts/prepublish.js
 *
 * Runs as `vscode:prepublish` before `vsce package` or `vsce publish`.
 *
 * Behaviour:
 *  - Builds the extension bundle (dist/extension.js), its parsers/ and the
 *    webview, plus every workspace package they depend on (Turborepo, cached).
 *
 * The Kokoro voice model is NOT bundled: the extension downloads it on first
 * activation (verified against pinned hashes, cached in global storage). For
 * offline local development, `npm run download-kokoro` still prepares a copy.
 */

'use strict';

const { execSync } = require('child_process');

const run = (cmd) => execSync(cmd, { stdio: 'inherit', shell: true });

run('pnpm -w exec turbo run build --filter=codearchy... --filter=codearchy-webview-ui');
