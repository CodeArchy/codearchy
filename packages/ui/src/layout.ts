/**
 * Layout with ELK (layered, left to right) in a Web Worker, so it never runs
 * on the UI thread. Results are cached by the view's frontier hash: going
 * back to a view, or re-expanding the same node, reuses the same positions.
 *
 * ELK places the nodes AND routes the edges (orthogonal, around the nodes,
 * each edge in its own lane between layers). The canvas draws those routes;
 * a line drawn straight from handle to handle would cut through the cards
 * in between and pile onto its neighbours.
 */
import * as elkApi from 'elkjs/lib/elk-api.js';
import type { ELK as ElkInstance, ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api.js';
import type { MapModel } from './model.js';

export interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface Point {
    x: number;
    y: number;
}

/** An edge's route on the canvas (absolute coordinates): start, bends, end. */
export interface Route {
    points: Point[];
    /** Where its source and target sat (absolute) when it was routed; a route is only drawn while they still do. */
    source: Point;
    target: Point;
}

export interface Layout {
    /** Positions relative to the parent container (or the canvas), as React Flow expects. */
    boxes: Map<string, Box>;
    /** ELK's route per edge id. */
    routes: Map<string, Route>;
}

const ROOT_OPTIONS: Record<string, string> = {
    'elk.algorithm': 'layered',
    'elk.direction': 'RIGHT',
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    // Keep the engine's (stable, hierarchy) order where it doesn't cost crossings, so
    // expanding one node doesn't reshuffle its unrelated neighbours.
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    // Try harder to untangle (the default is 7; views are small, so this stays fast).
    'elk.layered.thoroughness': '20',
    'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
    'elk.spacing.nodeNode': '36',
    'elk.layered.spacing.nodeNodeBetweenLayers': '80',
    'elk.spacing.edgeNode': '24',
    // Every edge gets its own lane: parallel lines stay apart, never one shared trunk.
    'elk.spacing.edgeEdge': '12',
    'elk.layered.spacing.edgeEdgeBetweenLayers': '12',
    'elk.layered.spacing.edgeNodeBetweenLayers': '24',
    // Routes come back in canvas coordinates, whichever container an edge belongs to.
    'elk.json.edgeCoords': 'ROOT',
};
const CONTAINER_OPTIONS: Record<string, string> = {
    'elk.padding': '[top=44,left=20,bottom=20,right=20]',
};

/** The ELK graph for a model: containers hold their children; edges live at the root. */
export function toElkGraph(model: MapModel): ElkNode {
    const byId = new Map<string, ElkNode>();
    const root: ElkNode = { id: '__root', layoutOptions: ROOT_OPTIONS, children: [], edges: [] };
    for (const n of model.nodes) {
        const node: ElkNode = n.type === 'container' ? { id: n.id, layoutOptions: CONTAINER_OPTIONS, children: [] } : { id: n.id, width: n.width, height: n.height };
        byId.set(n.id, node);
    }
    for (const n of model.nodes) {
        const parent = n.parent ? byId.get(n.parent) : undefined;
        (parent ?? root).children!.push(byId.get(n.id)!);
    }
    root.edges = model.edges.map((e): ElkExtendedEdge => ({ id: e.id, sources: [e.source], targets: [e.target] }));
    return root;
}

export function fromElkGraph(root: ElkNode): Layout {
    const boxes = new Map<string, Box>();
    const absolute = new Map<string, Point>();
    const walk = (n: ElkNode, ox: number, oy: number) => {
        for (const c of n.children ?? []) {
            const box = { x: c.x ?? 0, y: c.y ?? 0, width: c.width ?? 0, height: c.height ?? 0 };
            boxes.set(c.id, box);
            absolute.set(c.id, { x: ox + box.x, y: oy + box.y });
            walk(c, ox + box.x, oy + box.y);
        }
    };
    walk(root, 0, 0);
    const routes = new Map<string, Route>();
    const collect = (n: ElkNode) => {
        for (const e of n.edges ?? []) {
            const s = e.sections?.[0];
            const source = absolute.get(e.sources[0]!);
            const target = absolute.get(e.targets[0]!);
            // One section per edge (one source, one target); anything else is drawn the plain way.
            if (!s || e.sections!.length !== 1 || !source || !target) continue;
            routes.set(e.id, { points: [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p) => ({ x: p.x, y: p.y })), source, target });
        }
        for (const c of n.children ?? []) collect(c);
    };
    collect(root);
    return { boxes, routes };
}

type ElkConstructor = new (args: { workerUrl?: string }) => ElkInstance;
/** elkjs is CommonJS: depending on the bundler the class is the module or its `default`. */
const ELK: ElkConstructor = ((elkApi as unknown as { default?: unknown }).default ?? elkApi) as ElkConstructor;

export interface LayoutEngineOptions {
    /** URL of elkjs's `lib/elk-worker.min.js`, served by the host. */
    workerUrl: string;
    /** Layouts kept in memory (default 40). */
    cacheSize?: number;
}

export class LayoutEngine {
    private readonly elk: ElkInstance;
    private readonly cache = new Map<string, Promise<Layout>>();
    private readonly cacheSize: number;

    constructor(options: LayoutEngineOptions) {
        this.elk = new ELK({ workerUrl: options.workerUrl });
        this.cacheSize = options.cacheSize ?? 40;
    }

    /** Lays out `model`; `key` (the frontier hash) identifies it for the cache. */
    layout(key: string, model: MapModel): Promise<Layout> {
        const hit = this.cache.get(key);
        if (hit) {
            this.cache.delete(key);
            this.cache.set(key, hit); // most recently used
            return hit;
        }
        const pending = this.elk.layout(toElkGraph(model)).then(fromElkGraph);
        pending.catch(() => this.cache.delete(key));
        this.cache.set(key, pending);
        while (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value!);
        return pending;
    }

    dispose(): void {
        this.elk.terminateWorker();
        this.cache.clear();
    }
}
