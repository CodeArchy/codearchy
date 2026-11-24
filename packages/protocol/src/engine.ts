/**
 * How a UI talks to an engine, whatever the transport (a Web Worker in the
 * browser, postMessage to the VS Code extension host, later a socket to the
 * Companion). Types only.
 */
import type { EdgeExplanation, NodeDetails, NodeSummary, View, ViewRequest } from './view.js';
import type { Flow, FlowSummary } from './flows.js';
import type { Tour, TourDetails, TourSummary } from './tours.js';
import type { AuthorshipOrigin, AuthorshipStatus, NodeAuthorship } from './authorship.js';

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
    /** The generated Start Here tour and the workspace's authored tours. */
    tours?(): Promise<TourSummary[]>;
    /** One tour, with each step checked for staleness. */
    tour?(id: string): Promise<TourDetails | undefined>;
    /** The tour with each step's anchor stamped from the current code (for saving or downloading). */
    anchorTour?(tour: Tour): Promise<Tour>;
    /** Writes `.codearchy/tours/<id>.json` (anchored) in the workspace; hosts that can't write leave it out. */
    saveTour?(tour: Tour): Promise<{ file: string }>;
    /** Whether authorship is known here (it needs git history: VS Code, the Companion). */
    authorshipStatus?(): Promise<AuthorshipStatus>;
    /** A node's authorship: counts, agents, AI-heavy files, timeline and commits. */
    authorship?(key: string): Promise<NodeAuthorship | undefined>;
    /**
     * A person's say on lines of a file (1-based, inclusive): `reviewed` marks
     * AI-written lines as reviewed; an origin corrects the attribution. Kept in
     * the host's ledger, never in the workspace's files.
     */
    authorshipMark?(path: string, start: number, end: number, as: 'reviewed' | AuthorshipOrigin): Promise<{ marked: number }>;
}

/** What opening a workspace produced. */
export interface WorkspaceSummary {
    name: string;
    /** Where the index lives: persistent (OPFS), memory, or a native engine (the Companion). */
    storage: 'opfs' | 'memory' | 'native';
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
