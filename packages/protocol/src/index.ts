/**
 * @codearchy/protocol — the data model shared by the engine, every host and
 * the UI. Pure types and enums: no runtime dependencies, no host types.
 *
 * Paths are always workspace-relative POSIX paths (`web/src/index.ts`).
 * Hosts translate them to and from their own path format at the edge.
 */

export const PROTOCOL_VERSION = '0.2.0';

export * from './hierarchy.js';
export * from './view.js';
export * from './engine.js';

export interface SymbolInfo {
    name: string;
    kind: SymbolKind;
    /** Workspace-relative POSIX path of the declaring file. */
    filePath: string;
    startLine: number;
    endLine: number;
    exported: boolean;
    /** Enclosing type for members (e.g. the class that owns a method). */
    container?: string;
}

export enum SymbolKind {
    Function = 'function',
    Class = 'class',
    Interface = 'interface',
    Variable = 'variable',
    Type = 'type',
    Enum = 'enum',
    Module = 'module',
    Method = 'method',
}

export interface ImportInfo {
    source: string;
    specifiers: string[];
    isDefault: boolean;
    isNamespace: boolean;
    /** Workspace-relative POSIX path of the importing file. */
    filePath: string;
    /** 0-based line of the import statement, when known. */
    line?: number;
}

export interface FileAnalysis {
    /** Workspace-relative POSIX path (e.g. `web/src/index.ts`), on every OS. */
    filePath: string;
    language: string;
    symbols: SymbolInfo[];
    imports: ImportInfo[];
    exports: string[];
    /** Package / namespace the file declares (Java, Kotlin, C#, PHP, Go). */
    namespace?: string;
    /** Distinct identifiers referenced in the file. Used to narrow package-level
     *  imports (Java wildcards, C# usings, Go packages) to the files actually used. */
    references?: string[];
    /** Which extractor produced this analysis. */
    parser?: 'tree-sitter' | 'regex';
}

export interface GraphNode {
    /** Workspace-relative POSIX path; stable across machines. */
    id: string;
    label: string;
    /** Host path for opening the file (absolute on disk hosts); set by the host. */
    filePath: string;
    type: NodeType;
    symbols: SymbolInfo[];
    group?: string;
    metadata: Record<string, unknown>;
}

export enum NodeType {
    File = 'file',
    Module = 'module',
    Subsystem = 'subsystem',
}

export interface GraphEdge {
    id: string;
    source: string;
    target: string;
    type: EdgeType;
    weight: number;
    metadata: Record<string, unknown>;
}

export enum EdgeType {
    Import = 'import',
    Export = 'export',
    Dependency = 'dependency',
    Composition = 'composition',
}

export interface ArchitectureGraph {
    nodes: GraphNode[];
    edges: GraphEdge[];
    subsystems: SubsystemInfo[];
    metadata: GraphMetadata;
}

export interface SubsystemInfo {
    id: string;
    name: string;
    description: string;
    nodeIds: string[];
    color: string;
}

export interface GraphMetadata {
    analyzedAt: number;
    fileCount: number;
    totalSymbols: number;
    totalEdges: number;
    languages: string[];
    /** Stable identity for persistence (workspace absolute path). */
    projectId?: string;
    /** Display name for the project (usually folder basename). */
    projectName?: string;
    /** Absolute filesystem path of the workspace root. */
    projectPath?: string;
    /** How many files each extractor handled. */
    parserStats?: { treeSitter: number; regex: number; skipped: number };
    /** Set when discovery stopped at `codearchy.maxFiles`. */
    truncatedAt?: number;
    /** Total matching files found before any truncation. */
    discoveredFiles?: number;
    /** How the last (incremental) index run went. */
    indexStats?: {
        parsed: number;
        /** Reused from the persistent index (stat unchanged, or content re-hashed and unchanged). */
        reused: number;
        removed: number;
        durationMs: number;
        /** True when facts are stored on disk (warm restarts). */
        persistent: boolean;
        /** Parse worker threads used by the last run (0 = in-process). */
        workers: number;
    };
}

export interface AnalysisProgress {
    phase: string;
    current: number;
    total: number;
    message: string;
}
