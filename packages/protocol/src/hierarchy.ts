/**
 * The architecture hierarchy: System › Package › Component › Module › Symbol.
 * Drill-down views are projections of this tree (see @codearchy/core's
 * hierarchy and projector).
 */

export type HierarchyKind = 'system' | 'package' | 'component' | 'module' | 'symbol';

/** Deterministic architectural roles, assigned from path words and member files. */
export type ComponentRole = 'api' | 'ui' | 'domain' | 'data' | 'infra' | 'config' | 'test' | 'util';

export interface RoleAssignment {
    role: ComponentRole;
    /** 0..1 */
    confidence: number;
    /** Human-readable evidence, e.g. `folder name "controllers"`. */
    reason: string;
}

export interface HierarchyNode {
    /**
     * Stable across re-indexes, so layouts, notes and tours can key off it:
     *   sys:root · pkg:<dir> · grp:<folder of packages> · dir:<path> · cl:<parent>:<hash> · mod:<path> · sym:<path>#<name>
     */
    key: string;
    kind: HierarchyKind;
    /** Index of the parent in `Hierarchy.nodes`; -1 for the root. */
    parent: number;
    name: string;
    /** Workspace path: the directory of a package or component, the file of a module or symbol ('' = root). */
    path: string;
    /**
     * Euler-tour interval. Nodes are stored in DFS pre-order, so `tin` is the
     * node's own index and `tout` the index of its last descendant: `a` is an
     * ancestor-or-self of `b` exactly when `a.tin <= b.tin && b.tin <= a.tout`.
     */
    tin: number;
    tout: number;
    depth: number;
    /** Modules (files) in the subtree. */
    modules: number;
    role?: RoleAssignment;
    /** A group made by clustering a wide directory, not a directory itself. */
    virtual?: boolean;
    /** Modules: the file's language. */
    language?: string;
    /** Symbols: kind, visibility and lines (0-based). */
    symbolKind?: string;
    exported?: boolean;
    startLine?: number;
    endLine?: number;
}

/** A base dependency between two modules (indexes into `Hierarchy.nodes`). */
export interface HierarchyEdge {
    src: number;
    dst: number;
    weight: number;
    /** No import statement: same package / namespace use. */
    implicit?: boolean;
    /** A few of the import sites behind the edge (the weight counts all of them). */
    evidence: Array<{ source: string; line?: number }>;
}

export interface Hierarchy {
    /** DFS pre-order; `nodes[0]` is the system root. */
    nodes: HierarchyNode[];
    edges: HierarchyEdge[];
}
