import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

interface Api {
    getGraph(): { nodes: Array<{ id: string }>; edges: Array<{ source: string; target: string }> } | undefined;
    engine(method: string, params: Record<string, unknown>): unknown;
    locate(fsPath: string): unknown;
    ai(method: string, params: Record<string, unknown>): Promise<unknown>;
    aiAsk(question: string, selection?: string): Promise<unknown[]>;
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
        assert.strictEqual(meta.languages.length, 10);

        const graph = api.getGraph()!;
        const has = (s: string, t: string) => graph.edges.some((e) => e.source === s && e.target === t);
        assert.ok(has('web/src/index.ts', 'web/src/lib/util.ts'));
        assert.ok(has('go/cmd/server/main.go', 'go/internal/store/store.go'));
        assert.ok(has('cs/Orders/OrderService.cs', 'cs/Billing/Invoice.cs'));
        assert.ok(has('rb/bin/run.rb', 'rb/lib/billing.rb'), 'Ruby resolves through its pack hook');
    });

    test('the AI host: private by default, auto-built cards, keys in SecretStorage, tiers, and chat without a model', async () => {
        await vscode.commands.executeCommand('codearchy.analyzeWorkspace');
        type Provider = { id: string; allowed: boolean; hasKey: boolean; onDevice: boolean; state?: string };
        type State = { settings: { tier: string }; providers: Provider[]; resolved: Record<string, { ok: boolean }> };
        const state = (await api.ai('state', {})) as State;
        assert.strictEqual(state.settings.tier, 'local-only', 'nothing leaves the machine until the user chooses');
        assert.deepStrictEqual(
            state.providers.map((p) => p.id),
            ['ollama', 'lmstudio', 'vscode-lm', 'anthropic', 'openai', 'gemini', 'openrouter', 'groq', 'mistral'],
        );
        assert.ok(state.providers.filter((p) => !p.onDevice).every((p) => !p.allowed), 'cloud and Copilot are ruled out under local only');

        const card = (await api.ai('card', { key: 'mod:rb/lib/billing.rb' })) as { source: string; purpose: string };
        assert.strictEqual(card.source, 'deterministic');
        assert.strictEqual(card.purpose, 'Entry point of the billing gem.');

        const withKey = (await api.ai('setKey', { provider: 'anthropic', key: 'sk-ant-sandbox-not-a-real-key' })) as State;
        assert.ok(withKey.providers.find((p) => p.id === 'anthropic')!.hasKey);
        assert.ok(!JSON.stringify(withKey).includes('sk-ant-sandbox'), 'a stored key is never sent back');
        await api.ai('setKey', { provider: 'anthropic', key: null });

        const opened = (await api.ai('updateSettings', { patch: { tier: 'structure' } })) as State;
        assert.ok(opened.providers.find((p) => p.id === 'vscode-lm')!.allowed, 'Copilot is allowed once code structure may leave');
        await api.ai('updateSettings', { patch: { tier: 'local-only' } });

        // No model runs in the sandbox: the chat says so instead of failing.
        const events = (await api.aiAsk('Where is billing?')) as Array<{ type: string; message?: string }>;
        const last = events[events.length - 1]!;
        assert.strictEqual(last.type, 'error');
        assert.match(last.message ?? '', /provider|model|tier/i);
    });

    test('the new UI\'s engine: views, details, explain, search; files located for the status bar and CodeLens', async () => {
        await vscode.commands.executeCommand('codearchy.analyzeWorkspace');
        type View = { breadcrumb: Array<{ key: string }>; nodes: Array<{ key: string }>; edges: Array<{ source: string; target: string }>; ports: Array<{ node: string; external: string }> };
        const root = api.engine('view', { request: {} }) as View;
        assert.ok(root.nodes.some((n) => n.key === 'pkg:rust'), 'packages from manifests at the top');
        const web = api.engine('view', { request: { scope: 'dir:web/src' } }) as View;
        assert.deepStrictEqual(web.breadcrumb.map((b) => b.key), ['sys:root', 'pkg:.', 'dir:web/src']);
        assert.ok(web.ports.some((p) => p.external === 'pkg:packages/shared'), 'the import of @poly/shared leaves the scope as a port stub');

        const d = api.engine('describe', { key: 'mod:web/src/index.ts' }) as { dependsOn: Array<{ key: string }>; symbols: unknown[] };
        assert.ok(d.dependsOn.some((l) => l.key === 'mod:web/src/esm.ts'));
        const x = api.engine('explain', { source: 'mod:web/src/index.ts', target: 'mod:web/src/esm.ts' }) as { total: number };
        assert.strictEqual(x.total, 1);
        const hits = api.engine('search', { query: 'OrderSer' }) as Array<{ key: string }>;
        assert.ok(hits.some((h) => h.key === 'mod:cs/Orders/OrderService.cs'));

        // Flows and tours: the fixture's Go main, and a generated Start Here tour (async answers).
        const flows = api.engine('flows', {}) as Array<{ id: string; label: string }>;
        assert.ok(flows.some((f) => f.label === 'main'));
        const tours = (await api.engine('tours', {})) as Array<{ id: string; origin: string }>;
        assert.deepStrictEqual(tours.map((t) => `${t.id}:${t.origin}`), ['start-here:generated']);
        const tour = (await api.engine('tour', { id: 'start-here' })) as { steps: Array<{ title: string }>; status: unknown[] };
        assert.strictEqual(tour.steps[0]!.title, 'The big picture');
        assert.strictEqual(tour.status.length, tour.steps.length);

        // Saving an authored tour writes .codearchy/tours/<slug>.json (anchored) and lists it; removed again after.
        const toursDir = path.join(folder!.uri.fsPath, '.codearchy');
        const existed = fs.existsSync(toursDir);
        try {
            const draft = { version: 1, id: 'draft', title: 'Web entry, end to end', origin: 'authored', steps: [{ id: 's1', target: { node: 'mod:web/src/index.ts' }, title: 'The entry', body: 'Start here.', code: [{ path: 'web/src/index.ts', start: 1, end: 2 }] }] };
            const saved = (await api.engine('saveTour', { tour: draft })) as { file: string };
            assert.strictEqual(saved.file, '.codearchy/tours/web-entry-end-to-end.json');
            const written = JSON.parse(fs.readFileSync(path.join(folder!.uri.fsPath, saved.file), 'utf8')) as { steps: Array<{ anchorHash?: string }> };
            assert.ok(written.steps[0]!.anchorHash, 'steps are anchored on save');
            const listed = (await api.engine('tours', {})) as Array<{ id: string; origin: string; stale: number }>;
            assert.ok(listed.some((t) => t.id === 'web-entry-end-to-end' && t.origin === 'authored' && t.stale === 0));
        } finally {
            if (!existed) fs.rmSync(toursDir, { recursive: true, force: true });
        }

        const file = path.join(folder!.uri.fsPath, 'web', 'src', 'index.ts');
        const here = api.locate(file) as { key: string; breadcrumb: Array<{ name: string }> };
        assert.strictEqual(here.key, 'mod:web/src/index.ts');
        const doc = await vscode.workspace.openTextDocument(file);
        const lenses = (await vscode.commands.executeCommand('vscode.executeCodeLensProvider', doc.uri)) as vscode.CodeLens[];
        const ours = lenses.find((l) => l.command?.command === 'codearchy.revealInMap');
        assert.ok(ours, 'CodeLens at the top of an indexed file');
        assert.match(ours!.command!.title, /web\/src · uses \d+ · used by \d+/);
    });

    test('persistent index: touched files are re-hashed by the bundled parse workers, nothing re-parsed', async () => {
        type Meta = { fileCount: number; indexStats?: { parsed: number; reused: number; persistent: boolean; workers: number } };
        const analyze = async () => (await vscode.commands.executeCommand('codearchy.analyzeWorkspace')) as Meta;
        const baseline = await analyze(); // cold on a fresh profile, warm otherwise
        assert.strictEqual(baseline.indexStats?.persistent, true, 'VS Code >= 1.104 has node:sqlite: the index should persist');

        // Bump every source file's mtime without changing content (git sees nothing).
        const root = folder!.uri.fsPath;
        const later = new Date(Date.now() + 120_000);
        const touch = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) touch(p);
                else fs.utimesSync(p, later, later);
            }
        };
        touch(root);

        const rehashed = await analyze();
        assert.ok((rehashed.indexStats?.workers ?? 0) > 0, 'jobs should run on the bundled worker threads');
        assert.strictEqual(rehashed.indexStats?.parsed, 0, 'unchanged content must not be re-parsed');
        assert.strictEqual(rehashed.indexStats?.reused, rehashed.fileCount);

        const warm = await analyze();
        assert.strictEqual(warm.indexStats?.parsed, 0);
        assert.strictEqual(warm.indexStats?.workers, 0, 'a fully warm run reads nothing, so no workers are needed');
        assert.strictEqual(warm.indexStats?.reused, warm.fileCount);
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
