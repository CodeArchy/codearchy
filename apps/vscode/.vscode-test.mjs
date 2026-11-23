import { defineConfig } from '@vscode/test-cli';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
    files: 'out/test/suite/**/*.test.js',
    extensionDevelopmentPath: '.',
    // A small multi-language repo, so the suite exercises real analysis.
    workspaceFolder: '../../fixtures/polyglot',
    // Run the bundled parse workers even on the small fixture (normally only for 200+ files).
    env: { CODEARCHY_MIN_FILES_FOR_WORKERS: '1' },
    mocha: {
        ui: 'tdd',
        color: true,
        timeout: 30_000,
    },
    launchArgs: [
        '--disable-extensions',
        '--disable-gpu',
        // VS Code's IPC socket path must stay under ~103 chars on macOS; the
        // default (inside .vscode-test/) breaks in deeply nested checkouts.
        `--user-data-dir=${join(tmpdir(), 'codearchy-vscode-test')}`,
    ],
});
