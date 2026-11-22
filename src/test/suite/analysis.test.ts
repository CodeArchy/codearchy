import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

interface Api {
    getGraph(): { nodes: Array<{ id: string }>; edges: Array<{ source: string; target: string }> } | undefined;
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
        await new Promise((r) => setTimeout(r, 100));
    }
}

/**
 * Runs only when the sandbox opens test-fixtures/polyglot as the workspace
 * (see .vscode-test.mjs).
 */
suite('CodeArchy — Analysis in the extension host', function () {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const added = folder ? path.join(folder.uri.fsPath, 'web', 'src', 'addedByTest.ts') : '';
    const ignoredDir = folder ? path.join(folder.uri.fsPath, 'generated-by-test') : '';
    let api: Api;

    suiteSetup(async function () {
        if (!folder || path.basename(folder.uri.fsPath) !== 'polyglot') this.skip();
        const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'codearchy')!;
        api = (ext.isActive ? ext.exports : await ext.activate()) as Api;
    });

    suiteTeardown(() => {
        // Windows can briefly hold handles on paths VS Code's file watcher just
        // saw (EPERM/EBUSY); retry, and never fail the suite over cleanup.
        const remove = (p: string) => {
            try {
                fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(`cleanup of ${p} failed: ${(err as Error).message}`);
            }
        };
        if (added) remove(added);
        if (ignoredDir) remove(ignoredDir);
    });

    test('analyzes every language with tree-sitter and resolves cross-file edges', async () => {
        const meta = (await vscode.commands.executeCommand('codearchy.analyzeWorkspace')) as {
            fileCount: number;
            parserStats?: { treeSitter: number; regex: number };
            languages: string[];
        };
        assert.ok(meta, 'analyzeWorkspace should return graph metadata');
        assert.ok(meta.fileCount >= 30, `expected the fixture's files, got ${meta.fileCount}`);
        assert.strictEqual(meta.parserStats?.regex, 0, 'no file should need the regex fallback');
        assert.strictEqual(meta.languages.length, 9);

        const graph = api.getGraph()!;
        const has = (s: string, t: string) => graph.edges.some((e) => e.source === s && e.target === t);
        assert.ok(has('web/src/index.ts', 'web/src/lib/util.ts'));
        assert.ok(has('go/cmd/server/main.go', 'go/internal/store/store.go'));
        assert.ok(has('cs/Orders/OrderService.cs', 'cs/Billing/Invoice.cs'));
    });

    test('picks up files created and deleted on disk, edges included', async () => {
        fs.writeFileSync(added, "import { util } from './lib/util';\nexport const added = util;\n");
        await waitFor(() =>
            !!api.getGraph()?.edges.some((e) => e.source === 'web/src/addedByTest.ts' && e.target === 'web/src/lib/util.ts')
        );

        fs.unlinkSync(added);
        await waitFor(() => !api.getGraph()?.nodes.some((n) => n.id === 'web/src/addedByTest.ts'));
        assert.ok(!api.getGraph()!.edges.some((e) => e.source === 'web/src/addedByTest.ts'));
    });

    test('files that git ignores stay out of the graph when they appear later', async () => {
        fs.mkdirSync(ignoredDir, { recursive: true });
        fs.writeFileSync(path.join(ignoredDir, '.gitignore'), '*.ts\n');
        fs.writeFileSync(path.join(ignoredDir, 'ignored.ts'), 'export const x = 1;\n');
        // A non-ignored file in the same burst proves the batch was processed.
        fs.writeFileSync(path.join(ignoredDir, 'kept.py'), 'X = 1\n');
        await waitFor(() => !!api.getGraph()?.nodes.some((n) => n.id === 'generated-by-test/kept.py'));
        assert.ok(!api.getGraph()!.nodes.some((n) => n.id === 'generated-by-test/ignored.ts'));
    });
});
