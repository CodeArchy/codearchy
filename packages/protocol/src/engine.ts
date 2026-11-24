/**
 * How a UI talks to an engine, whatever the transport (a Web Worker in the
 * browser, postMessage to the VS Code extension host, later a socket to the
 * Companion). Types only.
 */
import type { EdgeExplanation, NodeDetails, NodeSummary, View, ViewRequest } from './view.js';
import type { Flow, FlowSummary } from './flows.js';

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
    /** Entrypoints found in the workspace (Flows). */
    flows?(): Promise<FlowSummary[]>;
    /** One traced flow. */
    flow?(id: string): Promise<Flow | undefined>;
}

/** What opening a workspace produced. */
export interface WorkspaceSummary {
    name: string;
    /** Where the index lives: persistent (OPFS) or memory. */
    storage: 'opfs' | 'memory';
    files: number;
    symbols: number;
    edges: number;
    /** Source files discovered before analysis. */
    discovered: number;
    parsed: number;
    reused: number;
    durationMs: number;
    workers: number;
    languages: Record<string, number>;
    /** The source can be re-read for changes (a picked folder): `changed` events follow. */
    live: boolean;
}

/** Unsolicited messages from an engine. */
export type EngineEvent =
    | { type: 'progress'; phase: string; current: number; total: number }
    /** Files changed on disk and the index was updated: views should refetch in place. */
    | { type: 'changed'; paths: string[]; summary: WorkspaceSummary };
