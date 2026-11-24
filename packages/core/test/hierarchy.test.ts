import { describe, test } from 'vitest';
import * as assert from 'node:assert';
import { EdgeType, NodeType, SymbolKind, type ArchitectureGraph, type Hierarchy, type SymbolInfo } from '@codearchy/protocol';
import { buildHierarchy, detectCommunities, roleOfModule } from '../src/index.js';

/** A graph of files (with optional symbols) and `a -> b` import edges. */
function graph(files: string[], edges: Array<[string, string]> = [], symbols: Record<string, SymbolInfo[]> = {}): ArchitectureGraph {
    return {
        nodes: files.map((id) => ({ id, label: id, filePath: id, type: NodeType.File, symbols: symbols[id] ?? [], metadata: { language: 'typescript' } })),
        edges: edges.map(([source, target]) => ({
            id: `${source}:${target}`,
            source,
            target,
            type: EdgeType.Import,
            weight: 1,
            metadata: { evidence: [{ source: `./${target}`, line: 0 }] },
        })),
        subsystems: [],
        metadata: { analyzedAt: 0, fileCount: files.length, totalSymbols: 0, totalEdges: edges.length, languages: [] },
    };
}

/** `key (kind)` lines indented by depth, symbols left out. */
function outline(h: Hierarchy): string[] {
    return h.nodes.filter((n) => n.kind !== 'symbol').map((n) => `${'  '.repeat(n.depth)}${n.key}`);
}

const children = (h: Hierarchy, key: string) => {
    const parent = h.nodes.find((n) => n.key === key)!;
    return h.nodes.filter((n) => n.parent === parent.tin).map((n) => n.key);
};

function assertEulerInvariants(h: Hierarchy): void {
    h.nodes.forEach((n, i) => {
        assert.strictEqual(n.tin, i, 'pre-order: tin is the index');
        assert.ok(n.tout >= n.tin);
        if (i === 0) assert.strictEqual(n.parent, -1);
        else {
            const p = h.nodes[n.parent];
            assert.ok(p.tin < n.tin && n.tout <= p.tout, `${n.key} lies inside ${p.key}`);
            assert.strictEqual(n.depth, p.depth + 1);
        }
        const modulesInside = h.nodes.slice(n.tin, n.tout + 1).filter((m) => m.kind === 'module').length;
        assert.strictEqual(n.modules, modulesInside, `${n.key} module count`);
    });
    assert.strictEqual(new Set(h.nodes.map((n) => n.key)).size, h.nodes.length, 'keys are unique');
}

describe('Hierarchy', () => {
    test('compresses single-child folder chains and folds one-file folders', () => {
        const h = buildHierarchy(
            graph([
                'src/main/java/com/acme/orders/A.java',
                'src/main/java/com/acme/orders/B.java',
                'src/main/java/com/acme/util/C.java',
                'src/main/java/com/acme/util/D.java',
                'src/main/java/com/acme/single/E.java',
                'README.ts',
            ]),
            { systemName: 'acme' }
        );
        assertEulerInvariants(h);
        assert.deepStrictEqual(outline(h), [
            'sys:root',
            '  dir:src/main/java/com/acme',
            '    dir:src/main/java/com/acme/orders',
            '      mod:src/main/java/com/acme/orders/A.java',
            '      mod:src/main/java/com/acme/orders/B.java',
            '    dir:src/main/java/com/acme/util',
            '      mod:src/main/java/com/acme/util/C.java',
            '      mod:src/main/java/com/acme/util/D.java',
            '    mod:src/main/java/com/acme/single/E.java',
            '  mod:README.ts',
        ]);
        assert.strictEqual(h.nodes[1].name, 'src/main/java/com/acme');
    });

    test('packages come from markers and manifest names; files outside any package join the root package', () => {
        const manifests = new Map([
            ['apps/web/package.json', '{"name": "@acme/web"}'],
            ['services/api/go.mod', 'module example.com/acme/api\n\ngo 1.22\n'],
            ['crates/core/Cargo.toml', '[workspace]\nname = "nope"\n[package]\nname = "acme-core"\n'],
        ]);
        const h = buildHierarchy(
            graph(['apps/web/src/a.ts', 'apps/web/src/b.ts', 'services/api/main.go', 'crates/core/src/lib.rs', 'tools/x.ts']),
            { systemName: 'acme', packageMarkers: [...manifests.keys()], manifests }
        );
        assertEulerInvariants(h);
        // Siblings sort by display name: @acme/web, acme (the root), acme-core, api.
        assert.deepStrictEqual(children(h, 'sys:root'), ['pkg:apps/web', 'pkg:.', 'pkg:crates/core', 'pkg:services/api']);
        const names = Object.fromEntries(h.nodes.filter((n) => n.kind === 'package').map((n) => [n.key, n.name]));
        assert.deepStrictEqual(names, { 'pkg:apps/web': '@acme/web', 'pkg:crates/core': 'acme-core', 'pkg:services/api': 'api', 'pkg:.': 'acme' });
    });

    test('a workspace that is one root package has no package level', () => {
        const h = buildHierarchy(graph(['src/a.ts', 'src/b.ts']), { systemName: 'one', packageMarkers: ['package.json'] });
        assert.deepStrictEqual(children(h, 'sys:root'), ['dir:src']);
    });

    test('many packages are grouped by their parent folder', () => {
        const files = ['packages/a/x.ts', 'packages/b/x.ts', 'packages/c/x.ts', 'examples/d/x.ts', 'examples/e/x.ts', 'solo/f/x.ts'];
        const markers = ['packages/a', 'packages/b', 'packages/c', 'examples/d', 'examples/e', 'solo/f'].map((d) => `${d}/package.json`);
        const h = buildHierarchy(graph(files), { systemName: 'mono', packageMarkers: markers, maxChildren: 4 });
        assertEulerInvariants(h);
        assert.deepStrictEqual(children(h, 'sys:root'), ['grp:examples', 'pkg:solo/f', 'grp:packages']);
        assert.deepStrictEqual(children(h, 'grp:packages'), ['pkg:packages/a', 'pkg:packages/b', 'pkg:packages/c']);
    });

    test('a group inside another group\'s folder nests in it, as does a lone package', () => {
        // sample/31-federation holds three packages of its own; sample/x/y/z is a lone package deeper down.
        const dirs = ['packages/a', 'packages/b', 'sample/01-cats', 'sample/02-dogs', 'sample/31-federation/gateway', 'sample/31-federation/users', 'sample/31-federation/posts', 'sample/x/y/z'];
        const h = buildHierarchy(graph(dirs.map((d) => `${d}/x.ts`)), { systemName: 'mono', packageMarkers: dirs.map((d) => `${d}/package.json`), maxChildren: 4 });
        assertEulerInvariants(h);
        assert.deepStrictEqual(children(h, 'sys:root'), ['grp:packages', 'grp:sample']);
        assert.deepStrictEqual(children(h, 'grp:sample'), ['pkg:sample/01-cats', 'pkg:sample/02-dogs', 'grp:sample/31-federation', 'pkg:sample/x/y/z']);
        assert.deepStrictEqual(children(h, 'grp:sample/31-federation'), ['pkg:sample/31-federation/gateway', 'pkg:sample/31-federation/posts', 'pkg:sample/31-federation/users']);
    });

    test('a wide folder is split by its dependency communities into virtual components', () => {
        const files: string[] = [];
        const edges: Array<[string, string]> = [];
        for (const group of ['auth', 'billing', 'search']) {
            const members = Array.from({ length: 8 }, (_, i) => `src/${group}${i}.ts`);
            files.push(...members);
            for (const a of members) for (const b of members) if (a < b) edges.push([a, b]);
        }
        edges.push(['src/auth0.ts', 'src/billing0.ts']); // one weak link between groups
        const h = buildHierarchy(graph(files, edges), { systemName: 's' });
        assertEulerInvariants(h);
        const groups = h.nodes.filter((n) => n.virtual);
        assert.strictEqual(groups.length, 3);
        for (const g of groups) {
            const members = children(h, g.key).map((k) => k.replace(/^mod:src\/|\d\.ts$/g, ''));
            assert.strictEqual(new Set(members).size, 1, `${g.name} holds one community: ${members.join(',')}`);
            assert.ok(g.key.startsWith('cl:dir:src:'));
            assert.strictEqual(g.modules, 8);
        }
    });

    test('named folders stay visible: loose files are grouped first', () => {
        const folders = Array.from({ length: 6 }, (_, i) => [`pkg/dir${i}/a.ts`, `pkg/dir${i}/b.ts`]).flat();
        const loose = Array.from({ length: 20 }, (_, i) => `pkg/file${String(i).padStart(2, '0')}.ts`);
        const h = buildHierarchy(graph([...folders, ...loose]), { systemName: 's' });
        assertEulerInvariants(h);
        const top = children(h, 'dir:pkg');
        assert.ok(top.length <= 20, `fan-out ${top.length}`);
        for (let i = 0; i < 6; i++) assert.ok(top.includes(`dir:pkg/dir${i}`), `dir${i} is still a child`);
        assert.ok(top.filter((k) => k.startsWith('cl:')).length >= 1, 'the loose files were grouped');
    });

    test('a wide folder with no dependencies is grouped alphabetically', () => {
        const files = Array.from({ length: 30 }, (_, i) => `lib/f${String(i).padStart(2, '0')}.ts`).concat('lib/x.ts');
        const h = buildHierarchy(graph(files), { systemName: 's' });
        assertEulerInvariants(h);
        const lib = children(h, 'dir:lib');
        assert.ok(lib.length <= 20, `fan-out ${lib.length}`);
        assert.ok(h.nodes.filter((n) => n.virtual).every((n) => n.name.includes(' … ')));
    });

    test('the result is identical whatever order files and edges arrive in', () => {
        const files = Array.from({ length: 40 }, (_, i) => `src/${['a', 'b', 'c', 'd'][i % 4]}/m${i}.ts`);
        const edges: Array<[string, string]> = files.slice(1).map((f, i) => [f, files[(i * 7) % files.length]] as [string, string]).filter(([a, b]) => a !== b);
        const one = buildHierarchy(graph(files, edges), { systemName: 's', maxChildren: 5 });
        const two = buildHierarchy(graph([...files].reverse(), [...edges].reverse()), { systemName: 's', maxChildren: 5 });
        assert.deepStrictEqual(JSON.stringify(two), JSON.stringify(one));
        assertEulerInvariants(one);
    });

    test('symbols nest under their containers, with stable keys', () => {
        const sym = (name: string, kind: SymbolKind, startLine: number, endLine: number, container?: string): SymbolInfo => ({ name, kind, filePath: 'svc.ts', startLine, endLine, exported: true, ...(container ? { container } : {}) });
        const h = buildHierarchy(
            graph(['svc.ts'], [], { 'svc.ts': [sym('run', SymbolKind.Method, 3, 4, 'Service'), sym('Service', SymbolKind.Class, 1, 10), sym('helper', SymbolKind.Function, 12, 13), sym('lost', SymbolKind.Method, 15, 16, 'Elsewhere')] }),
            { systemName: 's' }
        );
        assertEulerInvariants(h);
        assert.deepStrictEqual(
            h.nodes.filter((n) => n.kind === 'symbol').map((n) => `${'  '.repeat(n.depth - 2)}${n.key}`),
            ['sym:svc.ts#Service', '  sym:svc.ts#Service.run', 'sym:svc.ts#helper', 'sym:svc.ts#Elsewhere.lost']
        );
    });

    test('edges connect modules and keep their evidence', () => {
        const h = buildHierarchy(graph(['a/x.ts', 'a/y.ts', 'b/z.ts', 'b/w.ts'], [['a/x.ts', 'b/z.ts']]), { systemName: 's' });
        assert.strictEqual(h.edges.length, 1);
        const e = h.edges[0];
        assert.strictEqual(h.nodes[e.src].key, 'mod:a/x.ts');
        assert.strictEqual(h.nodes[e.dst].key, 'mod:b/z.ts');
        assert.deepStrictEqual(e.evidence, [{ source: './b/z.ts', line: 0 }]);
    });

    test('roles come from whole path words, with a reason; inherited roles are not echoed', () => {
        assert.deepStrictEqual(roleOfModule('src/controllers/user.ts'), { role: 'api', confidence: 0.6, reason: 'folder "controllers"' });
        assert.deepStrictEqual(roleOfModule('src/UserRepository.ts')?.role, 'data');
        assert.strictEqual(roleOfModule('src/rebuild/x.ts'), undefined, 'no substring matches ("build" in "rebuild")');
        assert.strictEqual(roleOfModule('src/__tests__/a.ts')?.role, 'test');

        const h = buildHierarchy(graph(['core/cache/a.ts', 'core/cache/b.ts', 'core/x/c.ts', 'core/x/d.ts']), { systemName: 's' });
        const role = (key: string) => h.nodes.find((n) => n.key === key)!.role;
        assert.strictEqual(role('dir:core')?.role, 'domain');
        assert.strictEqual(role('dir:core/cache'), undefined, 'files inheriting "core" do not make cache a domain component');
    });
});

describe('Community detection', () => {
    test('two cliques joined by one edge make two communities', () => {
        const edges: Array<[number, number, number]> = [];
        for (const base of [0, 5]) for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) edges.push([base + i, base + j, 1]);
        edges.push([0, 5, 1]);
        assert.deepStrictEqual(detectCommunities(10, edges), [0, 0, 0, 0, 0, 1, 1, 1, 1, 1]);
    });

    test('no edges: every node alone; communities are always connected', () => {
        assert.deepStrictEqual(detectCommunities(3, []), [0, 1, 2]);
        const c = detectCommunities(4, [[0, 1, 5], [2, 3, 5]]);
        assert.strictEqual(c[0], c[1]);
        assert.strictEqual(c[2], c[3]);
        assert.notStrictEqual(c[0], c[2]);
    });
});
