/**
 * VS Code composition root for the engine: wires @codearchy/core to the
 * Node adapters (@codearchy/platform-node), maps vscode URIs to the core's
 * workspace-relative POSIX paths, and keeps per-file results so changes on
 * disk are applied incrementally.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    AnalysisCancelledError,
    ArchitectureInference,
    HierarchyIndex,
    FlowIndex,
    IndexStore,
    Indexer,
    buildGraph,
    buildHierarchy,
    classifyFiles,
    compileGlobs,
    getPackForExtension,
    isManifest,
    posixPath,
    readManifests,
    type DiscoveryResult,
    type ParserRuntime,
} from '@codearchy/core';
import {
    NodeFileSystem,
    NodeWorkerPool,
    createNodeParserRuntime,
    fromPosix,
    gitIgnoredPaths,
    gitListFiles,
    openNodeSqlite,
    toPosix,
    walkFiles,
} from '@codearchy/platform-node';
import type { NodeDetails } from '@codearchy/protocol';
import { AnalysisProgress, ArchitectureGraph, ExtensionConfig, FileAnalysis, getConfig } from '../types';

/** Requests the new UI (@codearchy/ui) sends through the webview. */
export type EngineMethod = 'view' | 'children' | 'describe' | 'explain' | 'search' | 'flows' | 'flow';

export interface EngineSearchResult {
    key: string;
    name: string;
    kind: string;
    path: string;
    line?: number;
}

/** Per-workspace state kept between analyses so file changes are incremental. Keys are POSIX paths. */
interface WorkspaceState {
    root: string;
    fs: NodeFileSystem;
    indexer: Indexer;
    pool: NodeWorkerPool;
    /** Persistent index (undefined when node:sqlite is unavailable: VS Code < 1.104). */
    store: IndexStore | undefined;
    analyses: Map<string, FileAnalysis>;
    manifests: Map<string, string>;
    discovery: DiscoveryResult;
}

export class AnalysisPipeline {
    private parser: ParserRuntime | undefined;
    private parserPromise: Promise<ParserRuntime | undefined> | undefined;
    private readonly inference = new ArchitectureInference();
    private state: WorkspaceState | undefined;
    private readonly parsersDir: string;
    private readonly workerScript: string;
    private lastIndexStats: NonNullable<ArchitectureGraph['metadata']['indexStats']> | undefined;
    /** The last graph built, and its hierarchy (built on first use, dropped when the graph changes). */
    private lastGraph: ArchitectureGraph | undefined;
    private hierarchyIndex: HierarchyIndex | undefined;
    private flowIndex: FlowIndex | undefined;

    /**
     * @param storageDir per-workspace storage (context.storageUri) for the persistent index;
     *                   omit to index in memory only.
     */
    constructor(
        extensionPath: string,
        private readonly output?: vscode.OutputChannel,
        private readonly storageDir?: string
    ) {
        this.parsersDir = path.join(extensionPath, 'parsers');
        this.workerScript = path.join(extensionPath, 'dist', 'parseWorker.js');
    }

    async initParser(): Promise<void> {
        await this.getParser();
    }

    isTreeSitterAvailable(): boolean {
        return !!this.parser;
    }

    /** Parser health, for diagnostics and the extension's smoke tests. */
    async parserStatus(): Promise<{ treeSitter: boolean; grammars: string[] }> {
        const parser = await this.getParser();
        return { treeSitter: !!parser, grammars: this.availableGrammars() };
    }

    async analyze(
        workspaceUri: vscode.Uri,
        onProgress: (progress: AnalysisProgress) => void,
        token: vscode.CancellationToken
    ): Promise<ArchitectureGraph> {
        const config = getConfig();
        const root = workspaceUri.fsPath;
        await this.getParser(); // logs parser health once
        const ws = await this.openWorkspace(root, config.maxFileSize);

        onProgress({ phase: 'discovery', current: 0, total: 1, message: 'Discovering files...' });
        const discovery = await this.discover(workspaceUri, config);
        if (token.isCancellationRequested) throw new vscode.CancellationError();
        this.log(
            `discovery (${discovery.method}): ${discovery.sourceFiles.length} source files` +
                (discovery.truncated ? ` of ${discovery.discovered} (limited by codearchy.maxFiles)` : '') +
                `, ${discovery.manifests.length} manifests`
        );

        let result;
        try {
            result = await ws.indexer.index(discovery.sourceFiles, discovery.manifests, {
                isCancelled: () => token.isCancellationRequested,
                onProgress: ({ phase, current, total, path: file }) => {
                    if (phase === 'checking') {
                        onProgress({ phase: 'checking', current, total, message: `Checking for changes (${current}/${total})` });
                    } else if (phase === 'parsing' && (current === total || current % Math.max(1, Math.floor(total / 100)) === 0)) {
                        // Reporting every file floods the progress UI; every 1% is plenty.
                        onProgress({ phase: 'parsing', current, total, message: `Parsing: ${file ?? ''}` });
                    }
                },
            });
        } catch (err) {
            if (err instanceof AnalysisCancelledError) throw new vscode.CancellationError();
            throw err;
        }
        const st = result.stats;
        this.log(
            `index: ${st.parsed} parsed, ${st.reused + st.unchanged} reused (${st.unchanged} re-hashed), ${st.removed} removed ` +
                `in ${st.durationMs} ms` +
                (ws.store ? `; persistent (${ws.store.searchEnabled ? 'FTS5' : 'no FTS5'})` : '; in memory (node:sqlite unavailable)') +
                `; ${ws.pool.lastRunWorkers ? `${ws.pool.lastRunWorkers} parse workers` : 'parsed in-process'}`
        );

        this.state = { ...ws, analyses: result.analyses, manifests: result.manifests, discovery };
        this.lastIndexStats = {
            parsed: st.parsed,
            reused: st.reused + st.unchanged,
            removed: st.removed,
            durationMs: st.durationMs,
            persistent: !!ws.store,
            workers: ws.pool.lastRunWorkers,
        };
        onProgress({ phase: 'graphing', current: 0, total: 1, message: 'Building dependency graph...' });
        const graph = this.buildGraph();
        onProgress({ phase: 'complete', current: 1, total: 1, message: 'Analysis complete.' });
        return graph;
    }

    /**
     * Applies created/changed/deleted files (from saves, agents, `git pull`...)
     * and rebuilds the graph, edges included. Returns undefined when nothing
     * relevant changed or no analysis has run yet.
     */
    async applyChanges(changed: vscode.Uri[], deleted: vscode.Uri[]): Promise<ArchitectureGraph | undefined> {
        const state = this.state;
        if (!state) return undefined;
        const config = getConfig();
        const languages = new Set(config.includedLanguages);
        const isExcluded = compileGlobs(config.excludePatterns);
        let dirty = false;

        const rel = (uri: vscode.Uri): string | undefined => toPosix(state.root, uri.fsPath) || undefined;
        const relevant = (p: string): 'source' | 'manifest' | undefined => {
            if (isExcluded(p) || p.split('/').includes('.git')) return undefined;
            if (isManifest(posixPath.basename(p))) return 'manifest';
            const pack = getPackForExtension(posixPath.extname(p));
            return pack && languages.has(pack.id) ? 'source' : undefined;
        };

        for (const uri of deleted) {
            const p = rel(uri);
            if (!p) continue;
            if (state.manifests.delete(p)) {
                state.store?.removeManifest(p);
                dirty = true;
                continue;
            }
            // A file, or a deleted directory (which arrives as one event).
            const gone = state.analyses.has(p) ? [p] : [...state.analyses.keys()].filter((k) => k.startsWith(`${p}/`));
            if (gone.length) {
                for (const k of gone) state.analyses.delete(k);
                state.indexer.remove(gone);
                dirty = true;
            }
        }

        // A new directory (mkdir + writes, git checkout, unzip) can reach us as one
        // event for the directory alone: on Linux the watcher may miss files
        // created inside it before it starts watching it. List such directories.
        const changedSet = new Set<string>();
        for (const p of changed.map(rel)) {
            if (!p) continue;
            if (!relevant(p) && !isExcluded(p) && !p.split('/').includes('.git')) {
                const st = await state.fs.stat(p);
                if (st && !st.isFile) {
                    for (const f of await walkFiles(state.root, p)) changedSet.add(f);
                    continue;
                }
            }
            changedSet.add(p);
        }
        const changedPaths = [...changedSet];
        // Full discovery honours .gitignore; apply the same rule to files that
        // appear later (build output, generated code), or they'd leak in.
        const fresh = changedPaths.filter((p) => !state.analyses.has(p) && relevant(p) === 'source');
        const ignored =
            state.discovery.method === 'git' && fresh.length > 0 ? await gitIgnoredPaths(state.root, fresh) : new Set<string>();

        const sources: string[] = [];
        for (const p of changedPaths) {
            const kind = relevant(p);
            if (!kind || ignored.has(p)) continue;
            if (kind === 'manifest') {
                const text = (await readManifests(state.fs, [p])).get(p);
                if (text !== undefined) {
                    state.manifests.set(p, text);
                    state.store?.putManifest(p, text);
                }
                dirty = true;
                continue;
            }
            const isNew = !state.analyses.has(p);
            if (isNew && config.maxFiles > 0 && state.analyses.size + sources.length >= config.maxFiles) continue;
            sources.push(p);
        }
        // Re-checked through the indexer so the persistent index stays current too.
        for (const [p, analysis] of await state.indexer.update(sources)) {
            if (analysis) state.analyses.set(p, analysis);
            else state.analyses.delete(p);
            dirty = true;
        }

        return dirty ? this.buildGraph() : undefined;
    }

    dispose(): void {
        this.closeWorkspace();
        this.parser?.dispose();
        this.parser = undefined;
    }

    /** Store, worker pool and indexer for a workspace root (reused across analyses of the same root). */
    private async openWorkspace(root: string, maxFileSize: number): Promise<Omit<WorkspaceState, 'analyses' | 'manifests' | 'discovery'>> {
        if (this.state && this.state.root === root) {
            const { fs: fsPort, indexer, pool, store } = this.state;
            return { root, fs: fsPort, indexer, pool, store };
        }
        this.closeWorkspace();
        const fsPort = new NodeFileSystem(root);
        let store: IndexStore | undefined;
        if (this.storageDir) {
            try {
                const db = await openNodeSqlite({ file: path.join(this.storageDir, 'codearchy-index.db') });
                if (db) {
                    store = new IndexStore(db);
                    if (store.wasReset) this.log('index format changed; rebuilt the persistent index');
                }
            } catch (err) {
                this.log(`persistent index unavailable (${(err as Error).message}); indexing in memory`);
            }
        }
        const pool = new NodeWorkerPool({
            root,
            maxFileSize,
            grammarDir: this.parsersDir,
            runtimeWasmPath: path.join(this.parsersDir, 'web-tree-sitter.wasm'),
            workerScript: this.workerScript,
            // Tests lower the threshold so the bundled worker runs on small fixtures.
            minJobsForWorkers: Number(process.env.CODEARCHY_MIN_FILES_FOR_WORKERS) || undefined,
            log: (m) => this.log(m),
        });
        const indexer = new Indexer({ fs: fsPort, store, executor: pool });
        return { root, fs: fsPort, indexer, pool, store };
    }

    private closeWorkspace(): void {
        this.state?.pool.dispose();
        this.state?.store?.close();
        this.state = undefined;
    }

    private buildGraph(): ArchitectureGraph {
        const state = this.state!;
        let graph = buildGraph(state.analyses.values(), state.manifests, { toHostPath: (p) => fromPosix(state.root, p) });
        graph = this.inference.inferSubsystems(graph);
        graph.metadata = {
            ...graph.metadata,
            projectId: state.root,
            projectName: path.basename(state.root),
            projectPath: state.root,
            discoveredFiles: state.discovery.discovered,
            ...(state.discovery.truncated ? { truncatedAt: state.discovery.sourceFiles.length } : {}),
            ...(this.lastIndexStats ? { indexStats: this.lastIndexStats } : {}),
        };
        const stats = graph.metadata.parserStats;
        if (stats) stats.skipped = Math.max(0, state.discovery.sourceFiles.length - state.analyses.size);
        this.lastGraph = graph;
        this.hierarchyIndex = undefined;
        this.flowIndex = undefined;
        return graph;
    }

    /** The hierarchy of the last graph (System › Package › Component › Module › Symbol). */
    private hierarchy(): HierarchyIndex | undefined {
        const state = this.state;
        if (!state || !this.lastGraph) return undefined;
        this.hierarchyIndex ??= new HierarchyIndex(
            buildHierarchy(this.lastGraph, { systemName: path.basename(state.root), packageMarkers: state.discovery.packageMarkers, manifests: state.manifests })
        );
        return this.hierarchyIndex;
    }

    /** Answers the new UI's engine requests (EngineClient in @codearchy/ui). */
    engine(method: EngineMethod, params: Record<string, unknown>): unknown {
        const h = this.hierarchy();
        if (!h) return undefined;
        const str = (k: string) => String(params[k] ?? '');
        switch (method) {
            case 'view':
                return h.project((params.request ?? {}) as Parameters<HierarchyIndex['project']>[0]);
            case 'children':
                return h.children(str('key'));
            case 'describe':
                return h.describe(str('key'));
            case 'explain':
                return h.explainEdge(str('source'), str('target'));
            case 'search':
                return this.search(h, str('query'));
            case 'flows':
                return this.flows(h).list();
            case 'flow':
                return this.flows(h).trace(str('id'));
            default:
                return undefined;
        }
    }

    /** Entrypoints and their traces (Flows mode), rebuilt with the hierarchy. */
    private flows(h: HierarchyIndex): FlowIndex {
        this.flowIndex ??= new FlowIndex(this.state!.analyses, h);
        return this.flowIndex;
    }

    /** Components and packages by name, then symbols from the index (prefix match). */
    private search(h: HierarchyIndex, query: string): EngineSearchResult[] {
        const q = query.trim().toLowerCase();
        if (!q) return [];
        const out: EngineSearchResult[] = [];
        for (const n of h.hierarchy.nodes) {
            if (n.kind === 'symbol' || n.kind === 'system' || !n.name.toLowerCase().includes(q)) continue;
            out.push({ key: n.key, name: n.name, kind: n.kind === 'module' ? 'file' : n.kind, path: n.path });
            if (out.length >= 15) break;
        }
        for (const hit of this.state?.store?.searchSymbols(query.trim(), 35) ?? []) {
            out.push({ key: `mod:${hit.path}`, name: hit.container ? `${hit.container}.${hit.name}` : hit.name, kind: hit.kind, path: hit.path, line: hit.startLine });
        }
        return out;
    }

    /** Where a workspace file sits in the hierarchy (status bar, CodeLens); undefined if it isn't indexed. */
    locate(fsPath: string): NodeDetails | undefined {
        const state = this.state;
        if (!state) return undefined;
        const rel = toPosix(state.root, fsPath);
        return rel ? this.hierarchy()?.describe(`mod:${rel}`) : undefined;
    }

    /** Absolute path of a workspace-relative POSIX path. */
    toAbsolute(rel: string): string | undefined {
        return this.state ? fromPosix(this.state.root, rel) : undefined;
    }

    /** The current hierarchy, for the AI host (it changes as files change). */
    currentIndex(): HierarchyIndex | undefined {
        return this.hierarchy();
    }

    /** Reads a workspace file by its POSIX path; never anything outside the workspace. */
    async readWorkspaceFile(rel: string): Promise<string | undefined> {
        const state = this.state;
        if (!state) return undefined;
        const abs = fromPosix(state.root, rel);
        const inside = path.relative(state.root, abs);
        if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return undefined;
        try {
            return await fs.promises.readFile(abs, 'utf8');
        } catch {
            return undefined;
        }
    }

    private async discover(workspaceUri: vscode.Uri, config: ExtensionConfig): Promise<DiscoveryResult> {
        const options = {
            languages: config.includedLanguages,
            excludePatterns: config.excludePatterns,
            maxFiles: config.maxFiles,
        };
        const root = workspaceUri.fsPath;
        const viaGit = await gitListFiles(root);
        if (viaGit) return classifyFiles(viaGit, options, 'git');

        // Not a git repo (or no git): let VS Code walk the tree, without a cap.
        const exclude = config.excludePatterns.length > 0 ? `{${config.excludePatterns.join(',')}}` : undefined;
        const uris = await vscode.workspace.findFiles(
            new vscode.RelativePattern(workspaceUri, '**/*'),
            exclude ? new vscode.RelativePattern(workspaceUri, exclude) : undefined
        );
        const relative = uris.map((u) => toPosix(root, u.fsPath)).filter((p): p is string => !!p);
        return classifyFiles(relative, options, 'walk');
    }

    /** The tree-sitter runtime + grammars bundled in parsers/ (shared by all workspaces). */
    private getParser(): Promise<ParserRuntime | undefined> {
        if (!this.parserPromise) {
            this.parserPromise = createNodeParserRuntime(
                {
                    grammarDir: this.parsersDir,
                    runtimeWasmPath: path.join(this.parsersDir, 'web-tree-sitter.wasm'),
                },
                (m) => this.log(m)
            ).then((parser) => {
                this.parser = parser;
                this.log(
                    parser
                        ? `tree-sitter ready; grammars: ${this.availableGrammars().join(', ') || 'none'}`
                        : 'tree-sitter unavailable; using regex fallback for all languages'
                );
                return parser;
            });
        }
        return this.parserPromise;
    }

    private availableGrammars(): string[] {
        try {
            return fs.readdirSync(this.parsersDir).filter((f) => f.startsWith('tree-sitter-') && f.endsWith('.wasm'));
        } catch {
            return [];
        }
    }

    private log(message: string) {
        this.output?.appendLine(`[${new Date().toISOString()}] ${message}`);
    }
}
