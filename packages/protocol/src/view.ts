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

/** Counts behind the lenses; containers sum their modules. */
export interface NodeMetrics {
    modules: number;
    symbols: number;
    /** Non-test modules. */
    codeModules: number;
    testModules: number;
    /** Code modules at least one test module depends on. */
    testedModules: number;
    /** Modules in a dependency cycle. */
    cyclicModules: number;
    /** Modules with no dependencies in either direction. */
    orphanModules: number;
    /** Highly connected modules. */
    hubModules: number;
    /** Weight of the dependencies entering / leaving the node's subtree. */
    fanIn: number;
    fanOut: number;
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
    metrics: NodeMetrics;
    /** Set when the node is in a cycle with other visible nodes (same id, same cycle). */
    cycle?: number;
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
    /** Part of a cycle among the visible nodes. */
    cyclic?: boolean;
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

/** One hierarchy node, as the Navigator and search results show it. */
export interface NodeSummary {
    key: string;
    kind: HierarchyKind;
    name: string;
    path: string;
    modules: number;
    /** Can be drilled into or expanded. */
    hasChildren: boolean;
    role?: ComponentRole;
    roleConfidence?: number;
    roleReason?: string;
    virtual?: boolean;
    language?: string;
}

/** A neighbour in the Inspector's "Depends on" / "Used by" lists. */
export interface NodeLink {
    key: string;
    name: string;
    weight: number;
    /** Outside the node's parent: reached through a port stub. */
    outside?: boolean;
}

/** Everything the Inspector shows for one node. */
export interface NodeDetails extends NodeSummary {
    breadcrumb: Array<{ key: string; name: string; kind: HierarchyKind }>;
    /** Direct children (containers). */
    children: NodeSummary[];
    /** Symbols of a module, in source order; `depth` 0 is top level. */
    symbols: Array<{ key: string; name: string; kind: string; exported: boolean; startLine: number; endLine: number; depth: number }>;
    /** At the level of the node's siblings (and beyond, through port stubs). */
    dependsOn: NodeLink[];
    usedBy: NodeLink[];
    metrics: NodeMetrics;
    /** A module in a cycle: the other modules of that cycle (paths, up to 20). */
    cycleWith?: string[];
    /** A code module: the test modules that depend on it (paths, up to 20). */
    testedBy?: string[];
}
