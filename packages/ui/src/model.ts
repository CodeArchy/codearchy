/**
 * Pure transformations from an engine View to what the canvas draws:
 * containers (expanded nodes), leaf nodes, external nodes for port stubs,
 * and edges with a visual weight. No React, no DOM: unit-tested directly.
 */
import type { View, ViewNode } from '@codearchy/protocol';

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

const LEAF = { width: 220, height: 68 };
const MODULE = { width: 200, height: 52 };
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
