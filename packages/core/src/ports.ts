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
