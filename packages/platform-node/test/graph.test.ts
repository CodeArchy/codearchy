import { describe, test, beforeAll } from 'vitest';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { buildGraph, classifyFiles, DEFAULT_EXCLUDE_PATTERNS, DEFAULT_LANGUAGE_IDS, readManifests } from '@codearchy/core';
import type { ArchitectureGraph } from '@codearchy/protocol';
import { createNodeAnalyzer, fromPosix, walkFiles } from '../src/index.js';
import { FIXTURES } from './helpers.js';

async function buildFixtureGraph(name: string): Promise<ArchitectureGraph> {
    const root = path.join(FIXTURES, name);
    const discovery = classifyFiles(await walkFiles(root), { languages: DEFAULT_LANGUAGE_IDS, excludePatterns: DEFAULT_EXCLUDE_PATTERNS, maxFiles: 0 }, 'walk');
    const { analyzer, fs } = await createNodeAnalyzer({ root, maxFileSize: 1_000_000 });
    const analyses = await analyzer.analyzeAll(discovery.sourceFiles);
    const manifests = await readManifests(fs, discovery.manifests);
    return buildGraph(analyses.values(), manifests, { toHostPath: (p) => fromPosix(root, p) });
}

function edgesFrom(graph: ArchitectureGraph, source: string): string[] {
    return graph.edges.filter((e) => e.source === source).map((e) => e.target).sort();
}

describe('Dependency graph (polyglot fixture)', () => {
    let graph: ArchitectureGraph;

    beforeAll(async () => {
        graph = await buildFixtureGraph('polyglot');
    });

    test('every fixture file is parsed with tree-sitter', () => {
        assert.strictEqual(graph.metadata.parserStats?.regex, 0);
        assert.strictEqual(graph.metadata.parserStats?.treeSitter, graph.nodes.length);
        assert.deepStrictEqual(graph.metadata.languages.sort(), DEFAULT_LANGUAGE_IDS.slice().sort());
    });

    test('node ids are workspace-relative POSIX paths', () => {
        assert.ok(graph.nodes.some((n) => n.id === 'web/src/index.ts'));
        assert.ok(graph.nodes.every((n) => !n.id.includes('\\') && !path.isAbsolute(n.id)));
        assert.ok(graph.nodes.every((n) => path.isAbsolute(n.filePath)), 'host paths are absolute');
    });

    test('Ruby (pack resolveImport hook): require_relative, lib/ load path, gems are external', () => {
        assert.deepStrictEqual(edgesFrom(graph, 'rb/bin/run.rb'), ['rb/lib/billing.rb']);
        assert.deepStrictEqual(edgesFrom(graph, 'rb/lib/billing.rb'), ['rb/lib/billing/invoice.rb']);
        assert.deepStrictEqual(edgesFrom(graph, 'rb/lib/billing/invoice.rb'), ['rb/lib/billing/money.rb']);
        assert.deepStrictEqual(edgesFrom(graph, 'rb/tasks/release.rake'), ['rb/lib/billing.rb']);
    });

    test('TypeScript: relative, tsconfig paths, workspace package, ESM .js → .ts', () => {
        assert.deepStrictEqual(edgesFrom(graph, 'web/src/index.ts'), [
            'packages/shared/src/index.ts',
            'web/src/esm.ts',
            'web/src/lib/util.ts',
            'web/src/ui/Button.tsx',
        ]);
        assert.deepStrictEqual(edgesFrom(graph, 'web/src/legacy.cjs'), ['web/src/lib/util.ts']);
    });

    test('Python: absolute + relative imports; stdlib names never match local files', () => {
        assert.deepStrictEqual(edgesFrom(graph, 'py/app/main.py'), [
            'py/app/config.py',
            'py/app/models/__init__.py',
            'py/app/models/user.py',
            'py/app/services/billing.py',
        ]);
    });

    test('Java/Kotlin: FQN across languages, wildcard and same-package narrowed by use', () => {
        assert.deepStrictEqual(edgesFrom(graph, 'jvm/src/main/java/com/acme/orders/OrderService.java'), [
            'jvm/src/main/java/com/acme/orders/OrderRepo.java',
            'jvm/src/main/java/com/acme/util/Strings.java',
            'jvm/src/main/kotlin/com/acme/payments/PaymentClient.kt',
        ]);
    });

    test('Go: module path from go.mod, narrowed to files whose names are used', () => {
        assert.deepStrictEqual(edgesFrom(graph, 'go/cmd/server/main.go'), ['go/internal/store/store.go']);
        assert.deepStrictEqual(edgesFrom(graph, 'go/internal/store/helper.go'), ['go/internal/store/store.go']);
        assert.deepStrictEqual(edgesFrom(graph, 'go/internal/store/other.go'), []);
    });

    test('Rust: mod declarations, crate:: and super:: paths', () => {
        assert.deepStrictEqual(edgesFrom(graph, 'rust/src/lib.rs'), [
            'rust/src/config.rs',
            'rust/src/handlers/mod.rs',
            'rust/src/models.rs',
        ]);
        assert.deepStrictEqual(edgesFrom(graph, 'rust/src/handlers/mod.rs'), ['rust/src/config.rs', 'rust/src/models.rs']);
    });

    test('C#: using narrows a namespace to the types referenced', () => {
        assert.deepStrictEqual(edgesFrom(graph, 'cs/Orders/OrderService.cs'), ['cs/Billing/Invoice.cs']);
    });

    test('PHP: use FQN and require_once with __DIR__', () => {
        assert.deepStrictEqual(edgesFrom(graph, 'php/src/Http/UserController.php'), [
            'php/src/Http/helpers.php',
            'php/src/Models/User.php',
        ]);
    });
});
