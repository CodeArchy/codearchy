import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
    files: 'out/test/suite/**/*.test.js',
    extensionDevelopmentPath: '.',
    mocha: {
        ui: 'tdd',
        color: true,
        timeout: 30_000,
    },
    launchArgs: [
        '--disable-extensions',
        '--disable-gpu',
    ],
});
