import { describe, test } from 'vitest';
import * as assert from 'node:assert';
import type { View, ViewNode } from '@codearchy/protocol';
import { buildMapModel, neighbourhood, strokeWidthFor, toElkGraph, fromElkGraph, visibleEdges, reduceEdges, lensBadge, matrixOrder, heatStep, flowRoles, revealPlan, authorshipShares, agentName, type MapModel } from '../src/index.js';

const METRICS = { modules: 3, symbols: 0, codeModules: 3, testModules: 0, testedModules: 0, cyclicModules: 0, orphanModules: 0, hubModules: 0, fanIn: 0, fanOut: 0 };

const node = (key: string, extra: Partial<ViewNode> = {}): ViewNode => ({
    key,
    kind: 'component',
    name: key.split('/').pop()!,
    path: key,
    expanded: false,
    hasChildren: true,
    modules: 3,
    fanIn: 0,
    fanOut: 0,
    metrics: METRICS,
    ...extra,
});

/** scope core: auth and orders expanded? orders is expanded into two files. */
const VIEW: View = {
    scope: 'dir:core',
    breadcrumb: [{ key: 'sys:root', name: 'shop', kind: 'system' }, { key: 'dir:core', name: 'core', kind: 'component' }],
    nodes: [
        node('dir:core/orders', { expanded: true }),
        node('dir:core/auth'),
        node('mod:core/orders/new.ts', { kind: 'module', hasChildren: false, group: 'dir:core/orders' }),
        node('mod:core/orders/list.ts', { kind: 'module', hasChildren: false, group: 'dir:core/orders' }),
    ],
    edges: [{ source: 'mod:core/orders/new.ts', target: 'dir:core/auth', weight: 3, count: 2, implicit: false }],
    ports: [
        { node: 'mod:core/orders/new.ts', external: 'dir:db', externalName: 'db', direction: 'out', weight: 4, count: 2 },
        { node: 'mod:core/orders/list.ts', external: 'dir:db', externalName: 'db', direction: 'out', weight: 1, count: 1 },
        { node: 'dir:core/auth', external: 'dir:api', externalName: 'api', direction: 'in', weight: 2, count: 1 },
    ],
    skipped: [],
    frontierHash: 'h1',
};

describe('Map model', () => {
    test('containers, leaves and one external node per outside key', () => {
        const m = buildMapModel(VIEW);
        assert.deepStrictEqual(
            m.nodes.map((n) => `${n.type} ${n.id}${n.parent ? ` in ${n.parent}` : ''}`),
            [
                'container dir:core/orders',
                'node dir:core/auth',
                'node mod:core/orders/new.ts in dir:core/orders',
                'node mod:core/orders/list.ts in dir:core/orders',
                'external ext:dir:db',
                'external ext:dir:api',
            ]
        );
        assert.deepStrictEqual(
            m.edges.map((e) => `${e.source} -> ${e.target}${e.port ? ' (port)' : ''}`),
            [
                'mod:core/orders/new.ts -> dir:core/auth',
                'mod:core/orders/new.ts -> ext:dir:db (port)',
                'mod:core/orders/list.ts -> ext:dir:db (port)',
                'ext:dir:api -> dir:core/auth (port)',
            ]
        );
        const parents = new Set(m.nodes.filter((n) => n.parent).map((n) => n.parent));
        for (const p of parents) {
            assert.ok(m.nodes.findIndex((n) => n.id === p) < m.nodes.findIndex((n) => n.parent === p), 'parents come before children (React Flow)');
        }
    });

    test('edge widths grow with weight, capped', () => {
        assert.strictEqual(strokeWidthFor(1), 1);
        assert.ok(strokeWidthFor(8) > strokeWidthFor(2));
        assert.strictEqual(strokeWidthFor(1e9), 6);
    });

    test('neighbourhood follows edges both ways and lights the containers of lit nodes', () => {
        const m = buildMapModel(VIEW);
        assert.deepStrictEqual([...neighbourhood(m, 'dir:core/auth', 1)].sort(), ['dir:core/auth', 'dir:core/orders', 'ext:dir:api', 'mod:core/orders/new.ts']);
        assert.ok(neighbourhood(m, 'dir:core/auth', 2).has('ext:dir:db'));
    });

    test('ELK graph: containers hold their children, edges at the root; positions read back relative', () => {
        const m = buildMapModel(VIEW);
        const g = toElkGraph(m);
        assert.deepStrictEqual(g.children!.map((c) => c.id), ['dir:core/orders', 'dir:core/auth', 'ext:dir:db', 'ext:dir:api']);
        const orders = g.children![0];
        assert.deepStrictEqual(orders.children!.map((c) => c.id), ['mod:core/orders/new.ts', 'mod:core/orders/list.ts']);
        assert.strictEqual(g.layoutOptions!['elk.hierarchyHandling'], 'INCLUDE_CHILDREN');
        assert.strictEqual(g.edges!.length, 4);

        orders.x = 10;
        orders.y = 20;
        orders.width = 300;
        orders.height = 200;
        orders.children![0].x = 5;
        const layout = fromElkGraph(g);
        assert.deepStrictEqual(layout.boxes.get('dir:core/orders'), { x: 10, y: 20, width: 300, height: 200 });
        assert.strictEqual(layout.boxes.get('mod:core/orders/new.ts')!.x, 5, 'child positions stay relative to the container');
        assert.strictEqual(g.layoutOptions!['elk.json.edgeCoords'], 'ROOT', 'routes come back in canvas coordinates');
    });

    test('ELK routes every edge around the cards: no line passes through a card that is not one of its ends', async () => {
        // A dense view shaped like the ones that tangled (tokio, nowinandroid): 12 parts, edges skipping
        // layers, a cycle, and one part expanded into a container of files.
        const keys = ['app', 'cli', 'web', 'api', 'auth', 'orders', 'billing', 'search', 'util', 'db', 'queue', 'tests'].map((k) => `dir:${k}`);
        const nodes: ViewNode[] = keys.map((k) => node(k, k === 'dir:orders' ? { expanded: true } : {}));
        nodes.push(node('mod:orders/a.ts', { kind: 'module', hasChildren: false, group: 'dir:orders' }), node('mod:orders/b.ts', { kind: 'module', hasChildren: false, group: 'dir:orders' }));
        const pairs = [
            ['app', 'api'], ['app', 'util'], ['app', 'db'], ['cli', 'api'], ['cli', 'util'], ['web', 'api'], ['web', 'auth'], ['web', 'search'],
            ['api', 'auth'], ['api', 'billing'], ['api', 'search'], ['api', 'util'], ['auth', 'db'], ['billing', 'db'], ['billing', 'queue'],
            ['search', 'db'], ['search', 'util'], ['util', 'db'], ['tests', 'app'], ['tests', 'util'], ['tests', 'db'], ['db', 'util'], ['queue', 'util'],
        ];
        const edges = pairs.map(([s, t]) => ({ source: `dir:${s}`, target: `dir:${t}`, weight: 2, count: 1, implicit: false }));
        edges.push(
            { source: 'dir:api', target: 'mod:orders/a.ts', weight: 2, count: 1, implicit: false },
            { source: 'mod:orders/a.ts', target: 'mod:orders/b.ts', weight: 1, count: 1, implicit: false },
            { source: 'mod:orders/b.ts', target: 'dir:db', weight: 2, count: 1, implicit: false },
            { source: 'mod:orders/a.ts', target: 'dir:queue', weight: 1, count: 1, implicit: false },
        );
        const m = buildMapModel({ ...VIEW, scope: 'sys:root', nodes, edges, ports: [], frontierHash: 'dense' });
        const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
        const layout = fromElkGraph(await new ELK().layout(toElkGraph(m)));

        // Absolute boxes (boxes are relative to their container).
        const parent = new Map(m.nodes.map((n) => [n.id, n.parent]));
        const abs = (id: string): { x: number; y: number; width: number; height: number } => {
            const b = layout.boxes.get(id)!;
            const p = parent.get(id);
            if (!p) return b;
            const pb = abs(p);
            return { ...b, x: b.x + pb.x, y: b.y + pb.y };
        };
        const inside = (x: number, y: number, b: { x: number; y: number; width: number; height: number }) => x > b.x + 1 && x < b.x + b.width - 1 && y > b.y + 1 && y < b.y + b.height - 1;
        assert.strictEqual(layout.routes.size, m.edges.length, 'a route for every edge');
        for (const e of m.edges) {
            const r = layout.routes.get(e.id)!;
            for (let i = 1; i < r.points.length; i++) {
                const [a, b] = [r.points[i - 1]!, r.points[i]!];
                assert.ok(Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5, `${e.id}: orthogonal segments only (to the pixel) ${JSON.stringify(r.points)}`);
                // Sample the segment: no point of it may be inside a card that isn't one of the edge's ends
                // (or a container holding one of them).
                for (let k = 0; k <= 20; k++) {
                    const x = a.x + ((b.x - a.x) * k) / 20;
                    const y = a.y + ((b.y - a.y) * k) / 20;
                    for (const n of m.nodes) {
                        if (n.id === e.source || n.id === e.target || n.type === 'container') continue;
                        assert.ok(!inside(x, y, abs(n.id)), `${e.id} passes through ${n.id}`);
                    }
                }
            }
        }
    });

    test('dense views draw their heaviest edges, plus everything around the selection', () => {
        const m: MapModel = {
            nodes: [],
            edges: Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, source: `a${i}`, target: `b${i}`, weight: i + 1, count: 1, implicit: false, port: false, strokeWidth: 1 })),
        };
        assert.deepStrictEqual(visibleEdges(m, { limit: 3 }).map((e) => e.id), ['e7', 'e8', 'e9']);
        assert.deepStrictEqual(visibleEdges(m, { limit: 3, around: new Set(['b0']) }).map((e) => e.id), ['e0', 'e7', 'e8', 'e9']);
        assert.strictEqual(visibleEdges(m, { limit: 3, all: true }).length, 10);
        assert.strictEqual(visibleEdges(m, { limit: 20 }).length, 10);
    });

    const edge = (source: string, target: string, weight = 1, cyclic = false) => ({ id: `${source}->${target}`, source, target, weight, count: 1, implicit: false, port: false, strokeWidth: 1, ...(cyclic ? { cyclic } : {}) });
    const reachable = (edges: Array<{ source: string; target: string }>, from: string) => {
        const seen = new Set<string>();
        const stack = [from];
        while (stack.length) for (const e of edges.filter((x) => x.source === stack.pop())) if (!seen.has(e.target)) (seen.add(e.target), stack.push(e.target));
        return seen;
    };

    test('implied lines are left out: A → B → C needs no A → C, and what depends on what is unchanged', () => {
        const edges = [edge('app', 'feature'), edge('feature', 'core'), edge('app', 'core', 9), edge('app', 'util'), edge('util', 'core'), edge('tests', 'app'), edge('tests', 'core')];
        const kept = reduceEdges(edges).map((e) => e.id);
        assert.deepStrictEqual(kept.sort(), ['app->feature', 'app->util', 'feature->core', 'tests->app', 'util->core']);
        for (const n of ['app', 'feature', 'util', 'tests']) assert.deepStrictEqual([...reachable(reduceEdges(edges), n)].sort(), [...reachable(edges, n)].sort(), `${n} still reaches the same parts`);
        // Default drawing: the reduction; the selection still draws all of its own lines; "all" draws everything.
        const m: MapModel = { nodes: [], edges };
        assert.strictEqual(visibleEdges(m).length, 5);
        assert.ok(visibleEdges(m, { around: new Set(['app']) }).some((e) => e.id === 'app->core'));
        assert.strictEqual(visibleEdges(m, { all: true }).length, 7);
    });

    test('a cycle stays a cycle (only its shortcuts go), and of two edges that imply each other only one goes', () => {
        const cyc = [edge('a', 'b', 1, true), edge('b', 'c', 1, true), edge('c', 'a', 1, true), edge('a', 'c', 1, true)];
        const keptCycle = reduceEdges(cyc);
        assert.deepStrictEqual(keptCycle.map((e) => e.id).sort(), ['a->b', 'b->c', 'c->a']);
        for (const n of ['a', 'b', 'c']) assert.deepStrictEqual([...reachable(keptCycle, n)].sort(), [...reachable(cyc, n)].sort());
        const scc = [edge('a', 'b'), edge('b', 'a'), edge('a', 'c'), edge('b', 'c')];
        const kept = reduceEdges(scc);
        for (const n of ['a', 'b']) assert.deepStrictEqual([...reachable(kept, n)].sort(), [...reachable(scc, n)].sort());
        assert.strictEqual(kept.length, 3, 'one of a → c and b → c goes, not both');
    });

});

describe('Lenses', () => {
    const m = (over: Partial<typeof METRICS>) => ({ ...METRICS, ...over });
    test('tests: a % on containers in 5 ordinal steps; tested / untested on files', () => {
        assert.deepStrictEqual(lensBadge(m({ codeModules: 10, testedModules: 6, testModules: 4 }), 'tests', 'component'), {
            level: 4,
            text: '60% tested',
            title: '6 of 10 code files have a test file depending on them (4 test files)',
        });
        assert.strictEqual(lensBadge(m({ codeModules: 10, testedModules: 0 }), 'tests', 'component')!.level, 1);
        assert.strictEqual(lensBadge(m({ codeModules: 10, testedModules: 10 }), 'tests', 'component')!.level, 5);
        assert.strictEqual(lensBadge(m({ codeModules: 1, testedModules: 1 }), 'tests', 'module')!.text, 'tested');
        assert.strictEqual(lensBadge(m({ codeModules: 0, testModules: 2 }), 'tests', 'component')!.text, 'tests only');
    });
    test('ownership: the main owner and share, how many others, and a warning when one person holds most of a part', () => {
        assert.deepStrictEqual(lensBadge(m({}), 'ownership', 'component', undefined, { name: 'Ada', share: 92, people: 3, busFactor: 1 }), {
            level: 'warning',
            text: '⚠ Ada 92% · +2',
            title: 'Ada last changed 92% of the lines here; 2 other people the rest. One person holds more than half.',
        });
        const shared = lensBadge(m({}), 'ownership', 'component', undefined, { name: 'Bob', share: 40, people: 4, busFactor: 2 })!;
        assert.deepStrictEqual([shared.level, shared.text], [undefined, 'Bob 40% · +3']);
        // One file with one author is normal: no warning on files.
        assert.strictEqual(lensBadge(m({}), 'ownership', 'module', undefined, { name: 'Cy', share: 100, people: 1, busFactor: 1 })!.level, undefined);
        assert.strictEqual(lensBadge(m({}), 'ownership', 'component'), undefined); // no ownership: no badge
    });
    test('health: the worst issue sets the status, every count is in the text', () => {
        assert.deepStrictEqual(lensBadge(m({ cyclicModules: 2, orphanModules: 1 }), 'health', 'component'), { level: 'critical', text: '⟳ 2 in cycles · ○ 1 orphan', title: '⟳ 2 in cycles, ○ 1 orphan (of 3 files)' });
        assert.strictEqual(lensBadge(m({ hubModules: 1 }), 'health', 'component')!.level, 'serious');
        assert.deepStrictEqual(lensBadge(m({}), 'health', 'component'), { text: 'no issues', title: 'No files in cycles, no hubs, no orphans' });
        assert.strictEqual(lensBadge(m({}), 'dependencies', 'component'), undefined);
    });

    test('authorship: AI share as text and an ordinal step, with the stacked bar', () => {
        const badge = lensBadge(m({}), 'authorship', 'component', { ai: 30, reviewed: 10, human: 0, unknown: 60 })!;
        assert.deepStrictEqual(badge, {
            level: 3,
            text: '30% AI · 10% reviewed',
            title: '30 AI, 10 reviewed, 0 human, 60 unknown (of 100 lines)',
            shares: { ai: 30, reviewed: 10, human: 0, unknown: 60 },
        });
        assert.strictEqual(lensBadge(m({}), 'authorship', 'module', { ai: 1, reviewed: 0, human: 0, unknown: 99 })!.level, 1);
        assert.strictEqual(lensBadge(m({}), 'authorship', 'module', { ai: 80, reviewed: 0, human: 0, unknown: 20 })!.level, 5);
        const none = lensBadge(m({}), 'authorship', 'component', { ai: 0, reviewed: 0, human: 0, unknown: 50 })!;
        assert.strictEqual(none.text, 'no AI lines found');
        assert.strictEqual(none.level, undefined);
        assert.strictEqual(lensBadge(m({}), 'authorship', 'component'), undefined); // no git history: nothing to show
        assert.strictEqual(lensBadge(m({}), 'authorship', 'component', { ai: 0, reviewed: 0, human: 0, unknown: 0 }), undefined);
    });

    test('authorship shares are whole percents that add up to 100', () => {
        const s = authorshipShares({ ai: 1, reviewed: 1, human: 1, unknown: 0 });
        assert.strictEqual(s.ai + s.reviewed + s.human + s.unknown, 100);
        assert.deepStrictEqual(authorshipShares({ ai: 0, reviewed: 0, human: 0, unknown: 0 }), { ai: 0, reviewed: 0, human: 0, unknown: 0 });
        assert.deepStrictEqual(authorshipShares({ ai: 2, reviewed: 0, human: 0, unknown: 998 }), { ai: 0, reviewed: 0, human: 0, unknown: 100 });
        assert.strictEqual(lensBadge(m({}), 'authorship', 'component', { ai: 2, reviewed: 0, human: 0, unknown: 998 })!.text, '<1% AI'); // never "0%" when there are some
        assert.strictEqual(agentName('claude-code'), 'Claude Code');
        assert.strictEqual(agentName('acme-bot'), 'acme-bot');
    });
});

describe('Matrix', () => {
    test('providers first; a cycle stays together; only feedback lands above the diagonal', () => {
        const v: View = {
            ...VIEW,
            nodes: [node('a', { name: 'a' }), node('b', { name: 'b', cycle: 1 }), node('c', { name: 'c', cycle: 1 }), node('d', { name: 'd' })],
            edges: [
                { source: 'a', target: 'b', weight: 1, count: 1, implicit: false },
                { source: 'b', target: 'c', weight: 1, count: 1, implicit: false, cyclic: true },
                { source: 'c', target: 'b', weight: 1, count: 1, implicit: false, cyclic: true },
                { source: 'c', target: 'd', weight: 1, count: 1, implicit: false },
            ],
            ports: [],
        };
        const o = matrixOrder(v);
        assert.deepStrictEqual(o.keys, ['d', 'b', 'c', 'a']);
        const pos = new Map(o.keys.map((k, i) => [k, i]));
        const above = v.edges.filter((e) => pos.get(e.target)! > pos.get(e.source)!).map((e) => `${e.source}->${e.target}`);
        assert.deepStrictEqual(above, ['b->c']);
        assert.deepStrictEqual([...o.cycleOf.keys()].sort(), ['b', 'c']);
    });
    test('heat steps grow with weight on a log scale', () => {
        assert.strictEqual(heatStep(0, 10), 0);
        assert.strictEqual(heatStep(1, 1), 7);
        assert.ok(heatStep(2, 100) < heatStep(50, 100));
        assert.strictEqual(heatStep(100, 100), 7);
    });
});

describe('Selection flow and reveal', () => {
    test('a selection classifies its edges as uses / used by / internal and lights its neighbours', () => {
        const m = buildMapModel(VIEW);
        const r = flowRoles(m, 'mod:core/orders/new.ts');
        assert.deepStrictEqual([...r.out].sort(), ['mod:core/orders/new.ts->dir:core/auth', 'mod:core/orders/new.ts->ext:dir:db']);
        assert.deepStrictEqual([...r.in], []);
        assert.ok(r.lit.has('dir:core/auth') && r.lit.has('ext:dir:db'));
        assert.ok(!r.lit.has('ext:dir:api'), 'unrelated nodes fade');
    });

    test('selecting an expanded node traces everything drawn inside it', () => {
        const m = buildMapModel(VIEW);
        const r = flowRoles(m, 'dir:core/orders');
        assert.ok(r.selected.has('mod:core/orders/new.ts') && r.selected.has('mod:core/orders/list.ts'));
        assert.deepStrictEqual([...r.out].sort(), ['mod:core/orders/list.ts->ext:dir:db', 'mod:core/orders/new.ts->dir:core/auth', 'mod:core/orders/new.ts->ext:dir:db']);
    });

    test('reveal expands ancestors on the current canvas instead of opening a new view', () => {
        const path = ['sys:root', 'pkg:.', 'dir:web/src', 'mod:web/src/index.ts'];
        assert.deepStrictEqual(revealPlan(path, 'sys:root', ['pkg:rust']), { scope: 'sys:root', expanded: ['pkg:rust', 'pkg:.', 'dir:web/src'] });
        assert.deepStrictEqual(revealPlan(path, 'pkg:.', []), { scope: 'pkg:.', expanded: ['dir:web/src'] });
        // Outside the current scope: back to the system, with the path expanded.
        assert.deepStrictEqual(revealPlan(path, 'dir:cs', ['dir:cs/x']), { scope: 'sys:root', expanded: ['pkg:.', 'dir:web/src'] });
        // A top-level node needs nothing expanded.
        assert.deepStrictEqual(revealPlan(['sys:root', 'pkg:rust'], 'sys:root', []), { scope: 'sys:root', expanded: [] });
    });
});
