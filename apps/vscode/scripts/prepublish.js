#!/usr/bin/env node
/**
 * scripts/prepublish.js
 *
 * Runs as `vscode:prepublish` before `vsce package` or `vsce publish`.
 *
 * Behaviour:
 *  - Fetches the pinned tree-sitter grammars into parsers/.
 *  - Builds the webview and compiles the extension host.
 *
 * The Kokoro voice model is NOT bundled: the extension downloads it on first
 * activation (verified against pinned hashes, cached in global storage). For
 * offline local development, `npm run download-kokoro` still prepares a copy.
 */

'use strict';

const { execSync } = require('child_process');

const run = (cmd) => execSync(cmd, { stdio: 'inherit', shell: true });

run('npm run grammars');
run('npm run build:webview');
run('npm run compile');
