import { defineConfig } from '@vscode/test-cli';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
    files: 'out/test/suite/**/*.test.js',
    extensionDevelopmentPath: '.',
    // A small multi-language repo, so the suite exercises real analysis.
    workspaceFolder: './test-fixtures/polyglot',
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
