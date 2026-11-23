/** Small syntax-tree helpers shared by language packs. */
import type { SyntaxNode } from './syntax.js';

/** True when an ancestor within `maxDepth` levels has type `type`. */
export function hasAncestorOfType(node: SyntaxNode, type: string, maxDepth: number): boolean {
    let current = node.parent;
    for (let depth = 0; current && depth < maxDepth; depth++) {
        if (current.type === type) return true;
        current = current.parent;
    }
    return false;
}

/** Text of the node's modifier children (`public static`, `pub`, ...). */
export function modifierText(node: SyntaxNode, types: string[]): string {
    return node.namedChildren
        .filter((c): c is SyntaxNode => !!c && types.includes(c.type))
        .map((c) => c.text)
        .join(' ');
}
