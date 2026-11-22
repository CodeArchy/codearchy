import * as assert from 'assert';
import * as vscode from 'vscode';

/** Finds the CodeArchy extension by package name, regardless of publisher slug. */
function findExtension() {
    return vscode.extensions.all.find(
        (e) => e.packageJSON?.name === 'codearchy',
    );
}

suite('CodeArchy — Smoke Tests', () => {
    suiteSetup(async () => {
        // Give VS Code time to finish loading extensions
        await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
    });

    test('Extension is present in the registry', () => {
        const ext = findExtension();
        assert.ok(ext, 'codearchy extension was not found in the extensions registry');
    });

    test('Extension activates without errors', async () => {
        const ext = findExtension();
        assert.ok(ext, 'Extension not found');
        if (!ext.isActive) {
            await ext.activate();
        }
        assert.strictEqual(ext.isActive, true, 'Extension failed to reach active state');
    });

    test('Tree-sitter runtime and grammars load in the extension host', async () => {
        const ext = findExtension();
        assert.ok(ext, 'Extension not found');
        const api = (ext.isActive ? ext.exports : await ext.activate()) as
            | { parserStatus(): Promise<{ treeSitter: boolean; grammars: string[] }> }
            | undefined;
        assert.ok(api?.parserStatus, 'activate() should return the CodeArchy API');
        const status = await api.parserStatus();
        assert.strictEqual(status.treeSitter, true, 'web-tree-sitter failed to initialise in the extension host');
        for (const grammar of ['tree-sitter-typescript.wasm', 'tree-sitter-python.wasm', 'tree-sitter-go.wasm']) {
            assert.ok(status.grammars.includes(grammar), `missing grammar ${grammar}; found ${status.grammars.join(', ')}`);
        }
    });

    test('All contributed commands are registered', async () => {
        const ext = findExtension();
        if (ext && !ext.isActive) {
            await ext.activate();
        }

        const allCommands = await vscode.commands.getCommands(true);
        const expectedCommands = [
            'codearchy.showArchitecture',
            'codearchy.analyzeWorkspace',
            'codearchy.refreshView',
            'codearchy.exportSVG',
            'codearchy.exportPNG',
            'codearchy.openSidebar',
        ];

        for (const cmd of expectedCommands) {
            assert.ok(
                allCommands.includes(cmd),
                `Expected command "${cmd}" is not registered`,
            );
        }
    });

    test('Extension configuration schema is registered', () => {
        const config = vscode.workspace.getConfiguration('codearchy');
        assert.ok(config, 'codearchy configuration namespace not found');

        const aiModel = config.get<string>('aiModel');
        assert.ok(
            ['gemma-e2b', 'gemma-e4b', 'none'].includes(aiModel ?? ''),
            `Unexpected default aiModel value: "${aiModel}"`,
        );

        const aiProcessing = config.get<string>('aiProcessing');
        assert.ok(
            ['fast', 'moderate', 'indepth'].includes(aiProcessing ?? ''),
            `Unexpected default aiProcessing value: "${aiProcessing}"`,
        );
    });

    test('Extension does not pollute global command namespace on activate', async () => {
        const ext = findExtension();
        if (ext && !ext.isActive) {
            await ext.activate();
        }
        // Count only our namespace: VS Code itself registers built-in commands
        // lazily (more so with a workspace open), so a before/after total is noisy.
        const ours = (await vscode.commands.getCommands(true)).filter((c) => c.startsWith('codearchy.'));
        const contributed: string[] = (ext?.packageJSON?.contributes?.commands ?? []).map((c: { command: string }) => c.command);
        for (const cmd of contributed) {
            assert.ok(ours.includes(cmd), `contributed command "${cmd}" is not registered`);
        }
        // Allow generated view commands (focus, refresh, ...) but not hundreds.
        assert.ok(ours.length <= 40, `Activation registered an unexpected number of codearchy.* commands (${ours.length})`);
    });
});
