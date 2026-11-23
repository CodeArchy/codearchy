/**
 * Views: projections of the hierarchy that the Map, Matrix and Navigator
 * render. A view shows the children of a `scope` node, some of them expanded
 * in place; every base dependency is projected onto the visible nodes, and
 * dependencies that leave the scope become port stubs.
 */
import type { ComponentRole, HierarchyKind } from './hierarchy.js';

export interface ViewRequest {
    /** Key of the node being drilled into (default: the system root). */
    scope?: string;
    /** Keys expanded in place (compound nodes); ignored unless inside the scope. */
    expanded?: string[];
    /** Most leaf nodes in the view (default 300). Expansions that would exceed it are skipped. */
    budget?: number;
}

export interface ViewNode {
    key: string;
    kind: HierarchyKind;
    name: string;
    path: string;
    /** Key of the expanded node this one is drawn inside, if any (compound layout). */
    group?: string;
    /** True for an expanded node: drawn as a container around its children. */
    expanded: boolean;
    /** Can be drilled into or expanded. */
    hasChildren: boolean;
    modules: number;
    role?: ComponentRole;
    roleConfidence?: number;
    virtual?: boolean;
    /** Edges into / out of this node within the view (for sizing and ranking). */
    fanIn: number;
    fanOut: number;
}

export interface ViewEdge {
    source: string;
    target: string;
    /** Sum of the base edges' weights. */
    weight: number;
    /** Number of module-to-module dependencies behind it. */
    count: number;
    /** Every dependency behind it is implicit (same package / namespace, no import). */
    implicit: boolean;
}

/** Dependencies between a visible node and something outside the scope. */
export interface PortStub {
    /** Visible node inside the scope. */
    node: string;
    /** The outside node, at the level of the scope's siblings or its ancestors' siblings. */
    external: string;
    externalName: string;
    direction: 'out' | 'in';
    weight: number;
    count: number;
}

export interface View {
    scope: string;
    /** System → … → scope. */
    breadcrumb: Array<{ key: string; name: string; kind: HierarchyKind }>;
    /** Expanded containers first (outermost first), then leaves; leaves are what edges connect. */
    nodes: ViewNode[];
    edges: ViewEdge[];
    ports: PortStub[];
    /** Expansions not applied because they would exceed the budget. */
    skipped: string[];
    /** Identifies this exact frontier, for caching layouts. */
    frontierHash: string;
}

/** The module-level dependencies behind one view edge ("explain edge"). */
export interface EdgeExplanation {
    source: string;
    target: string;
    total: number;
    dependencies: Array<{
        from: string;
        to: string;
        weight: number;
        implicit: boolean;
        evidence: Array<{ source: string; line?: number }>;
    }>;
}
