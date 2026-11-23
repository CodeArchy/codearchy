/**
 * How the UI reaches the engine. Each host implements it over its own
 * transport: a Web Worker in the browser, postMessage to the extension host
 * in VS Code. The UI never imports the engine.
 */
import type { EdgeExplanation, NodeDetails, NodeSummary, View, ViewRequest } from '@codearchy/protocol';

export interface SearchResult {
    /** A hierarchy key (`mod:src/a.ts`, `dir:src/auth`, ...) to reveal. */
    key: string;
    name: string;
    kind: string;
    path: string;
    /** 0-based line, for symbols. */
    line?: number;
}

export interface EngineClient {
    view(request: ViewRequest): Promise<View | undefined>;
    children(key: string): Promise<NodeSummary[] | undefined>;
    describe(key: string): Promise<NodeDetails | undefined>;
    explain(source: string, target: string): Promise<EdgeExplanation | undefined>;
    search?(query: string): Promise<SearchResult[]>;
}

/** Things only the host can do; each is optional and hidden when missing. */
export interface HostActions {
    /** Open a workspace file, optionally at a 0-based line. */
    openFile?(path: string, line?: number): void;
}
