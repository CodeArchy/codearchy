/**
 * Per-node metrics behind the lenses (Health, Tests) and the Inspector.
 *
 * Module level, from the base edges:
 *   test      the module is a test (role `test`)
 *   cyclic    in a dependency cycle (strongly connected component of size > 1)
 *   orphan    no dependencies in either direction
 *   hub       highly connected: fan-in + fan-out >= HUB_DEGREE distinct modules
 *   tested    a non-test module that at least one test module depends on
 *
 * Every container sums its modules' flags, and records the weight of the
 * dependencies crossing its boundary (fanIn / fanOut). Computed once per
 * hierarchy in O(N + E · depth).
 */
import type { Hierarchy, NodeMetrics } from '@codearchy/protocol';

/** Distinct neighbour modules (in + out) from which a module counts as a hub. */
export const HUB_DEGREE = 30;

export interface ModuleFacts {
    test: boolean;
    cyclic: boolean;
    orphan: boolean;
    hub: boolean;
    tested: boolean;
    /** Strongly connected component id (shared by the modules of one cycle), or -1. */
    cycle: number;
}

export interface HierarchyMetrics {
    /** Per node (indexed like Hierarchy.nodes). */
    nodes: NodeMetrics[];
    /** Per module node index. */
    modules: Map<number, ModuleFacts>;
    /** Members of each cycle (module indexes), by cycle id. */
    cycles: number[][];
}

export function computeMetrics(h: Hierarchy): HierarchyMetrics {
    const { nodes, edges } = h;
    const out = new Map<number, Set<number>>();
    const inc = new Map<number, Set<number>>();
    for (const e of edges) {
        if (!out.has(e.src)) out.set(e.src, new Set());
        if (!inc.has(e.dst)) inc.set(e.dst, new Set());
        out.get(e.src)!.add(e.dst);
        inc.get(e.dst)!.add(e.src);
    }
    const moduleIndexes = nodes.filter((n) => n.kind === 'module').map((n) => n.tin);
    const isTest = (i: number) => nodes[i].role?.role === 'test';

    // Cycles: Tarjan's SCC, iterative (deep import chains must not overflow the stack).
    const sccOf = tarjan(moduleIndexes, (v) => out.get(v) ?? new Set());
    const sizes = new Map<number, number>();
    for (const c of sccOf.values()) sizes.set(c, (sizes.get(c) ?? 0) + 1);
    const cycleIds = new Map<number, number>();
    const cycles: number[][] = [];
    for (const m of moduleIndexes) {
        const c = sccOf.get(m)!;
        if (sizes.get(c)! < 2) continue;
        if (!cycleIds.has(c)) {
            cycleIds.set(c, cycles.length);
            cycles.push([]);
        }
        cycles[cycleIds.get(c)!].push(m);
    }

    const modules = new Map<number, ModuleFacts>();
    for (const m of moduleIndexes) {
        const o = out.get(m)?.size ?? 0;
        const i = inc.get(m)?.size ?? 0;
        const test = isTest(m);
        const cycle = sizes.get(sccOf.get(m)!)! > 1 ? cycleIds.get(sccOf.get(m)!)! : -1;
        modules.set(m, {
            test,
            cyclic: cycle >= 0,
            orphan: o === 0 && i === 0,
            hub: o + i >= HUB_DEGREE,
            tested: !test && [...(inc.get(m) ?? [])].some(isTest),
            cycle,
        });
    }

    const metrics: NodeMetrics[] = nodes.map(() => ({
        modules: 0,
        symbols: 0,
        codeModules: 0,
        testModules: 0,
        testedModules: 0,
        cyclicModules: 0,
        orphanModules: 0,
        hubModules: 0,
        fanIn: 0,
        fanOut: 0,
    }));
    // Pre-order storage: children come after parents, so a reverse sweep sums bottom-up.
    for (let i = nodes.length - 1; i >= 0; i--) {
        const m = metrics[i];
        const n = nodes[i];
        if (n.kind === 'symbol') m.symbols += 1;
        const f = modules.get(i);
        if (f) {
            m.modules += 1;
            if (f.test) m.testModules += 1;
            else m.codeModules += 1;
            if (f.tested) m.testedModules += 1;
            if (f.cyclic) m.cyclicModules += 1;
            if (f.orphan) m.orphanModules += 1;
            if (f.hub) m.hubModules += 1;
        }
        if (n.parent >= 0) {
            const p = metrics[n.parent];
            p.modules += m.modules;
            p.symbols += m.symbols;
            p.codeModules += m.codeModules;
            p.testModules += m.testModules;
            p.testedModules += m.testedModules;
            p.cyclicModules += m.cyclicModules;
            p.orphanModules += m.orphanModules;
            p.hubModules += m.hubModules;
        }
    }

    // Boundary weights: an edge leaves every ancestor of its source up to (not
    // including) the lowest common ancestor, and enters the target's likewise.
    const contains = (a: number, b: number) => nodes[a].tin <= b && b <= nodes[a].tout;
    for (const e of edges) {
        for (let x = e.src; x >= 0 && !contains(x, e.dst); x = nodes[x].parent) metrics[x].fanOut += e.weight;
        for (let x = e.dst; x >= 0 && !contains(x, e.src); x = nodes[x].parent) metrics[x].fanIn += e.weight;
    }
    return { nodes: metrics, modules, cycles };
}

/** Strongly connected components (component id per vertex), iterative Tarjan. */
export function tarjan(vertices: number[], next: (v: number) => Iterable<number>): Map<number, number> {
    const index = new Map<number, number>();
    const low = new Map<number, number>();
    const onStack = new Set<number>();
    const stack: number[] = [];
    const comp = new Map<number, number>();
    let counter = 0;
    let comps = 0;
    for (const root of vertices) {
        if (index.has(root)) continue;
        const work: Array<{ v: number; it: Iterator<number> }> = [];
        const visit = (v: number) => {
            index.set(v, counter);
            low.set(v, counter);
            counter++;
            stack.push(v);
            onStack.add(v);
            work.push({ v, it: next(v)[Symbol.iterator]() });
        };
        visit(root);
        while (work.length) {
            const top = work[work.length - 1];
            const step = top.it.next();
            if (!step.done) {
                const w = step.value;
                if (!index.has(w)) visit(w);
                else if (onStack.has(w)) low.set(top.v, Math.min(low.get(top.v)!, index.get(w)!));
                continue;
            }
            work.pop();
            if (work.length) {
                const parent = work[work.length - 1].v;
                low.set(parent, Math.min(low.get(parent)!, low.get(top.v)!));
            }
            if (low.get(top.v) === index.get(top.v)) {
                let w: number;
                do {
                    w = stack.pop()!;
                    onStack.delete(w);
                    comp.set(w, comps);
                } while (w !== top.v);
                comps++;
            }
        }
    }
    return comp;
}
