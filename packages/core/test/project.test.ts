import { describe, test } from 'vitest';
import * as assert from 'node:assert';
import { EdgeType, NodeType, type ArchitectureGraph } from '@codearchy/protocol';
import { buildHierarchy, HierarchyIndex, neighbourhood } from '../src/index.js';

function graph(files: string[], edges: Array<[string, string, number?]>): ArchitectureGraph {
    return {
        nodes: files.map((id) => ({ id, label: id, filePath: id, type: NodeType.File, symbols: [], metadata: {} })),
        edges: edges.map(([source, target, weight]) => ({
            id: `${source}:${target}`,
            source,
            target,
            type: EdgeType.Import,
            weight: weight ?? 1,
            metadata: { evidence: [{ source: target, line: 1 }] },
        })),
        subsystems: [],
        metadata: { analyzedAt: 0, fileCount: files.length, totalSymbols: 0, totalEdges: edges.length, languages: [] },
    };
}

/**
 *   api/      routes.ts  handlers.ts
 *   core/     auth/login.ts auth/token.ts   orders/new.ts orders/list.ts
 *   db/       client.ts  schema.ts
 */
const FILES = [
    'api/routes.ts', 'api/handlers.ts',
    'core/auth/login.ts', 'core/auth/token.ts', 'core/orders/new.ts', 'core/orders/list.ts',
    'db/client.ts', 'db/schema.ts',
];
const EDGES: Array<[string, string, number?]> = [
    ['api/routes.ts', 'api/handlers.ts'],
    ['api/handlers.ts', 'core/auth/login.ts', 2],
    ['api/handlers.ts', 'core/orders/new.ts'],
    ['core/auth/login.ts', 'core/auth/token.ts'],
    ['core/orders/new.ts', 'core/auth/token.ts'],
    ['core/orders/new.ts', 'db/client.ts', 3],
    ['core/orders/list.ts', 'db/schema.ts'],
];
const index = () => new HierarchyIndex(buildHierarchy(graph(FILES, EDGES), { systemName: 'shop' }));
const edgeList = (v: { edges: Array<{ source: string; target: string; weight: number; count: number }> }) => v.edges.map((e) => `${e.source} -> ${e.target} (${e.weight}/${e.count})`);

describe('Projector', () => {
    test('root view: the top components, with dependencies aggregated', () => {
        const v = index().project();
        assert.deepStrictEqual(v.nodes.map((n) => n.key), ['dir:api', 'dir:core', 'dir:db']);
        assert.deepStrictEqual(edgeList(v), ['dir:api -> dir:core (3/2)', 'dir:core -> dir:db (4/2)']);
        assert.deepStrictEqual(v.ports, []);
        assert.deepStrictEqual(v.breadcrumb.map((b) => b.key), ['sys:root']);
        const core = v.nodes.find((n) => n.key === 'dir:core')!;
        assert.deepStrictEqual([core.fanIn, core.fanOut, core.hasChildren, core.expanded], [1, 1, true, false]);
    });

    test('expand in place: the container wraps its children and edges land on them', () => {
        const v = index().project({ expanded: ['dir:core'] });
        assert.deepStrictEqual(v.nodes.map((n) => `${n.key}${n.expanded ? ' [+]' : ''}${n.group ? ` in ${n.group}` : ''}`), [
            'dir:core [+]',
            'dir:api',
            'dir:core/auth in dir:core',
            'dir:core/orders in dir:core',
            'dir:db',
        ]);
        assert.deepStrictEqual(edgeList(v), [
            'dir:api -> dir:core/auth (2/1)',
            'dir:api -> dir:core/orders (1/1)',
            'dir:core/orders -> dir:core/auth (1/1)',
            'dir:core/orders -> dir:db (4/2)',
        ]);
    });

    test('drill in: the scope becomes the canvas and outside dependencies become port stubs', () => {
        const v = index().project({ scope: 'dir:core' });
        assert.deepStrictEqual(v.breadcrumb.map((b) => b.key), ['sys:root', 'dir:core']);
        assert.deepStrictEqual(v.nodes.map((n) => n.key), ['dir:core/auth', 'dir:core/orders']);
        assert.deepStrictEqual(edgeList(v), ['dir:core/orders -> dir:core/auth (1/1)']);
        assert.deepStrictEqual(
            v.ports.map((p) => `${p.node} ${p.direction} ${p.external} (${p.weight}/${p.count})`),
            ['dir:core/auth in dir:api (2/1)', 'dir:core/orders in dir:api (1/1)', 'dir:core/orders out dir:db (4/2)']
        );
    });

    test('deeper drills attribute ports to the siblings of the scope or of its ancestors', () => {
        const v = index().project({ scope: 'dir:core/orders' });
        assert.deepStrictEqual(v.nodes.map((n) => n.key), ['mod:core/orders/list.ts', 'mod:core/orders/new.ts']);
        assert.deepStrictEqual(
            v.ports.map((p) => `${p.node} ${p.direction} ${p.external}`),
            ['mod:core/orders/list.ts out dir:db', 'mod:core/orders/new.ts in dir:api', 'mod:core/orders/new.ts out dir:core/auth', 'mod:core/orders/new.ts out dir:db']
        );
    });

    test('a module scope shows its parent; expansions over budget are skipped and reported', () => {
        const idx = index();
        assert.strictEqual(idx.project({ scope: 'mod:db/client.ts' }).scope, 'dir:db');
        const v = idx.project({ expanded: ['dir:core', 'dir:db', 'dir:api'], budget: 5 });
        assert.deepStrictEqual(v.skipped, ['dir:db']); // api (+1) and core (+1) fit; db would make 6
        assert.ok(v.nodes.filter((n) => !n.expanded).length <= 5);
    });

    test('expanding a node inside a collapsed one changes nothing; frontier hashes identify views', () => {
        const idx = index();
        const plain = idx.project();
        assert.strictEqual(idx.project({ expanded: ['dir:core/auth'] }).frontierHash, plain.frontierHash);
        assert.notStrictEqual(idx.project({ expanded: ['dir:core'] }).frontierHash, plain.frontierHash);
        assert.strictEqual(idx.project({ expanded: ['dir:core'] }).frontierHash, idx.project({ expanded: ['dir:core'] }).frontierHash);
    });

    test('explain edge lists the module dependencies behind it, heaviest first, with evidence', () => {
        const x = index().explainEdge('dir:core', 'dir:db')!;
        assert.strictEqual(x.total, 2);
        assert.deepStrictEqual(x.dependencies.map((d) => `${d.from} -> ${d.to} ×${d.weight}`), ['core/orders/new.ts -> db/client.ts ×3', 'core/orders/list.ts -> db/schema.ts ×1']);
        assert.deepStrictEqual(x.dependencies[0].evidence, [{ source: 'db/client.ts', line: 1 }]);
    });

    test('focus: neighbourhood by hops and direction', () => {
        const v = index().project({ expanded: ['dir:core'] });
        assert.deepStrictEqual([...neighbourhood(v, 'dir:core/orders', 1, 'down')].sort(), ['dir:core/auth', 'dir:core/orders', 'dir:db']);
        assert.deepStrictEqual([...neighbourhood(v, 'dir:core/auth', 1, 'up')].sort(), ['dir:api', 'dir:core/auth', 'dir:core/orders']);
        assert.deepStrictEqual([...neighbourhood(v, 'dir:db', 2, 'up')].sort(), ['dir:api', 'dir:core/orders', 'dir:db']);
    });

    test('property: every base edge is accounted for exactly once, matching a brute-force projection', () => {
        let seed = 7;
        const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
        const files = Array.from({ length: 120 }, (_, i) => `${['a', 'b', 'c'][i % 3]}/${['x', 'y', 'z', 'w'][(i >> 2) % 4]}/${['p', 'q'][i % 2]}/f${i}.ts`);
        const edges: Array<[string, string, number]> = [];
        for (let i = 0; i < 400; i++) {
            const a = files[Math.floor(rand() * files.length)];
            const b = files[Math.floor(rand() * files.length)];
            if (a !== b) edges.push([a, b, 1 + Math.floor(rand() * 3)]);
        }
        const h = buildHierarchy(graph(files, edges), { systemName: 'r', maxChildren: 4 });
        const idx = new HierarchyIndex(h);
        const containers = h.nodes.filter((n) => n.kind !== 'module' && n.kind !== 'symbol');
        for (const scope of containers) {
            const expanded = idx.childrenOf(scope.tin).filter((c) => idx.hasChildren(c)).slice(0, 2).map((c) => h.nodes[c].key);
            const v = idx.project({ scope: scope.key, expanded, budget: 10_000 });
            const leaves = v.nodes.filter((n) => !n.expanded).map((n) => idx.indexOf(n.key)!);
            const owner = (x: number) => leaves.find((l) => idx.contains(l, x));
            let internal = 0;
            let crossing = 0;
            const expected = new Map<string, number>();
            for (const e of h.edges) {
                const inSrc = idx.contains(scope.tin, e.src);
                const inDst = idx.contains(scope.tin, e.dst);
                if (inSrc && inDst) {
                    const u = owner(e.src)!;
                    const w = owner(e.dst)!;
                    if (u !== w) {
                        const key = `${h.nodes[u].key} -> ${h.nodes[w].key}`;
                        expected.set(key, (expected.get(key) ?? 0) + e.weight);
                        internal += e.weight;
                    }
                } else if (inSrc || inDst) {
                    crossing += e.weight;
                }
            }
            const got = new Map(v.edges.map((e) => [`${e.source} -> ${e.target}`, e.weight]));
            assert.deepStrictEqual(got, expected, `edges of ${scope.key}`);
            assert.strictEqual(v.edges.reduce((s, e) => s + e.weight, 0), internal);
            assert.strictEqual(v.ports.reduce((s, p) => s + p.weight, 0), crossing, `ports of ${scope.key}`);
        }
    });
});
