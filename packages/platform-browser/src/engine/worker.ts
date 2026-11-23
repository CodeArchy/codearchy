/**
 * The CodeArchy engine as a module Web Worker: every browser host (the PWA,
 * the playground) runs this, and talks to it with WorkerEngine.
 *
 *   open(source)   discover → index (SQLite on OPFS, memory fallback; parse
 *                  workers) → graph → hierarchy; a picked folder can be watched
 *   view, children, describe, explain, search, readFile
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
    buildGraph,
    buildHierarchy,
    classifyFiles,
    getPackForExtension,
    isManifest,
    isPackageMarker,
    posixPath,
    readManifests,
    type DiscoveryResult,
    type FileSystemPort,
    type IndexStats,
} from '@codearchy/core';
import type { ArchitectureGraph, EngineEvent, FileAnalysis, SearchResult, WorkspaceSummary } from '@codearchy/protocol';
import { unzipSync } from 'fflate';
import { HandleFileSystem, MemoryFileSystem, listHandleFiles, type MemoryEntry } from '../fs.js';
import { BrowserWorkerPool, type WorkspaceSource } from '../pool.js';
import { openSqliteWasm, opfsSyncAccessAvailable } from '../storage.js';
import type { EngineReply, EngineRequest, EngineSource } from './messages.js';

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

    let ws: (EngineWorkspace & { indexer: Indexer; pool: BrowserWorkerPool; live: boolean; lazy: { hierarchy?: HierarchyIndex; resolver?: ImportResolver } }) | undefined;
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
        const { name, fs, paths, workers } = await readSource(source, maxFileSize);
        const discovery = classifyFiles(paths, { languages: DEFAULT_LANGUAGE_IDS, excludePatterns: DEFAULT_EXCLUDE_PATTERNS, maxFiles: 0 }, source.kind);
        const { store, storage } = await openStore(name, config.poolName ?? 'codearchy', sqliteWasmUrl);
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
            lazy: {} as { hierarchy?: HierarchyIndex; resolver?: ImportResolver },
            get hierarchy(): HierarchyIndex {
                this.lazy.hierarchy ??= new HierarchyIndex(buildHierarchy(this.graph, { systemName: name, packageMarkers: this.discovery.packageMarkers, manifests: this.manifests }));
                return this.lazy.hierarchy;
            },
            get resolver(): ImportResolver {
                this.lazy.resolver ??= new ImportResolver(this.analyses.values(), this.manifests);
                return this.lazy.resolver;
            },
        };
        ws = workspace;
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
            const current = new Set([...d.sourceFiles, ...d.manifests]);
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
            for (const p of [...w.discovery.sourceFiles, ...w.discovery.manifests]) {
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
        const sources = changed.filter((p) => !manifestPaths.includes(p));
        for (const [p, text] of await readManifests(w.fs, manifestPaths)) {
            w.manifests.set(p, text);
            w.store.putManifest(p, text);
        }
        const gone: string[] = [];
        for (const p of removed) {
            if (w.manifests.delete(p)) w.store.removeManifest(p);
            else gone.push(p);
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
        const w = ws;
        if (!w) return undefined;
        const s = (k: string) => String(params[k] ?? '');
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
            (err: unknown) => scope.postMessage({ id, error: err instanceof Error ? (err.stack ?? err.message) : String(err) })
        );
    };
}

// ─── sources and storage ────────────────────────────────────────────────────

async function readSource(source: EngineSource, maxFileSize: number): Promise<{ name: string; fs: FileSystemPort; paths: string[]; workers: WorkspaceSource }> {
    if (source.kind === 'handle') {
        const paths = (await listHandleFiles(source.handle)).filter((p) => !p.split('/').some((s) => SKIP_SEGMENTS.has(s)));
        return { name: source.handle.name, fs: new HandleFileSystem(source.handle), paths, workers: { kind: 'handle', handle: source.handle } };
    }
    let entries: Array<[string, MemoryEntry]>;
    if (source.kind === 'files') {
        entries = source.files.map(({ path, file }) => [path, { data: file, mtimeMs: file.lastModified }]);
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

async function openStore(name: string, poolName: string, wasmUrl: string): Promise<{ store: IndexStore; storage: 'opfs' | 'memory' }> {
    const dbName = `${name.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'workspace'}.db`;
    if (await opfsSyncAccessAvailable()) {
        try {
            const db = await openSqliteWasm({ mode: 'opfs-sahpool', name: dbName, poolName, wasmUrl });
            return { store: new IndexStore(db), storage: 'opfs' };
        } catch (err) {
            // e.g. another tab holds the pool: index in memory instead.
            console.warn(`OPFS storage unavailable (${(err as Error).message}); indexing in memory`);
        }
    }
    return { store: new IndexStore(await openSqliteWasm({ mode: 'memory', wasmUrl })), storage: 'memory' };
}
