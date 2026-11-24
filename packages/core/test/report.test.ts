import { describe, test } from 'vitest';
import * as assert from 'node:assert';
import { EdgeType, NodeType, type ArchitectureGraph, type BranchReport } from '@codearchy/protocol';
import { buildHierarchy, countLines, HierarchyIndex, newDependencies, partOf, renderBranchReport } from '../src/index.js';

const files = ['api/routes.ts', 'api/handlers.ts', 'core/orders.ts', 'core/money.ts', 'db/users.ts', 'api/test/routes.test.ts'];
const graph: ArchitectureGraph = {
    nodes: files.map((id) => ({ id, label: id, filePath: id, type: NodeType.File, symbols: [], metadata: {} })),
    edges: [{ id: 'e', source: 'api/routes.ts', target: 'api/handlers.ts', type: EdgeType.Import, weight: 1, metadata: {} }],
    subsystems: [],
    metadata: { analyzedAt: 0, fileCount: files.length, totalSymbols: 0, totalEdges: 1, languages: [] },
};
const index = new HierarchyIndex(buildHierarchy(graph, { systemName: 'shop' }));

describe('branch report helpers', () => {
    test('partOf: the nearest component', () => {
        assert.strictEqual(partOf(index, 'core/orders.ts')!.key, 'dir:core');
        assert.strictEqual(partOf(index, 'db/users.ts')!.key, 'mod:db/users.ts'); // no component above it
        assert.strictEqual(partOf(index, 'nope.ts'), undefined);
    });

    test('countLines: by the ranges covering each line, unknown otherwise; per tool', () => {
        const byAgent: Record<string, number> = {};
        const c = countLines([1, 2, 3, 7, 9], [{ start: 1, end: 2, origin: 'ai', agent: 'codex' }, { start: 7, end: 8, origin: 'reviewed', agent: 'codex' }, { start: 9, end: 9, origin: 'human' }], byAgent);
        assert.deepStrictEqual(c, { ai: 2, reviewed: 1, human: 1, unknown: 1 });
        assert.deepStrictEqual(byAgent, { codex: 3 });
    });

    test('newDependencies: part pairs that are new, with the files behind them; same part and tests left out', () => {
        const before: Array<[string, string]> = [['api/routes.ts', 'api/handlers.ts'], ['api/handlers.ts', 'core/orders.ts']];
        const after: Array<[string, string]> = [...before, ['core/orders.ts', 'db/users.ts'], ['core/money.ts', 'db/users.ts'], ['core/orders.ts', 'core/money.ts'], ['api/test/routes.test.ts', 'db/users.ts']];
        assert.deepStrictEqual(newDependencies(index, before, after), [
            // db/ holds one file, folded into the root: that file is its own part.
            { from: 'dir:core', to: 'mod:db/users.ts', fromName: 'core', toName: 'users.ts', via: [{ from: 'core/orders.ts', to: 'db/users.ts' }, { from: 'core/money.ts', to: 'db/users.ts' }] },
        ]);
    });
});

describe('renderBranchReport', () => {
    const report: BranchReport = {
        base: 'main',
        mergeBase: 'a'.repeat(40),
        head: 'b'.repeat(40),
        commits: 3,
        added: { ai: 60, reviewed: 20, human: 10, unknown: 10 },
        uncommitted: 5,
        byAgent: { 'claude-code': 70, copilot: 10 },
        byPart: [{ key: 'dir:core', name: 'core', added: { ai: 60, reviewed: 20, human: 10, unknown: 10 } }],
        files: [{ path: 'core/orders.ts', added: { ai: 60, reviewed: 20, human: 10, unknown: 10 }, status: 'modified' }],
        newDependencies: [{ from: 'dir:core', to: 'dir:db', fromName: 'core', toName: 'db', via: [{ from: 'core/orders.ts', to: 'db/users.ts' }] }],
        deleted: ['old.ts'],
    };

    test('a headline, tools, new dependencies, parts and unreviewed files', () => {
        const md = renderBranchReport(report);
        assert.match(md, /^## Authorship: this branch vs `main`/);
        assert.match(md, /\*\*100 lines added\*\* in 3 commits \(5 not committed yet\): 60 written by AI tools and not changed since \(60%\), 20 AI-written and reviewed or changed by a person \(20%\), 10 by people \(10%\), 10 with no evidence either way \(10%\)\./);
        assert.match(md, /By tool: Claude Code 70 · GitHub Copilot 10\./);
        assert.match(md, /- \*\*core → db\*\* \(`core\/orders\.ts` → `db\/users\.ts`\)/);
        assert.match(md, /\| core \| 100 \| 60 \| 20 \| 10 \| 10 \|/);
        assert.match(md, /- `core\/orders\.ts`: 60 of 100 added lines/);
        assert.match(md, /1 file deleted\./);
    });

    test('nothing added', () => {
        assert.match(renderBranchReport({ ...report, added: { ai: 0, reviewed: 0, human: 0, unknown: 0 }, deleted: [], files: [], byPart: [] }), /No lines added since `aaaaaaa`\./);
    });
});
