/**
 * Pure transformations from an engine View to what the canvas draws:
 * containers (expanded nodes), leaf nodes, external nodes for port stubs,
 * and edges with a visual weight. No React, no DOM: unit-tested directly.
 */
import type { AuthorshipCounts, AuthorshipOrigin, NodeMetrics, View, ViewNode } from '@codearchy/protocol';

export type MapNodeType = 'container' | 'node' | 'external';

export interface MapNode {
    id: string;
    type: MapNodeType;
    /** Container this node is drawn inside. */
    parent?: string;
    label: string;
    width: number;
    height: number;
    view?: ViewNode;
}

export interface MapEdge {
    id: string;
    source: string;
    target: string;
    weight: number;
    count: number;
    implicit: boolean;
    /** Part of a cycle among the visible nodes. */
    cyclic?: boolean;
    /** Connects to an external node (a port stub). */
    port: boolean;
    /** 1..6, from the weight on a log scale. */
    strokeWidth: number;
}

export interface MapModel {
    nodes: MapNode[];
    edges: MapEdge[];
}

/** Id of the external node standing for an outside key. */
export const externalId = (key: string) => `ext:${key}`;
export const edgeId = (source: string, target: string) => `${source}->${target}`;

const LEAF = { width: 220, height: 82 };
const MODULE = { width: 200, height: 62 };
const EXTERNAL = { width: 170, height: 40 };

export function strokeWidthFor(weight: number): number {
    return Math.min(6, 1 + Math.log2(Math.max(1, weight)) / 1.5);
}

export function buildMapModel(view: View): MapModel {
    const nodes: MapNode[] = [];
    for (const n of view.nodes) {
        const size = n.expanded ? { width: 0, height: 0 } : n.kind === 'module' ? MODULE : LEAF;
        nodes.push({ id: n.key, type: n.expanded ? 'container' : 'node', ...(n.group ? { parent: n.group } : {}), label: n.name, ...size, view: n });
    }

    const edges: MapEdge[] = view.edges.map((e) => ({
        id: edgeId(e.source, e.target),
        source: e.source,
        target: e.target,
        weight: e.weight,
        count: e.count,
        implicit: e.implicit,
        ...(e.cyclic ? { cyclic: true } : {}),
        port: false,
        strokeWidth: strokeWidthFor(e.weight),
    }));

    // One external node per outside key; port stubs become edges to or from it.
    const externals = new Map<string, string>();
    for (const p of view.ports) {
        const ext = externalId(p.external);
        if (!externals.has(ext)) externals.set(ext, p.externalName);
        const [source, target] = p.direction === 'out' ? [p.node, ext] : [ext, p.node];
        edges.push({ id: edgeId(source, target), source, target, weight: p.weight, count: p.count, implicit: false, port: true, strokeWidth: strokeWidthFor(p.weight) });
    }
    for (const [id, label] of externals) nodes.push({ id, type: 'external', label, ...EXTERNAL });

    return { nodes, edges };
}

/** The outside key an external node id stands for. */
export function keyOfExternal(id: string): string | undefined {
    return id.startsWith('ext:') ? id.slice(4) : undefined;
}

/**
 * Ids within `hops` of `id` along the model's edges, both directions
 * (selection highlight and focus mode).
 */
export function neighbourhood(model: MapModel, id: string, hops: number): Set<string> {
    const around = new Map<string, string[]>();
    const link = (a: string, b: string) => {
        if (!around.has(a)) around.set(a, []);
        around.get(a)!.push(b);
    };
    for (const e of model.edges) {
        link(e.source, e.target);
        link(e.target, e.source);
    }
    const seen = new Set([id]);
    let layer = [id];
    for (let h = 0; h < hops && layer.length; h++) {
        const next: string[] = [];
        for (const k of layer) {
            for (const n of around.get(k) ?? []) {
                if (seen.has(n)) continue;
                seen.add(n);
                next.push(n);
            }
        }
        layer = next;
    }
    // A container stays lit when one of its children is.
    for (const n of model.nodes) if (n.parent && seen.has(n.id)) seen.add(n.parent);
    return seen;
}

/** Edges drawn by default: beyond this, the heaviest are shown (the rest on selection or "show all"). */
export const DEFAULT_EDGE_LIMIT = 60;

/**
 * The edges to draw: all of them when `all` or under the limit; otherwise
 * the heaviest `limit`, plus every edge touching a node in `around` (the
 * selection, or its neighbours in focus mode), so a selection always shows
 * its own dependencies.
 */
export function visibleEdges(model: MapModel, options: { all?: boolean; limit?: number; around?: Set<string> } = {}): MapEdge[] {
    const limit = options.limit ?? DEFAULT_EDGE_LIMIT;
    if (options.all || model.edges.length <= limit) return model.edges;
    const keep = new Set(
        [...model.edges]
            .sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1))
            .slice(0, limit)
            .map((e) => e.id)
    );
    const around = options.around;
    return model.edges.filter((e) => keep.has(e.id) || (around && (around.has(e.source) || around.has(e.target))));
}

// ─── lenses ─────────────────────────────────────────────────────────────────

export type LensId = 'dependencies' | 'health' | 'tests' | 'authorship';

export const LENSES: Array<{ id: LensId; label: string; description: string }> = [
    { id: 'dependencies', label: 'Dependencies', description: 'Edge thickness is the number of dependencies.' },
    { id: 'health', label: 'Health', description: 'Files in dependency cycles, hubs (very highly connected files) and orphans (no dependencies either way).' },
    { id: 'tests', label: 'Tests', description: 'Share of code files that at least one test file depends on.' },
    { id: 'authorship', label: 'Authorship', description: 'Share of lines AI tools wrote (from Co-authored-by trailers, bot commits and tool markers in git history), and how many were since changed by people.' },
];

/** Authorship origins in display order, with labels (colour never carries the value alone). */
export const AUTHORSHIP_ORIGINS: Array<{ origin: AuthorshipOrigin; label: string; title: string }> = [
    { origin: 'ai', label: 'AI', title: 'Written by an AI tool and unchanged since' },
    { origin: 'reviewed', label: 'reviewed', title: 'Written by an AI tool, later changed by a person' },
    { origin: 'human', label: 'human', title: 'Written by a person (positive evidence)' },
    { origin: 'unknown', label: 'unknown', title: 'No evidence either way (most history before tracking)' },
];

/** `claude-code` → `Claude Code` (unknown ids as they are). */
export { agentName } from '@codearchy/protocol';

/** Whole-percent shares that add up to 100 (largest remainder), so a bar and its labels agree. */
export function authorshipShares(c: AuthorshipCounts): Record<AuthorshipOrigin, number> {
    const total = c.ai + c.reviewed + c.human + c.unknown;
    const out: Record<AuthorshipOrigin, number> = { ai: 0, reviewed: 0, human: 0, unknown: 0 };
    if (!total) return out;
    const raw = AUTHORSHIP_ORIGINS.map(({ origin }) => ({ origin, exact: (c[origin] / total) * 100 }));
    let left = 100;
    for (const r of raw) {
        out[r.origin] = Math.floor(r.exact);
        left -= out[r.origin];
    }
    for (const r of [...raw].sort((a, b) => b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)))) {
        if (left <= 0) break;
        if (r.exact > out[r.origin]) {
            out[r.origin]++;
            left--;
        }
    }
    return out;
}

export interface LensBadge {
    /** Tests, authorship: ordinal step 1..5. Health: a status. Undefined: nothing to colour. */
    level?: 1 | 2 | 3 | 4 | 5 | 'critical' | 'serious' | 'warning';
    /** Always shown: colour never carries the value alone. */
    text: string;
    title: string;
    /** Authorship: the stacked bar (percent per origin). */
    shares?: Record<AuthorshipOrigin, number>;
}

/** AI share (unchanged AI lines) → ordinal step: >0, ≥10%, ≥25%, ≥50%, ≥75%. */
const AI_STEPS = [0, 0.1, 0.25, 0.5, 0.75];

export function lensBadge(m: NodeMetrics, lens: LensId, kind: string, authorship?: AuthorshipCounts): LensBadge | undefined {
    if (lens === 'authorship') {
        if (!authorship) return undefined;
        const total = authorship.ai + authorship.reviewed + authorship.human + authorship.unknown;
        if (!total) return undefined;
        const shares = authorshipShares(authorship);
        const title = AUTHORSHIP_ORIGINS.map(({ origin, label }) => `${authorship[origin].toLocaleString()} ${label}`).join(', ') + ` (of ${total.toLocaleString()} lines)`;
        if (!authorship.ai && !authorship.reviewed) return { text: 'no AI lines found', title, shares };
        const share = authorship.ai / total;
        let level: 1 | 2 | 3 | 4 | 5 | undefined;
        AI_STEPS.forEach((t, i) => {
            if (share > t) level = (i + 1) as 1 | 2 | 3 | 4 | 5;
        });
        // A share that rounds to 0 but isn't nothing reads "<1%", never "0%".
        const pct = (n: number, share: number) => (n > 0 && share === 0 ? '<1%' : `${share}%`);
        const parts = [`${pct(authorship.ai, shares.ai)} AI`];
        if (authorship.reviewed) parts.push(`${pct(authorship.reviewed, shares.reviewed)} reviewed`);
        return { ...(level ? { level } : {}), text: parts.join(' · '), title, shares };
    }
    if (lens === 'tests') {
        if (m.codeModules === 0) return m.testModules > 0 ? { text: kind === 'module' ? 'test file' : 'tests only', title: `${m.testModules} test file(s)` } : undefined;
        const ratio = m.testedModules / m.codeModules;
        const level = (Math.min(4, Math.floor(ratio * 5)) + 1) as 1 | 2 | 3 | 4 | 5;
        if (kind === 'module') return { level: ratio > 0 ? 5 : 1, text: ratio > 0 ? 'tested' : 'untested', title: ratio > 0 ? 'A test file depends on this file' : 'No test file depends on this file' };
        return { level, text: `${Math.round(ratio * 100)}% tested`, title: `${m.testedModules} of ${m.codeModules} code files have a test file depending on them (${m.testModules} test files)` };
    }
    if (lens === 'health') {
        const parts: string[] = [];
        if (m.cyclicModules) parts.push(`⟳ ${m.cyclicModules} in cycles`);
        if (m.hubModules) parts.push(`◆ ${m.hubModules} hub${m.hubModules === 1 ? '' : 's'}`);
        if (m.orphanModules) parts.push(`○ ${m.orphanModules} orphan${m.orphanModules === 1 ? '' : 's'}`);
        if (kind === 'module') {
            if (m.cyclicModules) return { level: 'critical', text: '⟳ in a cycle', title: 'This file is part of a dependency cycle' };
            if (m.hubModules) return { level: 'serious', text: '◆ hub', title: 'Very highly connected file' };
            if (m.orphanModules) return { level: 'warning', text: '○ orphan', title: 'Nothing depends on this file and it depends on nothing' };
            return { text: 'no issues', title: 'No cycle, hub or orphan' };
        }
        if (parts.length === 0) return { text: 'no issues', title: 'No files in cycles, no hubs, no orphans' };
        const level = m.cyclicModules ? 'critical' : m.hubModules ? 'serious' : 'warning';
        return { level, text: parts.join(' · '), title: `${parts.join(', ')} (of ${m.modules} files)` };
    }
    return undefined;
}

// ─── matrix (DSM) ───────────────────────────────────────────────────────────

export interface MatrixOrder {
    /** Leaf keys, providers first: a node comes after everything it depends on (cycles aside). */
    keys: string[];
    /** Cycle id per key, for nodes in a cycle. */
    cycleOf: Map<string, number>;
}

/**
 * Orders a view's leaves for a dependency structure matrix: topological
 * order of the cycle-condensed graph with providers first, ties by name. Rows
 * depend on columns, so ordinary dependencies fall below the diagonal and
 * only feedback (inside a cycle) lands above it.
 */
export function matrixOrder(view: View): MatrixOrder {
    const leaves = view.nodes.filter((n) => !n.expanded);
    const group = (n: ViewNode) => (n.cycle !== undefined ? `c${n.cycle}` : n.key);
    const members = new Map<string, ViewNode[]>();
    for (const n of leaves) {
        const g = group(n);
        if (!members.has(g)) members.set(g, []);
        members.get(g)!.push(n);
    }
    const groupOf = new Map(leaves.map((n) => [n.key, group(n)]));
    const deps = new Map<string, Set<string>>([...members.keys()].map((g) => [g, new Set<string>()]));
    for (const e of view.edges) {
        const a = groupOf.get(e.source);
        const b = groupOf.get(e.target);
        if (a && b && a !== b) deps.get(a)!.add(b);
    }
    const label = (g: string) => members.get(g)!.map((n) => n.name.toLowerCase()).sort()[0];
    const placed = new Set<string>();
    const keys: string[] = [];
    while (placed.size < members.size) {
        const ready = [...members.keys()].filter((g) => !placed.has(g) && [...deps.get(g)!].every((d) => placed.has(d)));
        // The condensation is acyclic, so something is always ready; guard anyway.
        const next = (ready.length ? ready : [...members.keys()].filter((g) => !placed.has(g))).sort((a, b) => (label(a) < label(b) ? -1 : 1))[0];
        placed.add(next);
        for (const n of members.get(next)!.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1))) keys.push(n.key);
    }
    const cycleOf = new Map(leaves.filter((n) => n.cycle !== undefined).map((n) => [n.key, n.cycle!]));
    return { keys, cycleOf };
}

/** Step 1..7 of the sequential ramp for a weight, on a log scale up to `max`. */
export function heatStep(weight: number, max: number): number {
    if (weight <= 0 || max <= 0) return 0;
    return 1 + Math.min(6, Math.floor((Math.log1p(weight) / Math.log1p(max)) * 6.999));
}

// ─── selection flow ─────────────────────────────────────────────────────────

export interface FlowRoles {
    /** The selection: the node itself, plus everything drawn inside it when it's expanded. */
    selected: Set<string>;
    /** Nodes that stay bright: the selection and its neighbours (`hops` away). */
    lit: Set<string>;
    /** Edges leaving the selection ("uses"), entering it ("used by"), and inside it. */
    out: Set<string>;
    in: Set<string>;
    internal: Set<string>;
}

/** Everything drawn inside `id` (expanded containers hold their children). */
function inside(model: MapModel, id: string): Set<string> {
    const set = new Set([id]);
    let grew = true;
    while (grew) {
        grew = false;
        for (const n of model.nodes) {
            if (n.parent && set.has(n.parent) && !set.has(n.id)) {
                set.add(n.id);
                grew = true;
            }
        }
    }
    return set;
}

/**
 * How a selection lights the Map: its own edges are classified as uses /
 * used by / internal (each drawn animated, in the dependency's direction);
 * neighbours within `hops` stay bright and everything else fades.
 */
export function flowRoles(model: MapModel, id: string, hops = 1): FlowRoles {
    const selected = inside(model, id);
    const out = new Set<string>();
    const inn = new Set<string>();
    const internal = new Set<string>();
    for (const e of model.edges) {
        const s = selected.has(e.source);
        const t = selected.has(e.target);
        if (s && t) internal.add(e.id);
        else if (s) out.add(e.id);
        else if (t) inn.add(e.id);
    }
    const lit = new Set(selected);
    for (const n of selected) for (const x of neighbourhood(model, n, hops)) lit.add(x);
    return { selected, lit, out, in: inn, internal };
}

// ─── reveal in place ────────────────────────────────────────────────────────

/**
 * How to show `path` (system → … → the node) on the current canvas: expand
 * its ancestors below the scope rather than opening a new view. A node
 * outside the current scope brings the canvas back to the system.
 */
export function revealPlan(path: string[], scope: string, expanded: string[]): { scope: string; expanded: string[] } {
    const at = path.indexOf(scope);
    const base = at >= 0 && at < path.length - 1 ? scope : at === path.length - 1 ? scope : path[0];
    const from = path.indexOf(base);
    const ancestors = path.slice(from + 1, -1);
    const keep = base === scope ? expanded : [];
    return { scope: base, expanded: [...new Set([...keep, ...ancestors])] };
}
