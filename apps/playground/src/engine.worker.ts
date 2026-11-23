/**
 * The engine, in a module Worker: SQLite's OPFS pool needs one, and it keeps
 * the UI responsive while a large folder indexes. Wires @codearchy/core to the
 * browser adapters exactly as the PWA will: HandleFileSystem / MemoryFileSystem,
 * SQLite WASM on OPFS (falling back to memory), and a pool of parse workers.
 */
import {
    DEFAULT_EXCLUDE_PATTERNS,
    DEFAULT_LANGUAGE_IDS,
    HierarchyIndex,
    ImportResolver,
    IndexStore,
    Indexer,
    buildGraph,
    buildHierarchy,
    classifyFiles,
    type FileSystemPort,
} from '@codearchy/core';
import type { FileAnalysis } from '@codearchy/protocol';
import {
    BrowserWorkerPool,
    HandleFileSystem,
    MemoryFileSystem,
    listHandleFiles,
    openSqliteWasm,
    opfsSyncAccessAvailable,
    type MemoryEntry,
    type WorkspaceSource,
} from '@codearchy/platform-browser';
import type { FileDetail, Request, Response, SearchHit, Source, Summary, TreeRow, Unresolved } from './protocol.js';

const scope = self as unknown as { onmessage: ((ev: MessageEvent<Request>) => void) | null; postMessage(m: Response): void };
const asset = (p: string) => new URL(p, self.location.href).href;
const PARSERS = { runtimeWasmUrl: asset('parsers/web-tree-sitter.wasm'), grammarBaseUrl: asset('parsers/') };
const MAX_FILE_SIZE = 1_000_000;
/** Rows sent to the UI per list; the counts are always exact. */
const LIST_LIMIT = 20_000;

interface Workspace {
    store: IndexStore;
    analyses: Map<string, FileAnalysis>;
    resolver: ImportResolver;
    dependents: Map<string, string[]>;
    hierarchy: HierarchyIndex;
}

let current: Workspace | undefined;

async function openSource(source: Source): Promise<{ name: string; fs: FileSystemPort; paths: string[]; workers: WorkspaceSource }> {
    if (source.kind === 'handle') {
        return { name: source.handle.name, fs: new HandleFileSystem(source.handle), paths: await listHandleFiles(source.handle), workers: { kind: 'handle', handle: source.handle } };
    }
    let mem: MemoryFileSystem;
    let name: string;
    if (source.kind === 'files') {
        mem = MemoryFileSystem.fromFiles(source.files);
        name = source.name;
    } else {
        const files: Record<string, string> = await (await fetch(asset('fixture.json'))).json();
        // A fixed mtime: the sample never changes, so a reload reuses every file by stat.
        mem = new MemoryFileSystem(Object.entries(files).map(([p, text]): [string, MemoryEntry] => [p, { data: text, mtimeMs: 1 }]));
        name = 'sample (fixtures/polyglot)';
    }
    return { name, fs: mem, paths: mem.paths(), workers: { kind: 'memory', entries: mem.entries() } };
}

async function openStore(name: string): Promise<{ store: IndexStore; storage: 'opfs' | 'memory' }> {
    const dbName = `${name.replace(/[^\w.-]+/g, '_').slice(0, 80)}.db`;
    const wasmUrl = asset('sqlite3.wasm');
    if (await opfsSyncAccessAvailable()) {
        try {
            const db = await openSqliteWasm({ mode: 'opfs-sahpool', name: dbName, poolName: 'codearchy-playground', wasmUrl });
            return { store: new IndexStore(db), storage: 'opfs' };
        } catch (err) {
            // e.g. another tab holds the pool: index in memory instead.
            console.warn(`OPFS storage unavailable (${(err as Error).message}); indexing in memory`);
        }
    }
    return { store: new IndexStore(await openSqliteWasm({ mode: 'memory', wasmUrl })), storage: 'memory' };
}

async function open(source: Source): Promise<Summary> {
    current?.store.close();
    current = undefined;

    const { name, fs, paths, workers } = await openSource(source);
    const d = classifyFiles(paths, { languages: DEFAULT_LANGUAGE_IDS, excludePatterns: DEFAULT_EXCLUDE_PATTERNS, maxFiles: 0 }, source.kind);
    const { store, storage } = await openStore(name);
    const executor = new BrowserWorkerPool({ ...PARSERS, workerUrl: asset('parse.worker.js'), source: workers, maxFileSize: MAX_FILE_SIZE });

    let lastPost = 0;
    let result;
    try {
        result = await new Indexer({ fs, store, executor }).index(d.sourceFiles, d.manifests, {
            onProgress(p) {
                const now = Date.now();
                if (now - lastPost < 100 && p.current !== p.total) return;
                lastPost = now;
                scope.postMessage({ type: 'progress', phase: p.phase, current: p.current, total: p.total });
            },
        });
    } finally {
        executor.dispose();
    }

    const graph = buildGraph(result.analyses.values(), result.manifests);
    const hierarchyStarted = Date.now();
    const hierarchy = buildHierarchy(graph, { systemName: name, packageMarkers: d.packageMarkers, manifests: result.manifests });
    const hierarchyMs = Date.now() - hierarchyStarted;
    // Symbols are leaves, so dropping them keeps DFS pre-order; parents are re-indexed.
    const tree: TreeRow[] = [];
    const rowOf = new Map<number, number>();
    for (const n of hierarchy.nodes) {
        if (n.kind === 'symbol') continue;
        rowOf.set(n.tin, tree.length);
        tree.push({
            key: n.key,
            kind: n.kind,
            name: n.name,
            path: n.path,
            parent: n.parent < 0 ? -1 : rowOf.get(n.parent)!,
            modules: n.modules,
            // A file's role inherited from a folder above only repeats that folder: show own evidence only.
            ...(n.role && (n.kind !== 'module' || n.role.confidence >= 0.8) ? { role: n.role.role, roleReason: `${n.role.reason} (confidence ${n.role.confidence})` } : {}),
            ...(n.virtual ? { virtual: true } : {}),
        });
    }
    const resolver = new ImportResolver(result.analyses.values(), result.manifests);
    const out = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const e of graph.edges) {
        out.set(e.source, (out.get(e.source) ?? 0) + 1);
        const list = dependents.get(e.target) ?? [];
        list.push(e.source);
        dependents.set(e.target, list);
    }

    const unresolved: Unresolved[] = [];
    let unresolvedCount = 0;
    let importCount = 0;
    const languages: Record<string, number> = {};
    for (const a of result.analyses.values()) {
        languages[a.language] = (languages[a.language] ?? 0) + 1;
        for (const imp of a.imports) {
            importCount++;
            if (resolver.resolve(imp, a).length > 0) continue;
            unresolvedCount++;
            if (unresolved.length < LIST_LIMIT) unresolved.push({ file: a.filePath, source: imp.source, line: imp.line });
        }
    }

    current = { store, analyses: result.analyses, resolver, dependents, hierarchy: new HierarchyIndex(hierarchy) };
    return {
        name,
        storage,
        discovered: d.discovered,
        stats: {
            files: result.analyses.size,
            symbols: graph.metadata.totalSymbols,
            edges: graph.edges.length,
            imports: importCount,
            unresolved: unresolvedCount,
            components: tree.filter((r) => r.kind === 'component').length,
            hierarchyMs,
            parsed: result.stats.parsed,
            reused: result.stats.reused,
            unchanged: result.stats.unchanged,
            removed: result.stats.removed,
            workers: executor.lastRunWorkers,
            durationMs: result.stats.durationMs,
        },
        languages,
        files: [...result.analyses.values()].slice(0, LIST_LIMIT).map((a) => ({
            path: a.filePath,
            language: a.language,
            symbols: a.symbols.length,
            imports: a.imports.length,
            out: out.get(a.filePath) ?? 0,
            in: dependents.get(a.filePath)?.length ?? 0,
        })),
        edges: graph.edges.slice(0, LIST_LIMIT).map((e): [string, string] => [e.source, e.target]),
        unresolved,
        tree,
    };
}

function fileDetail(path: string): FileDetail | undefined {
    const a = current?.analyses.get(path);
    if (!current || !a) return undefined;
    return {
        path,
        language: a.language,
        parser: a.parser,
        namespace: a.namespace,
        symbols: a.symbols,
        imports: a.imports.map((imp) => ({ source: imp.source, line: imp.line, targets: current!.resolver.resolve(imp, a) })),
        implicit: current.resolver.implicitDependencies(a),
        dependents: [...(current.dependents.get(path) ?? [])].sort(),
    };
}

function search(query: string): SearchHit[] {
    if (!current || !query.trim()) return [];
    return current.store.searchSymbols(query.trim(), 100).map((h) => ({ path: h.path, name: h.name, kind: h.kind, container: h.container, line: h.startLine }));
}

scope.onmessage = async (ev) => {
    const req = ev.data;
    try {
        let result: unknown;
        if (req.type === 'open') result = await open(req.source);
        else if (req.type === 'file') result = fileDetail(req.path);
        else if (req.type === 'view') result = current?.hierarchy.project(req.request);
        else if (req.type === 'explain') result = current?.hierarchy.explainEdge(req.source, req.target);
        else if (req.type === 'children') result = current?.hierarchy.children(req.key);
        else if (req.type === 'describe') result = current?.hierarchy.describe(req.key);
        else result = search(req.query);
        scope.postMessage({ type: 'result', id: req.id, result });
    } catch (err) {
        scope.postMessage({ type: 'error', id: req.id, message: (err as Error).stack ?? String(err) });
    }
};
