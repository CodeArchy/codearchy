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

/**
 * What `resolveImport` can see: the importing file and the set of indexed
 * files. Paths are workspace-relative POSIX paths ("app/models/user.rb").
 */
export interface ResolveContext {
    /** The importing file. */
    fromFile: string;
    /** True when `path` is an indexed file. */
    exists(path: string): boolean;
    /** Joins and normalises segments; undefined when the result leaves the workspace. */
    join(...parts: string[]): string | undefined;
    /** "a/b/c.rb" → "a/b"; "c.rb" → "". */
    dirname(path: string): string;
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
    /**
     * Files an import specifier refers to. Packs for languages the core
     * resolver doesn't know resolve their own imports here; return [] when
     * the import is external (a gem, a system library).
     */
    resolveImport?(source: string, ctx: ResolveContext): string[];
    /**
     * A small snippet the query must match: the conformance suite parses it on
     * every platform to prove the grammar loads and the query compiles.
     */
    sample: string;
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
    const missing = [
        !pack.id && 'id',
        pack.extensions.length === 0 && 'extensions',
        !pack.grammar && 'grammar',
        !pack.query.trim() && 'query',
        !pack.sample?.trim() && 'sample',
    ].filter(Boolean);
    if (missing.length > 0) {
        throw new Error(`language pack ${pack.id || '(no id)'} is missing: ${missing.join(', ')}`);
    }
    return pack;
}
