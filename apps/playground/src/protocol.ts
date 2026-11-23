/** Messages between the UI thread (main.ts) and the engine worker (engine.worker.ts). */
import type { SymbolInfo } from '@codearchy/protocol';

export type Source =
    | { kind: 'sample' }
    /** A folder from showDirectoryPicker() (Chromium): read in place, re-indexable. */
    | { kind: 'handle'; handle: FileSystemDirectoryHandle }
    /** A folder from <input webkitdirectory> (every browser): a snapshot. */
    | { kind: 'files'; name: string; files: File[] };

export type Request =
    | { id: number; type: 'open'; source: Source }
    | { id: number; type: 'search'; query: string }
    | { id: number; type: 'file'; path: string };

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

export interface SearchHit {
    path: string;
    name: string;
    kind: string;
    container: string | null;
    line: number;
}

export type Response =
    | { type: 'progress'; phase: string; current: number; total: number }
    | { type: 'result'; id: number; result: unknown }
    | { type: 'error'; id: number; message: string };
