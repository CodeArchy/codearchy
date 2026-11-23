/**
 * @codearchy/treesitter — the ParserRuntime adapter shared by every host.
 * Wraps web-tree-sitter and loads the runtime and grammars from *bytes*
 * supplied by the platform (files in Node, fetch/OPFS in browsers, a bundle
 * in VS Code), so it does no file or network I/O of its own.
 */
import { Language, Parser, Query } from 'web-tree-sitter';
import type { CompiledQuery, LanguageHandle, ParsedTree, ParserRuntime } from '@codearchy/core';
import type { QueryMatch, SyntaxNode } from '@codearchy/sdk';

export interface TreeSitterAssets {
    /** Bytes of web-tree-sitter.wasm (the runtime; must match this package's web-tree-sitter version). */
    runtimeWasm(): Promise<Uint8Array>;
    /** Bytes of a grammar such as "tree-sitter-python.wasm"; undefined if unavailable. */
    grammar(file: string): Promise<Uint8Array | undefined>;
}

let runtimeInit: Promise<void> | undefined;

/** Creates a ParserRuntime. The WASM runtime initialises once per JS realm. */
export async function createTreeSitterRuntime(assets: TreeSitterAssets): Promise<ParserRuntime> {
    runtimeInit ??= assets.runtimeWasm().then((bytes) => {
        // An exact ArrayBuffer view of the bytes (Emscripten's wasmBinary type).
        const wasmBinary = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        // With wasmBinary set, the loader uses these bytes; locateFile only names them.
        return Parser.init({ wasmBinary, locateFile: (file: string) => file });
    });
    try {
        await runtimeInit;
    } catch (err) {
        runtimeInit = undefined; // allow a retry with different assets
        throw err;
    }
    const parser = new Parser();
    return {
        async loadLanguage(file: string): Promise<LanguageHandle | undefined> {
            const bytes = await assets.grammar(file);
            if (!bytes) return undefined;
            return (await Language.load(bytes)) as unknown as LanguageHandle;
        },
        compileQuery(language: LanguageHandle, source: string): CompiledQuery {
            const query = new Query(language as unknown as Language, source);
            return {
                matches: (node: SyntaxNode) => query.matches(node as never) as unknown as QueryMatch[],
                delete: () => query.delete(),
            };
        },
        parse(language: LanguageHandle, source: string): ParsedTree | undefined {
            parser.setLanguage(language as unknown as Language);
            const tree = parser.parse(source);
            if (!tree) return undefined;
            return { rootNode: tree.rootNode as unknown as SyntaxNode, delete: () => tree.delete() };
        },
        dispose(): void {
            parser.delete();
        },
    };
}
