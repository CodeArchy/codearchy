/**
 * Language packs: everything CodeArchy needs to know about a language in one
 * place: file extensions, the tree-sitter grammar, one query that captures
 * definitions and imports, and a few small hooks for language rules.
 *
 * Query capture conventions:
 *   @def.<kind>     the whole definition node; <kind> is a DefKind
 *   @name           the definition's name (inside the same pattern)
 *   @import.source  a module specifier (quotes are stripped)
 *   @import.stmt    the import statement; when there's no @import.source,
 *                   `importsFromStatement` turns it into specifiers
 *   @import.mod     a Rust-style `mod foo;` declaration (a file import)
 *   @export.name    a name exported by a separate clause (`export { a }`)
 *   @namespace      the package / namespace the file declares
 * Captures starting with `_` are helpers for predicates and are ignored.
 */
import type { SyntaxNode } from './syntax.js';

export type DefKind =
    | 'function'
    | 'class'
    | 'interface'
    | 'type'
    | 'enum'
    | 'variable'
    | 'method'
    | 'module'
    /** Rust `impl` block: a container for methods, never emitted as a symbol. */
    | 'impl';

export interface DefContext {
    node: SyntaxNode;
    name: string;
    kind: DefKind;
    /** True when the definition isn't nested inside another definition. */
    topLevel: boolean;
}

export interface ImportDetails {
    specifiers: string[];
    isDefault: boolean;
    isNamespace: boolean;
}

export interface LanguagePack {
    id: string;
    displayName: string;
    extensions: string[];
    /** Grammar file in the parsers/ directory. */
    grammar: string;
    /** Per-extension grammar overrides (e.g. `.tsx`). */
    grammarByExtension?: Record<string, string>;
    query: string;
    /** Definition kinds that can own members (methods, nested types). */
    containerKinds?: DefKind[];
    isExported(def: DefContext): boolean;
    /** Specifier/default/namespace details for an import statement. */
    importDetails?(stmt: SyntaxNode): ImportDetails;
    /** Module specifiers for an @import.stmt capture without @import.source. */
    importsFromStatement?(stmt: SyntaxNode): string[];
    /** Rewrites one captured specifier into one or more specifiers. */
    expandImport?(source: string, stmt: SyntaxNode | undefined): string[];
    /** Container for definitions that aren't lexically nested (Go methods). */
    containerName?(def: SyntaxNode): string | undefined;
    /** Leaf node types collected into FileAnalysis.references. */
    referenceNodeTypes?: string[];
}

const DEFAULT_CONTAINER_KINDS: DefKind[] = ['class', 'interface', 'enum', 'impl'];

export function containerKindsOf(pack: LanguagePack): DefKind[] {
    return pack.containerKinds ?? DEFAULT_CONTAINER_KINDS;
}

/**
 * Declares a language pack. An identity function today; it gives packs a
 * typed entry point now and a place for validation and defaults later.
 */
export function defineLanguage(pack: LanguagePack): LanguagePack {
    if (!pack.id || pack.extensions.length === 0 || !pack.grammar || !pack.query.trim()) {
        throw new Error(`invalid language pack: ${pack.id || '(no id)'}`);
    }
    return pack;
}
