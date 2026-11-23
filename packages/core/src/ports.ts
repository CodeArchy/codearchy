/**
 * Ports: the only way @codearchy/core touches the outside world. Hosts
 * (platform-node, platform-browser, the VS Code extension) provide adapters;
 * the core itself has no Node, DOM or vscode dependency.
 *
 * All paths are workspace-relative POSIX paths.
 */
import type { QueryMatch, SyntaxNode } from '@codearchy/sdk';

export interface FileStat {
    size: number;
    isFile: boolean;
    /** Last modification time (ms since epoch), when the host knows it. Lets indexing skip unchanged files without reading them. */
    mtimeMs?: number;
}

export interface FileSystemPort {
    /** UTF-8 contents, or undefined if missing, unreadable or not a regular file. */
    readText(path: string): Promise<string | undefined>;
    stat(path: string): Promise<FileStat | undefined>;
}

/** An opaque loaded grammar. */
export interface LanguageHandle {
    readonly __languageHandle?: never;
}

export interface ParsedTree {
    readonly rootNode: SyntaxNode;
    /** Frees native (WASM) memory. Always call when done. */
    delete(): void;
}

export interface CompiledQuery {
    matches(node: SyntaxNode): QueryMatch[];
    delete(): void;
}

/** Tree-sitter, provided by the host (web-tree-sitter in Node and browsers). */
export interface ParserRuntime {
    /** Loads a grammar by file name (e.g. "tree-sitter-python.wasm"); undefined if unavailable. */
    loadLanguage(grammarFile: string): Promise<LanguageHandle | undefined>;
    compileQuery(language: LanguageHandle, source: string): CompiledQuery;
    parse(language: LanguageHandle, source: string): ParsedTree | undefined;
    dispose(): void;
}

export type Logger = (message: string) => void;

// ─── storage ────────────────────────────────────────────────────────────────

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

export interface SqlStatement {
    run(...params: SqlValue[]): void;
    get(...params: SqlValue[]): SqlRow | undefined;
    all(...params: SqlValue[]): SqlRow[];
}

/**
 * Synchronous SQLite, provided by the host: node:sqlite in Node hosts,
 * sqlite-wasm (OPFS) inside a browser worker. Same SQL and schema everywhere.
 */
export interface StoragePort {
    exec(sql: string): void;
    prepare(sql: string): SqlStatement;
    /** Runs `fn` in a transaction (rolled back if it throws). */
    transaction<T>(fn: () => T): T;
    close(): void;
    /** What this SQLite build supports. */
    readonly features: { fts5: boolean };
}
