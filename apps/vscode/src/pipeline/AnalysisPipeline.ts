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
    TourIndex,
    AuthorshipIndex,
    AuthorshipLedger,
    Analyzer,
    renderBranchReport,
    withLedger,
    markLines,
    type LineEdit,
    isTourFile,
    type AuthorshipData,
    anchorTour,
    serializeTour,
    TOURS_DIR,
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
    computeGitAuthorship,
    writeAuthorshipNote,
    computeBranchReport,
    type NoteWriteResult,
    FileLedgerStore,
    AgentLogIngester,
    AGENT_IDS,
    gitListFiles,
    openNodeSqlite,
    toPosix,
    walkFiles,
} from '@codearchy/platform-node';
import type { AuthorshipOrigin, AuthorshipRange, AuthorshipStatus, NodeDetails, Tour, View } from '@codearchy/protocol';
import { AnalysisProgress, ArchitectureGraph, ExtensionConfig, FileAnalysis, getConfig } from '../types';

/** Requests the new UI (@codearchy/ui) sends through the webview. */
export type EngineMethod = 'view' | 'children' | 'describe' | 'explain' | 'search' | 'flows' | 'flow' | 'tours' | 'tour' | 'anchorTour' | 'saveTour' | 'authorshipStatus' | 'authorship' | 'authorshipMark';

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
    private tourIndex: TourIndex | undefined;
    /** Authorship from git: computed in the background after indexing, refreshed after changes. */
    private authorshipData: AuthorshipData | undefined;
    private authorshipIndex: AuthorshipIndex | undefined;
    private authorshipState: AuthorshipStatus = { state: 'computing' };
    private authorshipRun = 0;
    private authorshipTimer: NodeJS.Timeout | undefined;
    /** Called when authorship (re)computes or the ledger changes, so views and the gutter refresh. */
    onAuthorshipChange: (() => void) | undefined;
    /** Ranges captured in the editor, plus people's review marks and corrections (kept in workspace storage). */
    private readonly ledgerStore: FileLedgerStore | undefined;
    readonly ledger: AuthorshipLedger;
    private ledgerTimer: NodeJS.Timeout | undefined;
    /** Agents' session logs (opt-in per agent: codearchy.authorship.agentLogs). */
    private agentLogs: { key: string; ingester: AgentLogIngester } | undefined;
    /** Analyses files as they were at a branch's base (the branch report). */
    private reportAnalyzer: { fs: NodeFileSystem; analyzer: Analyzer } | undefined;

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
        this.ledgerStore = storageDir ? new FileLedgerStore(path.join(storageDir, 'authorship-ledger.json')) : undefined;
        this.ledger = this.ledgerStore?.ledger ?? new AuthorshipLedger();
    }

    async initParser(): Promise<void> {
        await this.getParser();
    }

    isTreeSitterAvailable(): boolean {
        return !!this.parser;
    }

    /** Jobs the bundled parse workers have completed (diagnostics and the extension's tests). */
    workerJobs(): number {
        return this.state?.pool.workerJobs ?? 0;
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
        this.authorshipState = { state: 'computing' };
        this.refreshAuthorship();
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

        // Authored tours: keep the list current (a deleted folder takes its tours with it); content is read when asked for.
        const tours = new Set(state.discovery.tours);
        for (const uri of deleted) {
            const p = rel(uri);
            if (!p) continue;
            for (const t of [...tours]) {
                if (t === p || t.startsWith(`${p}/`)) {
                    tours.delete(t);
                    dirty = true;
                }
            }
        }

        for (const uri of deleted) {
            const p = rel(uri);
            if (!p) continue;
            for (const k of this.ledger.paths()) if (k === p || k.startsWith(`${p}/`)) this.ledger.remove(k);
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
        for (const p of changedPaths) {
            if (isTourFile(p)) {
                tours.add(p);
                dirty = true;
            }
        }
        state.discovery = { ...state.discovery, tours: [...tours].sort() };
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

        // Files changed outside the editor: re-find the ledger's ranges in their new text.
        for (const p of changedPaths) {
            if (!this.ledger.ranges(p).length) continue;
            const text = await this.readWorkspaceFile(p);
            if (text !== undefined) this.reconcile(p, text);
        }
        if (!dirty) return undefined;
        // Edits move lines and commits add history: re-trace once things settle.
        this.refreshAuthorship(5000);
        return this.buildGraph();
    }

    dispose(): void {
        clearTimeout(this.authorshipTimer);
        clearTimeout(this.ledgerTimer);
        this.ledgerStore?.flush();
        this.authorshipRun++; // cancels a run in flight
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
        this.tourIndex = undefined;
        this.authorshipIndex = undefined;
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
            case 'view': {
                const v: View = h.project((params.request ?? {}) as Parameters<HierarchyIndex['project']>[0]);
                const a = this.authorship(h);
                return a ? a.decorate(v) : v;
            }
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
            case 'tours':
                return this.tours(h).list();
            case 'tour':
                return this.tours(h).get(str('id'));
            case 'anchorTour':
                return anchorTour(params.tour as Tour, h, (p) => this.readWorkspaceFile(p));
            case 'saveTour':
                return this.saveTour(h, params.tour as Tour);
            case 'authorshipStatus':
                return this.authorship(h)?.status() ?? this.authorshipState;
            case 'authorship':
                return this.authorship(h)?.describe(str('key'));
            case 'authorshipMark':
                return this.mark(str('path'), Number(params.start), Number(params.end), str('as') as 'reviewed' | AuthorshipOrigin);
            default:
                return undefined;
        }
    }

    /** Entrypoints and their traces (Flows mode), rebuilt with the hierarchy. */
    private flows(h: HierarchyIndex): FlowIndex {
        this.flowIndex ??= new FlowIndex(this.state!.analyses, h);
        return this.flowIndex;
    }

    /** The Start Here tour and the workspace's `.codearchy/tours`, rebuilt with the hierarchy. */
    private tours(h: HierarchyIndex): TourIndex {
        const state = this.state!;
        this.tourIndex ??= new TourIndex({
            index: h,
            flows: this.flows(h),
            files: state.discovery.tours,
            read: (p) => this.readWorkspaceFile(p),
            name: path.basename(state.root),
        });
        return this.tourIndex;
    }

    /** The authorship index over the current hierarchy (rebuilt from the last git data). */
    private authorship(h: HierarchyIndex): AuthorshipIndex | undefined {
        const state = this.state;
        if (!state || (!this.authorshipData && this.ledger.paths().length === 0)) return undefined;
        // The ledger (editor capture, reviews, corrections) over git's evidence, or alone without git.
        this.authorshipIndex ??= new AuthorshipIndex(h, (p) => state.analyses.get(p)?.lines, withLedger(this.authorshipData, this.ledger));
        return this.authorshipIndex;
    }

    // ── the ledger ───────────────────────────────────────────────────────────

    /** An edit captured in the editor (see authorship/capture.ts). */
    recordEdit(rel: string, edit: LineEdit): void {
        this.ledger.applyEdit(rel, edit);
        this.ledgerChanged();
    }

    /** The file's text as saved: refresh the ranges' anchors (and re-find any that moved). */
    reconcile(rel: string, text: string): void {
        if (!this.ledger.ranges(rel).length) return;
        this.ledger.reconcile(rel, text);
        this.ledgerChanged();
    }

    /** "Mark as reviewed" / "Correct attribution" for lines of a file. */
    async mark(rel: string, start: number, end: number, as: 'reviewed' | AuthorshipOrigin): Promise<{ marked: number }> {
        const h = this.hierarchy();
        const marked = markLines(this.ledger, (h && this.authorship(h)?.describe(`mod:${rel}`)?.ranges) ?? undefined, rel, start, end, as);
        const text = await this.readWorkspaceFile(rel);
        if (text !== undefined) this.ledger.reconcile(rel, text);
        this.ledgerChanged(0);
        return { marked };
    }

    /**
     * Writes the ledger's ranges for a commit's changed files as its authorship
     * note (refs/notes/codearchy-authorship). Never pushes.
     */
    async writeNote(commit = 'HEAD'): Promise<NoteWriteResult | undefined> {
        const state = this.state;
        if (!state) return undefined;
        const result = await writeAuthorshipNote(state.root, (rel) => this.ledger.ranges(rel), (rel) => this.readWorkspaceFile(rel), commit);
        this.log(`authorship note: ${result.files.length} file(s) written to ${result.commit.slice(0, 7)}${result.skipped.length ? `, ${result.skipped.length} skipped (changed since the commit)` : ''}`);
        if (result.files.length) this.refreshAuthorship(500);
        return result;
    }

    /** What the current branch adds since `base`, by who wrote it, as Markdown (and the data behind it). */
    async branchReport(base?: string): Promise<string | undefined> {
        const state = this.state;
        const h = this.hierarchy();
        if (!state || !h) return undefined;
        // One analyzer for base versions of files, kept: disposing it would tear down the shared parser runtime.
        const parser = await this.getParser();
        if (this.reportAnalyzer?.fs !== state.fs) this.reportAnalyzer = { fs: state.fs, analyzer: new Analyzer({ fs: state.fs, parser, maxFileSize: getConfig().maxFileSize }) };
        const analyzer = this.reportAnalyzer.analyzer;
        const report = await computeBranchReport({
            root: state.root,
            ...(base ? { base } : {}),
            index: h,
            rangesFor: (rel) => this.authorship(h)?.describe(`mod:${rel}`)?.ranges ?? [],
            analyses: state.analyses,
            manifests: state.manifests,
            analyze: (rel, text) => analyzer.analyzeFile(rel, text),
            read: (rel) => this.readWorkspaceFile(rel),
        });
        return renderBranchReport(report);
    }

    /** A file's attributed ranges for the editor gutter, with what the hover says about each. */
    fileAuthorship(rel: string): Array<AuthorshipRange & { time?: number; subject?: string }> {
        const h = this.hierarchy();
        const ranges = (h && this.authorship(h)?.describe(`mod:${rel}`)?.ranges) ?? [];
        const commits = this.authorshipData?.commits;
        const ledger = this.ledger.ranges(rel);
        return ranges.map((r) => {
            const c = r.commit ? commits?.get(r.commit) : undefined;
            const l = ledger.find((x) => x.start <= r.start && x.end >= r.end && x.origin === r.origin);
            return { ...r, ...(c ? { time: c.time, subject: c.subject } : l ? { time: l.time } : {}) };
        });
    }

    private ledgerChanged(delayMs = 400): void {
        this.ledgerStore?.changed();
        this.authorshipIndex = undefined;
        clearTimeout(this.ledgerTimer);
        this.ledgerTimer = setTimeout(() => this.onAuthorshipChange?.(), delayMs);
    }

    /**
     * Recomputes authorship from git in the background (a newer run cancels an
     * older one). `delayMs` lets a burst of file changes settle first.
     */
    refreshAuthorship(delayMs = 0): void {
        clearTimeout(this.authorshipTimer);
        this.authorshipTimer = setTimeout(() => void this.computeAuthorship(), delayMs);
    }

    private async computeAuthorship(): Promise<void> {
        const state = this.state;
        if (!state) return;
        if (!vscode.workspace.getConfiguration('codearchy').get<boolean>('authorship.enabled', true)) {
            this.authorshipData = undefined;
            this.authorshipIndex = undefined;
            this.authorshipState = { state: 'unavailable', reason: 'Turned off (codearchy.authorship.enabled).' };
            return;
        }
        const run = ++this.authorshipRun;
        const started = Date.now();
        await this.readAgentLogs(state.root);
        if (run !== this.authorshipRun || state !== this.state) return;
        const result = await computeGitAuthorship(state.root, state.analyses.keys(), { isCancelled: () => run !== this.authorshipRun });
        if (run !== this.authorshipRun || state !== this.state) return;
        if (!result.ok) {
            this.authorshipData = undefined;
            this.authorshipState = { state: 'unavailable', reason: result.reason };
        } else {
            this.authorshipData = result.data;
            const s = result.data.stats;
            this.log(`authorship: ${s.aiCommits} of ${s.commits} commits carry AI markers; ${s.blamedFiles} files traced in ${Date.now() - started} ms${result.truncated ? ' (file limit reached)' : ''}`);
        }
        this.authorshipIndex = undefined;
        this.onAuthorshipChange?.();
    }

    /**
     * The opted-in agents' session logs → the ledger (verified ranges). Only
     * counts are logged; nothing from the conversations is kept or shown.
     */
    private async readAgentLogs(root: string): Promise<void> {
        const agents = vscode.workspace
            .getConfiguration('codearchy')
            .get<string[]>('authorship.agentLogs', [])
            .filter((a): a is (typeof AGENT_IDS)[number] => (AGENT_IDS as string[]).includes(a));
        if (!agents.length) {
            this.agentLogs = undefined;
            return;
        }
        const key = `${root}|${agents.join(',')}`;
        if (this.agentLogs?.key !== key) this.agentLogs = { key, ingester: new AgentLogIngester(root, { agents }) };
        try {
            const reports = await this.agentLogs.ingester.run(this.ledger, (p) => this.readWorkspaceFile(p));
            this.ledgerStore?.changed();
            this.authorshipIndex = undefined;
            for (const r of reports) {
                this.log(`agent logs (${r.agent}): ${r.logs} log(s), ${r.edits} edit(s) to this workspace, lines placed in ${r.files} file(s)${r.skipped ? `; ${r.skipped} entries not understood (the log format may have changed)` : ''}${r.tooLarge ? `; ${r.tooLarge} log(s) too large to read` : ''}`);
            }
        } catch (err) {
            this.log(`agent logs: couldn't read them (${err instanceof Error ? err.message : String(err)})`);
        }
    }

    /** Writes an authored tour to `.codearchy/tours/<slug>.json` (anchored, validated) and lists it. */
    private async saveTour(h: HierarchyIndex, tour: Tour): Promise<{ file: string }> {
        const state = this.state!;
        const anchored = await anchorTour({ ...tour, origin: 'authored' }, h, (p) => this.readWorkspaceFile(p));
        let out = serializeTour(anchored);
        if (!out.ok) throw new Error(`The tour isn't valid: ${out.error}`);
        // A new tour never overwrites another one that happens to share its name.
        if (tour.id === 'draft') {
            const base = out.slug;
            for (let n = 2; fs.existsSync(fromPosix(state.root, `${TOURS_DIR}/${out.slug}.json`)); n++) {
                out = serializeTour(anchored, `${base}-${n}`);
                if (!out.ok) throw new Error(`The tour isn't valid: ${out.error}`);
            }
        }
        const file = `${TOURS_DIR}/${out.slug}.json`;
        const abs = fromPosix(state.root, file);
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await fs.promises.writeFile(abs, out.text, 'utf8');
        if (!state.discovery.tours.includes(file)) state.discovery = { ...state.discovery, tours: [...state.discovery.tours, file].sort() };
        this.tourIndex = undefined;
        return { file };
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
    /** A file's workspace-relative POSIX path (any file in the workspace), or undefined outside it. */
    relativePath(fsPath: string): string | undefined {
        const state = this.state;
        if (!state) return undefined;
        const rel = toPosix(state.root, fsPath);
        return rel && !rel.startsWith('..') ? rel : undefined;
    }

    toAbsolute(rel: string): string | undefined {
        return this.state ? fromPosix(this.state.root, rel) : undefined;
    }

    /** The current hierarchy, for the AI host (it changes as files change). */
    currentIndex(): HierarchyIndex | undefined {
        return this.hierarchy();
    }

    /** Entrypoints and flows for the current index. */
    currentFlows(): FlowIndex | undefined {
        const h = this.hierarchy();
        return h ? this.flows(h) : undefined;
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
