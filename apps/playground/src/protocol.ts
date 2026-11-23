/**
 * The playground's debug data, from its two extra engine requests (`debug`,
 * `file`). Everything else goes through the shared browser engine
 * (WorkerEngine / runEngineWorker in @codearchy/platform-browser).
 */
import type { SymbolInfo } from '@codearchy/protocol';

export interface FileRow {
    path: string;
    language: string;
    symbols: number;
    imports: number;
    /** Files this one depends on / that depend on it. */
    out: number;
    in: number;
}

export interface Unresolved {
    file: string;
    source: string;
    line?: number;
}

/** A hierarchy node without symbols; `parent` indexes this list. */
export interface TreeRow {
    key: string;
    kind: string;
    name: string;
    path: string;
    parent: number;
    modules: number;
    role?: string;
    roleReason?: string;
    virtual?: boolean;
}

export interface Summary {
    name: string;
    storage: 'opfs' | 'memory';
    discovered: number;
    stats: {
        files: number;
        symbols: number;
        edges: number;
        imports: number;
        unresolved: number;
        components: number;
        hierarchyMs: number;
        parsed: number;
        reused: number;
        unchanged: number;
        removed: number;
        workers: number;
        durationMs: number;
    };
    languages: Record<string, number>;
    files: FileRow[];
    edges: Array<[string, string]>;
    unresolved: Unresolved[];
    /** System › Package › Component › Module (symbols left out), DFS pre-order. */
    tree: TreeRow[];
}

export interface FileDetail {
    path: string;
    language: string;
    parser?: string;
    namespace?: string;
    symbols: SymbolInfo[];
    imports: Array<{ source: string; line?: number; targets: string[] }>;
    /** Dependencies that need no import (same package / namespace). */
    implicit: string[];
    dependents: string[];
}
