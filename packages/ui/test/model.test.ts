import { describe, test } from 'vitest';
import * as assert from 'node:assert';
import type { View, ViewNode } from '@codearchy/protocol';
import { buildMapModel, neighbourhood, strokeWidthFor, toElkGraph, fromElkGraph, visibleEdges, type MapModel } from '../src/index.js';

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
        assert.deepStrictEqual(layout.get('dir:core/orders'), { x: 10, y: 20, width: 300, height: 200 });
        assert.strictEqual(layout.get('mod:core/orders/new.ts')!.x, 5, 'child positions stay relative to the container');
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
});
