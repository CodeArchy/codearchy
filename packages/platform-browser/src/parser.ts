/** ParserRuntime for browsers: the runtime and grammar .wasm files are fetched by URL. */
import type { ParserRuntime } from '@codearchy/core';
import { createTreeSitterRuntime } from '@codearchy/treesitter';

export interface FetchParserOptions {
    /** URL of web-tree-sitter.wasm (matching @codearchy/treesitter's web-tree-sitter version). */
    runtimeWasmUrl: string;
    /** Base URL holding the grammar files (e.g. "/parsers/"). */
    grammarBaseUrl: string;
}

async function fetchBytes(url: string): Promise<Uint8Array | undefined> {
    const res = await fetch(url);
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : undefined;
}

export function createFetchParserRuntime(options: FetchParserOptions): Promise<ParserRuntime> {
    const base = options.grammarBaseUrl.endsWith('/') ? options.grammarBaseUrl : `${options.grammarBaseUrl}/`;
    return createTreeSitterRuntime({
        runtimeWasm: async () => {
            const bytes = await fetchBytes(options.runtimeWasmUrl);
            if (!bytes) throw new Error(`failed to fetch ${options.runtimeWasmUrl}`);
            return bytes;
        },
        // File names only: never let a grammar name turn into another URL.
        grammar: (file) => (/^[\w.-]+\.wasm$/.test(file) ? fetchBytes(new URL(file, new URL(base, location.href)).href) : Promise.resolve(undefined)),
    });
}
