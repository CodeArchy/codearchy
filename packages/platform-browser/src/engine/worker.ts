/**
 * The CodeArchy engine as a module Web Worker: every browser host (the PWA,
 * the playground) runs this, and talks to it with WorkerEngine.
 *
 *   open(source)   discover → index (SQLite on OPFS, memory fallback; parse
 *                  workers) → graph → hierarchy; a picked folder can be watched
 *   view, children, describe, explain, search, readFile
 *   storage, storageSettings, storageDelete, storageExport, storageExportFolder
 *                  the indexes this browser keeps (see indexes.ts); these work
 *                  with or without an open workspace
 *   + host-specific handlers (config.handlers), given the open workspace
 *
 * Live updates: FileSystemObserver where the browser has it, otherwise
 * adaptive polling of sizes and modification times. Changed files go through
 * Indexer.update, and a `changed` event tells the UI to refetch in place.
 */
import {
    DEFAULT_EXCLUDE_PATTERNS,
    DEFAULT_LANGUAGE_IDS,
    HierarchyIndex,
    ImportResolver,
    IndexStore,
    Indexer,
    FlowIndex,
    TourIndex,
    isTourFile,
    anchorTour,
    buildGraph,
    buildHierarchy,
    classifyFiles,
    getPackForExtension,
    isManifest,
    isPackageMarker,
    buildArchitecture,
    posixPath,
    readManifests,
    type DiscoveryResult,
    type FileSystemPort,
    type IndexStats,
    type StoragePort,
} from '@codearchy/core';
import type { ArchitectureGraph, EngineEvent, FileAnalysis, SearchResult, Tour, WorkspaceSummary } from '@codearchy/protocol';
import { unzipSync } from 'fflate';
import { HandleFileSystem, MemoryFileSystem, listHandleFiles, type MemoryEntry } from '../fs.js';
import { BrowserWorkerPool, type WorkspaceSource } from '../pool.js';
import { openSqliteWasm, opfsPool, opfsSyncAccessAvailable, type SqlitePool } from '../storage.js';
import { IndexLibrary, type IndexSourceKind } from './indexes.js';
import type { EngineReply, EngineRequest, EngineSource } from './messages.js';
import { downloadRepository } from './repository.js';

export interface EngineWorkerConfig {
    /** Module worker script that calls runBrowserParseWorker(). */
    parseWorkerUrl: string | URL;
    /** Defaults are relative to this worker's own URL. */
    runtimeWasmUrl?: string;
    grammarBaseUrl?: string;
    sqliteWasmUrl?: string;
    /** OPFS pool directory (one per app). */
    poolName?: string;
    maxFileSize?: number;
    workers?: number;
    /** Minimum polling interval when FileSystemObserver isn't available (ms). */
    watchIntervalMs?: number;
    /** Extra requests, answered against the open workspace (e.g. the playground's debug views). */
    handlers?: Record<string, EngineHandler>;
}

export type EngineHandler = (ws: EngineWorkspace, params: Record<string, unknown>, ctx: HandlerContext) => unknown;

/** What a host handler can do besides answering: push its own events to the page (e.g. a streamed answer). */
export interface HandlerContext {
    emit(event: unknown): void;
}

/** The open workspace, as host handlers see it. */
export interface EngineWorkspace {
    name: string;
    storage: 'opfs' | 'memory';
    fs: FileSystemPort;
    store: IndexStore;
    analyses: Map<string, FileAnalysis>;
    manifests: Map<string, string>;
    discovery: DiscoveryResult;
    graph: ArchitectureGraph;
    hierarchy: HierarchyIndex;
    /** Entrypoints and their traces (Flows), built with the hierarchy. */
    flows: FlowIndex;
    /** The Start Here tour and `.codearchy/tours`, built with the hierarchy. */
    tours: TourIndex;
    resolver: ImportResolver;
    stats: IndexStats;
    workers: number;
}

const SKIP_SEGMENTS = new Set(['.git', 'node_modules']);

export function runEngineWorker(config: EngineWorkerConfig): void {
    const scope = self as unknown as { onmessage: ((ev: MessageEvent<EngineRequest>) => void) | null; postMessage(m: EngineReply): void };
    const asset = (p: string) => new URL(p, self.location.href).href;
    const parsers = {
        runtimeWasmUrl: config.runtimeWasmUrl ?? asset('parsers/web-tree-sitter.wasm'),
        grammarBaseUrl: config.grammarBaseUrl ?? asset('parsers/'),
    };
    const sqliteWasmUrl = config.sqliteWasmUrl ?? asset('sqlite3.wasm');
    const maxFileSize = config.maxFileSize ?? 1_000_000;
    // A Map of the handler object's own entries: a request name can never reach
    // Object.prototype (`constructor`, `__proto__`, ...).
    const handlers = new Map(Object.entries(config.handlers ?? {}).filter(([, h]) => typeof h === 'function'));
    const emit = (event: EngineEvent) => scope.postMessage({ event });
    const ctx: HandlerContext = { emit: (hostEvent) => scope.postMessage({ hostEvent }) };

    let ws: (EngineWorkspace & { db: string; port: StoragePort; indexer: Indexer; pool: BrowserWorkerPool; live: boolean; lazy: { hierarchy?: HierarchyIndex; resolver?: ImportResolver } }) | undefined;
    const poolName = config.poolName ?? 'codearchy';
    let poolState: Promise<{ pool?: SqlitePool; reason?: string }> | undefined;
    /** The OPFS pool that keeps the indexes, or why there is none (then they're kept in memory only). */
    const storagePool = () =>
        (poolState ??= (async () => {
            if (!(await opfsSyncAccessAvailable())) return { reason: 'This browser doesn’t let the app keep files here (private browsing, for example): indexes last only while the tab is open.' };
            try {
                return { pool: await opfsPool({ poolName, wasmUrl: sqliteWasmUrl }) };
            } catch {
                return { reason: 'Another CodeArchy tab is using the storage: indexes opened in this tab last only while it’s open.' };
            }
        })());
    const library = new IndexLibrary(poolName, storagePool);
    let stopWatch: (() => void) | undefined;
    let opening = 0;

    const close = () => {
        stopWatch?.();
        stopWatch = undefined;
        ws?.pool.dispose();
        ws?.store.close();
        ws = undefined;
    };

    async function open(source: EngineSource): Promise<WorkspaceSummary> {
        const ticket = ++opening;
        close();
        const { name, fs, paths, workers } = await readSource(source, maxFileSize, {
            // A repository is downloaded first: its own phase, by file (GitHub) or kilobyte (GitLab).
            onProgress: (current, total) => emit({ type: 'progress', phase: 'download', current, total }),
            isCancelled: () => ticket !== opening,
        });
        const discovery = classifyFiles(paths, { languages: DEFAULT_LANGUAGE_IDS, excludePatterns: DEFAULT_EXCLUDE_PATTERNS, maxFiles: 0 }, source.kind);
        const db = indexFileName(name);
        // Another browser's copy in the export folder, if this one has none: unchanged files are then reused.
        await library.beforeOpen(db).catch(() => false);
        const { store, storage, port } = await openStore(db, poolName, sqliteWasmUrl);
        const pool = new BrowserWorkerPool({ ...parsers, workerUrl: config.parseWorkerUrl, source: workers, maxFileSize, ...(config.workers ? { workers: config.workers } : {}) });
        const indexer = new Indexer({ fs, store, executor: pool });
        let last = 0;
        const result = await indexer.index(discovery.sourceFiles, discovery.manifests, {
            onProgress(p) {
                const now = Date.now();
                if (now - last < 100 && p.current !== p.total) return;
                last = now;
                emit({ type: 'progress', phase: p.phase, current: p.current, total: p.total });
            },
            isCancelled: () => ticket !== opening,
        });
        const live = source.kind === 'handle' && !!source.watch;
        const graph = buildGraph(result.analyses.values(), result.manifests);
        const workspace = {
            name,
            db,
            port,
            storage,
            fs,
            store,
            analyses: result.analyses,
            manifests: result.manifests,
            discovery,
            graph,
            stats: result.stats,
            workers: pool.lastRunWorkers,
            indexer,
            pool,
            live,
            lazy: {} as { hierarchy?: HierarchyIndex; flows?: FlowIndex; tours?: TourIndex; resolver?: ImportResolver },
            get hierarchy(): HierarchyIndex {
                this.lazy.hierarchy ??= new HierarchyIndex(buildHierarchy(this.graph, { systemName: name, packageMarkers: this.discovery.packageMarkers, manifests: this.manifests }));
                return this.lazy.hierarchy;
            },
            get flows(): FlowIndex {
                this.lazy.flows ??= new FlowIndex(this.analyses, this.hierarchy);
                return this.lazy.flows;
            },
            get tours(): TourIndex {
                const read = async (p: string) => {
                    try {
                        return await this.fs.readText(p);
                    } catch {
                        return undefined;
                    }
                };
                this.lazy.tours ??= new TourIndex({ index: this.hierarchy, flows: this.flows, files: this.discovery.tours, read, name });
                return this.lazy.tours;
            },
            get resolver(): ImportResolver {
                this.lazy.resolver ??= new ImportResolver(this.analyses.values(), this.manifests);
                return this.lazy.resolver;
            },
        };
        ws = workspace;
        if (storage === 'opfs') {
            void library
                .opened({ db, name, source: SOURCE_KIND[source.kind], ...(source.kind === 'repository' ? { url: source.url } : {}), sizeBytes: indexSize(port), files: result.analyses.size })
                .catch(() => undefined);
        }
        if (live && source.kind === 'handle') stopWatch = watch(source.handle, fs);
        return summarize(workspace);
    }

    function summarize(w: EngineWorkspace & { live: boolean }): WorkspaceSummary {
        const languages: Record<string, number> = {};
        for (const a of w.analyses.values()) languages[a.language] = (languages[a.language] ?? 0) + 1;
        return {
            name: w.name,
            storage: w.storage,
            files: w.analyses.size,
            symbols: w.graph.metadata.totalSymbols,
            edges: w.graph.edges.length,
            discovered: w.discovery.discovered,
            parsed: w.stats.parsed,
            reused: w.stats.reused + w.stats.unchanged,
            durationMs: w.stats.durationMs,
            workers: w.workers,
            languages,
            live: w.live,
        };
    }

    // ── live updates ────────────────────────────────────────────────────────

    function watch(handle: FileSystemDirectoryHandle, fs: FileSystemPort): () => void {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const known = new Map<string, string>();
        const signature = async (p: string) => {
            const st = await fs.stat(p);
            return st ? `${st.size}:${st.mtimeMs ?? 0}` : undefined;
        };
        const tracked = (p: string) => !p.split('/').some((s) => SKIP_SEGMENTS.has(s));

        /** Compares the folder against what was indexed; applies the differences. */
        const scan = async () => {
            const files = (await listHandleFiles(handle)).filter(tracked);
            const d = classifyFiles(files, { languages: DEFAULT_LANGUAGE_IDS, excludePatterns: DEFAULT_EXCLUDE_PATTERNS, maxFiles: 0 }, 'handle');
            const current = new Set([...d.sourceFiles, ...d.manifests, ...d.tours]);
            const changed: string[] = [];
            for (const p of current) {
                const sig = await signature(p);
                if (sig !== undefined && known.get(p) !== sig) changed.push(p);
                if (sig !== undefined) known.set(p, sig);
            }
            const removed = [...known.keys()].filter((p) => !current.has(p));
            for (const p of removed) known.delete(p);
            if (ws) ws.discovery = d;
            return { changed, removed };
        };

        const baseline = (async () => {
            const w = ws;
            if (!w) return;
            for (const p of [...w.discovery.sourceFiles, ...w.discovery.manifests, ...w.discovery.tours]) {
                const sig = await signature(p);
                if (sig !== undefined) known.set(p, sig);
            }
        })();

        let busy = false;
        const sync = async () => {
            if (busy || stopped) return;
            busy = true;
            try {
                await baseline;
                const { changed, removed } = await scan();
                if (!stopped && (changed.length || removed.length)) await apply(changed, removed);
            } finally {
                busy = false;
            }
        };

        const Observer = (self as unknown as { FileSystemObserver?: new (cb: () => void) => { observe(h: FileSystemHandle, o: { recursive: boolean }): Promise<void>; disconnect(): void } }).FileSystemObserver;
        if (Observer) {
            let debounce: ReturnType<typeof setTimeout> | undefined;
            const observer = new Observer(() => {
                clearTimeout(debounce);
                debounce = setTimeout(() => void sync(), 300);
            });
            void observer.observe(handle, { recursive: true }).catch(() => undefined);
            return () => {
                stopped = true;
                clearTimeout(debounce);
                observer.disconnect();
            };
        }
        // Polling: the interval grows with the cost of a scan, so big folders aren't hammered.
        const minInterval = config.watchIntervalMs ?? 2000;
        const loop = async () => {
            const started = Date.now();
            await sync();
            if (!stopped) timer = setTimeout(() => void loop(), Math.max(minInterval, (Date.now() - started) * 5));
        };
        timer = setTimeout(() => void loop(), minInterval);
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    }

    async function apply(changed: string[], removed: string[]): Promise<void> {
        const w = ws;
        if (!w) return;
        const manifestPaths = changed.filter((p) => isManifest(posixPath.basename(p)));
        // Tour files only need the tours rebuilt (below, with the rest of the lazy state).
        const sources = changed.filter((p) => !manifestPaths.includes(p) && !isTourFile(p));
        for (const [p, text] of await readManifests(w.fs, manifestPaths)) {
            w.manifests.set(p, text);
            w.store.putManifest(p, text);
        }
        const gone: string[] = [];
        for (const p of removed) {
            if (w.manifests.delete(p)) w.store.removeManifest(p);
            else if (!isTourFile(p)) gone.push(p);
        }
        if (gone.length) {
            w.indexer.remove(gone);
            for (const p of gone) w.analyses.delete(p);
        }
        for (const [p, analysis] of await w.indexer.update(sources)) {
            if (analysis) w.analyses.set(p, analysis);
            else w.analyses.delete(p);
        }
        w.graph = buildGraph(w.analyses.values(), w.manifests);
        w.lazy = {};
        if (w.storage === 'opfs') void library.changed(w.db, indexSize(w.port), w.analyses.size).catch(() => undefined);
        emit({ type: 'changed', paths: [...changed, ...removed], summary: summarize(w) });
    }

    // ── requests ────────────────────────────────────────────────────────────

    function search(w: EngineWorkspace, query: string): SearchResult[] {
        const q = query.trim().toLowerCase();
        if (!q) return [];
        const out: SearchResult[] = [];
        for (const n of w.hierarchy.hierarchy.nodes) {
            if (n.kind === 'symbol' || n.kind === 'system' || !n.name.toLowerCase().includes(q)) continue;
            out.push({ key: n.key, name: n.name, kind: n.kind === 'module' ? 'file' : n.kind, path: n.path });
            if (out.length >= 15) break;
        }
        for (const h of w.store.searchSymbols(query.trim(), 35)) {
            out.push({ key: `mod:${h.path}`, name: h.container ? `${h.container}.${h.name}` : h.name, kind: h.kind, path: h.path, line: h.startLine });
        }
        return out;
    }

    async function handle(method: string, params: Record<string, unknown>): Promise<unknown> {
        if (method === 'open') return open(params.source as EngineSource);
        if (method === 'close') return close();
        const s = (k: string) => String(params[k] ?? '');
        // The indexes this browser keeps: with or without an open workspace.
        switch (method) {
            case 'storage':
                return library.status(ws?.storage === 'opfs' ? ws.db : undefined);
            case 'storageSettings':
                return library.setSettings(params.settings, ws?.db);
            case 'storageDelete':
                return library.remove(s('db'), ws?.storage === 'opfs' ? ws.db : undefined);
            case 'storageExport':
                return library.exportAll();
            case 'storageExportFolder': {
                const handle = params.handle;
                if (handle !== undefined && handle !== null && (typeof handle !== 'object' || (handle as FileSystemHandle).kind !== 'directory')) throw new Error('"handle" must be a folder');
                return library.setExportFolder((handle ?? undefined) as FileSystemDirectoryHandle | undefined);
            }
        }
        const w = ws;
        if (!w) return undefined;
        switch (method) {
            case 'view':
                return w.hierarchy.project((params.request ?? {}) as Parameters<HierarchyIndex['project']>[0]);
            case 'children':
                return w.hierarchy.children(s('key'));
            case 'describe':
                return w.hierarchy.describe(s('key'));
            case 'explain':
                return w.hierarchy.explainEdge(s('source'), s('target'));
            case 'search':
                return search(w, s('query'));
            case 'flows':
                return w.flows.list();
            case 'flow':
                return w.flows.trace(s('id'));
            case 'tours':
                return w.tours.list();
            case 'architecture':
                return buildArchitecture(w.hierarchy, w.flows);
            case 'tour':
                return w.tours.get(s('id'));
            case 'anchorTour':
                return anchorTour(params.tour as Tour, w.hierarchy, async (p) => {
                    try {
                        return await w.fs.readText(p);
                    } catch {
                        return undefined;
                    }
                });
            case 'readFile':
                return w.fs.readText(s('path'));
            default: {
                const custom = typeof method === 'string' ? handlers.get(method) : undefined;
                if (typeof custom !== 'function') throw new Error(`unknown engine request: ${String(method).slice(0, 60)}`);
                return custom(w, params, ctx);
            }
        }
    }

    scope.onmessage = (ev) => {
        const { id, method, params } = ev.data;
        handle(method, params ?? {}).then(
            (result) => scope.postMessage({ id, result }),
            (err: unknown) =>
                // The message first: Firefox's and WebKit's stacks are only the frames (Chromium's start with the message).
                scope.postMessage({ id, error: err instanceof Error ? [err.message, err.stack?.startsWith(`${err.name}: ${err.message}`) ? err.stack.split('\n').slice(1).join('\n') : err.stack].filter(Boolean).join('\n') : String(err) })
        );
    };
}

// ─── sources and storage ────────────────────────────────────────────────────

async function readSource(
    source: EngineSource,
    maxFileSize: number,
    download: { onProgress(current: number, total: number): void; isCancelled(): boolean }
): Promise<{ name: string; fs: FileSystemPort; paths: string[]; workers: WorkspaceSource }> {
    if (source.kind === 'handle') {
        const paths = (await listHandleFiles(source.handle)).filter((p) => !p.split('/').some((s) => SKIP_SEGMENTS.has(s)));
        return { name: source.handle.name, fs: new HandleFileSystem(source.handle), paths, workers: { kind: 'handle', handle: source.handle } };
    }
    let entries: Array<[string, MemoryEntry]>;
    if (source.kind === 'files') {
        entries = source.files.map(({ path, file }) => [path, { data: file, mtimeMs: file.lastModified }]);
    } else if (source.kind === 'repository') {
        const repo = await downloadRepository(source.url, { maxFileSize, ...download, unzip: (data) => unzipEntries(data, maxFileSize) });
        const mem = new MemoryFileSystem(repo.entries.filter(([p]) => !p.split('/').some((s) => SKIP_SEGMENTS.has(s))));
        return { name: repo.name, fs: mem, paths: mem.paths(), workers: { kind: 'memory', entries: mem.entries() } };
    } else if (source.kind === 'texts') {
        // Fixed mtimes: a sample never changes, so a reload reuses every file by stat.
        entries = Object.entries(source.files).map(([p, text]) => [p, { data: text, mtimeMs: 1 }]);
    } else {
        entries = unzipEntries(new Uint8Array(source.data), maxFileSize);
    }
    const mem = new MemoryFileSystem(entries.filter(([p]) => !p.split('/').some((s) => SKIP_SEGMENTS.has(s))));
    return { name: source.name, fs: mem, paths: mem.paths(), workers: { kind: 'memory', entries: mem.entries() } };
}

/**
 * Files of a zip. Only files that could matter are inflated (sources and
 * package markers under the size limit). A single top folder (GitHub's
 * `repo-<sha>/`) is stripped.
 */
export function unzipEntries(data: Uint8Array, maxFileSize: number): Array<[string, MemoryEntry]> {
    const files = unzipSync(data, {
        filter: (f) => !f.name.endsWith('/') && f.originalSize <= maxFileSize && wanted(f.name),
    });
    const names = Object.keys(files);
    const tops = new Set(names.map((n) => n.split('/')[0]));
    const strip = tops.size === 1 && names.every((n) => n.includes('/')) ? `${[...tops][0]}/` : '';
    return names.map((n) => [n.slice(strip.length), { data: new Blob([files[n] as Uint8Array<ArrayBuffer>]), mtimeMs: 1 }]);
}

function wanted(name: string): boolean {
    const base = posixPath.basename(name);
    if (isManifest(base) || isPackageMarker(base)) return true;
    return getPackForExtension(posixPath.extname(base)) !== undefined;
}

/** The index's file name in the pool for a workspace name. */
export function indexFileName(name: string): string {
    return `${name.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'workspace'}.db`;
}

const SOURCE_KIND: Record<EngineSource['kind'], IndexSourceKind> = { handle: 'folder', files: 'files', zip: 'zip', texts: 'sample', repository: 'repository' };

/** Bytes the index takes on disk. */
function indexSize(port: StoragePort): number {
    const n = (sql: string) => Number(Object.values(port.prepare(sql).get() ?? {})[0] ?? 0);
    try {
        return n('PRAGMA page_count') * n('PRAGMA page_size');
    } catch {
        return 0;
    }
}

async function openStore(dbName: string, poolName: string, wasmUrl: string): Promise<{ store: IndexStore; storage: 'opfs' | 'memory'; port: StoragePort }> {
    if (await opfsSyncAccessAvailable()) {
        try {
            const db = await openSqliteWasm({ mode: 'opfs-sahpool', name: dbName, poolName, wasmUrl });
            return { store: new IndexStore(db), storage: 'opfs', port: db };
        } catch (err) {
            // e.g. another tab holds the pool: index in memory instead.
            console.warn(`OPFS storage unavailable (${(err as Error).message}); indexing in memory`);
        }
    }
    const port = await openSqliteWasm({ mode: 'memory', wasmUrl });
    return { store: new IndexStore(port), storage: 'memory', port };
}
