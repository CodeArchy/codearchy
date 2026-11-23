/**
 * Projects the hierarchy onto views (doc: frontier projection).
 *
 * A view's frontier is the children of its scope, with some of them expanded
 * in place. Each base edge (module → module) maps to the frontier nodes that
 * contain its ends: thanks to Euler-tour intervals that is a binary search
 * over the frontier's sorted `tin`s, so a projection costs
 * O(E_scope · log |frontier|), with E_scope found by range scans over edges
 * sorted by source and by target. Edges leaving the scope become port stubs,
 * attributed to the outside node at the level of the scope's (or an
 * ancestor's) siblings.
 */
import type { EdgeExplanation, Hierarchy, HierarchyEdge, HierarchyNode, NodeDetails, NodeLink, NodeSummary, PortStub, View, ViewEdge, ViewNode, ViewRequest } from '@codearchy/protocol';
import { contentHash } from '../util/hash.js';

export const DEFAULT_VIEW_BUDGET = 300;

export class HierarchyIndex {
    private readonly byKey = new Map<string, number>();
    private readonly kids: number[][];
    private readonly bySrc: HierarchyEdge[];
    private readonly byDst: HierarchyEdge[];

    constructor(readonly hierarchy: Hierarchy) {
        const { nodes, edges } = hierarchy;
        this.kids = nodes.map(() => []);
        nodes.forEach((n, i) => {
            this.byKey.set(n.key, i);
            if (n.parent >= 0 && n.kind !== 'symbol') this.kids[n.parent].push(i);
        });
        this.bySrc = [...edges].sort((a, b) => a.src - b.src || a.dst - b.dst);
        this.byDst = [...edges].sort((a, b) => a.dst - b.dst || a.src - b.src);
    }

    node(key: string): HierarchyNode | undefined {
        const i = this.byKey.get(key);
        return i === undefined ? undefined : this.hierarchy.nodes[i];
    }

    indexOf(key: string): number | undefined {
        return this.byKey.get(key);
    }

    /** Child indexes, symbols excluded (they live in the Inspector, not on the Map). */
    childrenOf(index: number): number[] {
        return this.kids[index];
    }

    /** Root … index, inclusive. */
    ancestors(index: number): number[] {
        const out: number[] = [];
        for (let i = index; i >= 0; i = this.hierarchy.nodes[i].parent) out.push(i);
        return out.reverse();
    }

    /** `outer` is `inner` or one of its ancestors. */
    contains(outer: number, inner: number): boolean {
        const o = this.hierarchy.nodes[outer];
        return o.tin <= inner && inner <= o.tout;
    }

    /** Can be drilled into or expanded on the Map. */
    hasChildren(index: number): boolean {
        const n = this.hierarchy.nodes[index];
        return n.kind !== 'module' && n.kind !== 'symbol' && this.kids[index].length > 0;
    }

    project(request: ViewRequest = {}): View {
        const { nodes } = this.hierarchy;
        let scope = this.byKey.get(request.scope ?? 'sys:root') ?? 0;
        while (scope > 0 && !this.hasChildren(scope)) scope = nodes[scope].parent; // modules: show their parent
        const budget = request.budget ?? DEFAULT_VIEW_BUDGET;

        // ── frontier ────────────────────────────────────────────────────────
        const leaves = new Set(this.kids[scope]);
        const containers: number[] = [];
        const skipped: string[] = [];
        const wanted = [...new Set(request.expanded ?? [])]
            .map((k) => this.byKey.get(k))
            .filter((i): i is number => i !== undefined && i !== scope && this.contains(scope, i) && this.hasChildren(i))
            .sort((a, b) => nodes[a].depth - nodes[b].depth || a - b);
        for (const e of wanted) {
            if (!leaves.has(e)) continue; // an ancestor isn't expanded: not visible, nothing to do
            const children = this.kids[e];
            if (leaves.size - 1 + children.length > budget) {
                skipped.push(nodes[e].key);
                continue;
            }
            leaves.delete(e);
            for (const c of children) leaves.add(c);
            containers.push(e);
        }
        const frontier = [...leaves].sort((a, b) => a - b);
        const containerSet = new Set(containers);

        /** The frontier node containing `x`, if `x` is inside the scope. */
        const f = (x: number): number | undefined => {
            let lo = 0;
            let hi = frontier.length - 1;
            let found = -1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (frontier[mid] <= x) {
                    found = mid;
                    lo = mid + 1;
                } else {
                    hi = mid - 1;
                }
            }
            if (found < 0) return undefined;
            const candidate = frontier[found];
            return x <= nodes[candidate].tout ? candidate : undefined;
        };

        /** Outside node representing `x`: its ancestor whose parent contains the scope. */
        const externalCache = new Map<number, number>();
        const external = (x: number): number => {
            let r = externalCache.get(x);
            if (r === undefined) {
                r = x;
                while (nodes[r].parent >= 0 && !this.contains(nodes[r].parent, scope)) r = nodes[r].parent;
                externalCache.set(x, r);
            }
            return r;
        };

        // ── edges and ports ─────────────────────────────────────────────────
        const s = nodes[scope];
        const viewEdges = new Map<string, ViewEdge & { explicit: boolean }>();
        const ports = new Map<string, PortStub>();
        const addPort = (node: number, ext: number, direction: 'out' | 'in', e: HierarchyEdge) => {
            const key = `${node}|${ext}|${direction}`;
            const p = ports.get(key);
            if (p) {
                p.weight += e.weight;
                p.count++;
            } else {
                ports.set(key, { node: nodes[node].key, external: nodes[ext].key, externalName: nodes[ext].name, direction, weight: e.weight, count: 1 });
            }
        };
        for (const e of range(this.bySrc, (x) => x.src, s.tin, s.tout)) {
            const u = f(e.src);
            if (u === undefined) continue;
            if (this.contains(scope, e.dst)) {
                const v = f(e.dst);
                if (v === undefined || v === u) continue;
                const key = `${u}|${v}`;
                const ve = viewEdges.get(key);
                if (ve) {
                    ve.weight += e.weight;
                    ve.count++;
                    if (!e.implicit) ve.explicit = true;
                } else {
                    viewEdges.set(key, { source: nodes[u].key, target: nodes[v].key, weight: e.weight, count: 1, implicit: false, explicit: !e.implicit });
                }
            } else {
                addPort(u, external(e.dst), 'out', e);
            }
        }
        for (const e of range(this.byDst, (x) => x.dst, s.tin, s.tout)) {
            if (this.contains(scope, e.src)) continue; // internal: counted above
            const v = f(e.dst);
            if (v !== undefined) addPort(v, external(e.src), 'in', e);
        }

        const edges: ViewEdge[] = [...viewEdges.values()].map(({ explicit, ...ve }) => ({ ...ve, implicit: !explicit }));
        const fanIn = new Map<string, number>();
        const fanOut = new Map<string, number>();
        for (const e of edges) {
            fanOut.set(e.source, (fanOut.get(e.source) ?? 0) + 1);
            fanIn.set(e.target, (fanIn.get(e.target) ?? 0) + 1);
        }

        // ── nodes ───────────────────────────────────────────────────────────
        const groupOf = (i: number): string | undefined => {
            for (let p = nodes[i].parent; p >= 0 && p !== scope; p = nodes[p].parent) if (containerSet.has(p)) return nodes[p].key;
            return undefined;
        };
        const viewNode = (i: number, isContainer: boolean): ViewNode => {
            const n = nodes[i];
            const group = groupOf(i);
            return {
                key: n.key,
                kind: n.kind,
                name: n.name,
                path: n.path,
                ...(group ? { group } : {}),
                expanded: isContainer,
                hasChildren: this.hasChildren(i),
                modules: n.modules,
                ...(n.role ? { role: n.role.role, roleConfidence: n.role.confidence } : {}),
                ...(n.virtual ? { virtual: true } : {}),
                fanIn: fanIn.get(n.key) ?? 0,
                fanOut: fanOut.get(n.key) ?? 0,
            };
        };
        const viewNodes = [...containers.map((i) => viewNode(i, true)), ...frontier.map((i) => viewNode(i, false))];

        return {
            scope: s.key,
            breadcrumb: this.ancestors(scope).map((i) => ({ key: nodes[i].key, name: nodes[i].name, kind: nodes[i].kind })),
            nodes: viewNodes,
            edges: edges.sort((a, b) => cmp(a.source, b.source) || cmp(a.target, b.target)),
            ports: [...ports.values()].sort((a, b) => cmp(a.node, b.node) || cmp(a.external, b.external) || cmp(a.direction, b.direction)),
            skipped,
            frontierHash: contentHash(`${s.key}\n${containers.map((i) => nodes[i].key).join('\n')}\n${frontier.map((i) => nodes[i].key).join('\n')}`),
        };
    }

    summary(index: number): NodeSummary {
        const n = this.hierarchy.nodes[index];
        return {
            key: n.key,
            kind: n.kind,
            name: n.name,
            path: n.path,
            modules: n.modules,
            hasChildren: this.hasChildren(index),
            ...(n.role ? { role: n.role.role, roleConfidence: n.role.confidence, roleReason: n.role.reason } : {}),
            ...(n.virtual ? { virtual: true } : {}),
            ...(n.language ? { language: n.language } : {}),
        };
    }

    /** Child summaries of a node (Navigator); undefined for an unknown key. */
    children(key: string): NodeSummary[] | undefined {
        const i = this.byKey.get(key);
        return i === undefined ? undefined : this.kids[i].map((c) => this.summary(c));
    }

    /**
     * Inspector data: the node, its breadcrumb and children, a module's
     * symbols, and what it depends on / is used by at its siblings' level
     * (dependencies leaving the parent appear through their port stubs).
     */
    describe(key: string): NodeDetails | undefined {
        const i = this.byKey.get(key);
        if (i === undefined) return undefined;
        const { nodes } = this.hierarchy;
        const n = nodes[i];
        const symbols: NodeDetails['symbols'] = [];
        if (n.kind === 'module') {
            for (let j = n.tin + 1; j <= n.tout; j++) {
                const s = nodes[j];
                symbols.push({ key: s.key, name: s.name, kind: s.symbolKind ?? 'symbol', exported: !!s.exported, startLine: s.startLine ?? 0, endLine: s.endLine ?? 0, depth: s.depth - n.depth - 1 });
            }
        }
        const dependsOn: NodeLink[] = [];
        const usedBy: NodeLink[] = [];
        if (n.parent >= 0 && n.kind !== 'symbol') {
            const view = this.project({ scope: nodes[n.parent].key, budget: Number.MAX_SAFE_INTEGER });
            const nameOf = (k: string) => this.node(k)?.name ?? k;
            for (const e of view.edges) {
                if (e.source === key) dependsOn.push({ key: e.target, name: nameOf(e.target), weight: e.weight });
                if (e.target === key) usedBy.push({ key: e.source, name: nameOf(e.source), weight: e.weight });
            }
            for (const p of view.ports) {
                if (p.node !== key) continue;
                (p.direction === 'out' ? dependsOn : usedBy).push({ key: p.external, name: p.externalName, weight: p.weight, outside: true });
            }
            dependsOn.sort((a, b) => b.weight - a.weight);
            usedBy.sort((a, b) => b.weight - a.weight);
        }
        return {
            ...this.summary(i),
            breadcrumb: this.ancestors(i).map((a) => ({ key: nodes[a].key, name: nodes[a].name, kind: nodes[a].kind })),
            children: this.kids[i].map((c) => this.summary(c)),
            symbols,
            dependsOn,
            usedBy,
        };
    }

    /** The module-level dependencies from `sourceKey`'s subtree to `targetKey`'s (heaviest first). */
    explainEdge(sourceKey: string, targetKey: string, limit = 100): EdgeExplanation | undefined {
        const a = this.byKey.get(sourceKey);
        const b = this.byKey.get(targetKey);
        if (a === undefined || b === undefined) return undefined;
        const { nodes } = this.hierarchy;
        const deps = range(this.bySrc, (x) => x.src, nodes[a].tin, nodes[a].tout).filter((e) => this.contains(b, e.dst));
        deps.sort((x, y) => y.weight - x.weight || x.src - y.src || x.dst - y.dst);
        return {
            source: sourceKey,
            target: targetKey,
            total: deps.length,
            dependencies: deps.slice(0, limit).map((e) => ({
                from: nodes[e.src].path,
                to: nodes[e.dst].path,
                weight: e.weight,
                implicit: !!e.implicit,
                evidence: e.evidence,
            })),
        };
    }
}

/**
 * Keys within `hops` of `key` along the view's edges ("focus" / blast
 * radius): `down` follows dependencies, `up` follows dependents.
 */
export function neighbourhood(view: View, key: string, hops: number, direction: 'up' | 'down' | 'both' = 'both'): Set<string> {
    const out = new Map<string, string[]>();
    const inc = new Map<string, string[]>();
    for (const e of view.edges) {
        if (!out.has(e.source)) out.set(e.source, []);
        if (!inc.has(e.target)) inc.set(e.target, []);
        out.get(e.source)!.push(e.target);
        inc.get(e.target)!.push(e.source);
    }
    const seen = new Set([key]);
    let layer = [key];
    for (let h = 0; h < hops && layer.length; h++) {
        const next: string[] = [];
        for (const k of layer) {
            const around = [...(direction !== 'up' ? out.get(k) ?? [] : []), ...(direction !== 'down' ? inc.get(k) ?? [] : [])];
            for (const n of around) {
                if (seen.has(n)) continue;
                seen.add(n);
                next.push(n);
            }
        }
        layer = next;
    }
    return seen;
}

/** Items of `sorted` whose `at(item)` lies in [lo, hi] (binary search for the start). */
function range<T>(sorted: T[], at: (x: T) => number, lo: number, hi: number): T[] {
    let a = 0;
    let b = sorted.length;
    while (a < b) {
        const mid = (a + b) >> 1;
        if (at(sorted[mid]) < lo) a = mid + 1;
        else b = mid;
    }
    const out: T[] = [];
    for (let i = a; i < sorted.length && at(sorted[i]) <= hi; i++) out.push(sorted[i]);
    return out;
}

function cmp(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}
