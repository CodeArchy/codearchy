/**
 * The subset of the tree-sitter API that language packs and the engine use.
 *
 * Structural on purpose: web-tree-sitter's objects satisfy these interfaces
 * as-is, in Node and in browsers, but nothing here depends on web-tree-sitter
 * (or on DOM / Node types), so packs and the core stay host-agnostic.
 */

export interface Point {
    row: number;
    column: number;
}

export interface SyntaxNode {
    /** Unique within its tree. */
    readonly id: number;
    readonly type: string;
    readonly text: string;
    readonly startIndex: number;
    readonly endIndex: number;
    readonly startPosition: Point;
    readonly endPosition: Point;
    readonly parent: SyntaxNode | null;
    readonly previousNamedSibling: SyntaxNode | null;
    readonly namedChildren: ReadonlyArray<SyntaxNode | null>;
    childForFieldName(fieldName: string): SyntaxNode | null;
    childrenForFieldName(fieldName: string): ReadonlyArray<SyntaxNode | null>;
    descendantsOfType(types: string | string[]): ReadonlyArray<SyntaxNode | null>;
    walk(): TreeCursor;
}

export interface TreeCursor {
    readonly nodeType: string;
    readonly nodeText: string;
    gotoFirstChild(): boolean;
    gotoNextSibling(): boolean;
    gotoParent(): boolean;
    delete(): void;
}

export interface QueryCapture {
    name: string;
    node: SyntaxNode;
}

export interface QueryMatch {
    captures: QueryCapture[];
}
