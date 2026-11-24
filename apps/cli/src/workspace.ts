/**
 * One indexed workspace for the CLI: discovery (git ls-files when available,
 * so .gitignore is honoured), parsing, the hierarchy, deterministic cards and
 * search. A file watcher marks the index stale; the next request rebuilds it,
 * so an agent that edits files keeps seeing the current code.
 */
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AuthorshipIndex, markLines, withLedger, type AuthorshipData, type AuthorshipLedger, buildGraph, buildHierarchy, DEFAULT_EXCLUDE_PATTERNS, DEFAULT_LANGUAGE_IDS, FlowIndex, HierarchyIndex, readManifests, TourIndex, type Analyzer } from '@codearchy/core';
import type { AuthorshipOrigin, AuthorshipStatus } from '@codearchy/protocol';
import { computeGitAuthorship, createNodeAnalyzer, discover, fromPosix, type NodeFileSystem } from '@codearchy/platform-node';
import { MemoryCardStore, NodeSearch, Summarizer, type Card } from '@codearchy/ai';

export interface Snapshot {
    index: HierarchyIndex;
    search: NodeSearch;
    cardFor: (key: string) => Promise<Card | undefined>;
    /** Entrypoints and their traces. */
    flows: FlowIndex;
    /** Start Here and the workspace's `.codearchy/tours`. */
    tours: TourIndex;
    /** Authored tour files (workspace paths). */
    tourFiles: string[];
    files: number;
    symbols: number;
    edges: number;
    /** Source files per language. */
    languageCounts: Record<string, number>;
    /** Authorship from git, filled in the background after the build (see `onAuthorship`). */
    authorship?: AuthorshipIndex;
    authorshipStatus: AuthorshipStatus;
    languages: string[];
    builtAt: number;
    buildMs: number;
}

export interface WorkspaceOptions {
    maxFileSize?: number;
    /** Above this many files, search covers names and paths only (cards would mean reading every file up front). */
    cardSearchLimit?: number;
    log?: (message: string) => void;
    /** Called (with the changed path, when known) whenever a relevant file changes; the next snapshot() rebuilds. */
    onChange?: (file: string | undefined) => void;
    /** Called when a snapshot's authorship is ready (computed from git after each build). */
    onAuthorship?: () => void;
    /** Skip authorship (no git commands at all). */
    noAuthorship?: boolean;
    /** People's review marks and corrections (the Companion keeps it in its data folder); laid over git's evidence. */
    ledger?: AuthorshipLedger;
    /** Called after the ledger changes, to persist it. */
    onLedgerChange?: () => void;
}

/** Changes under these never make the index stale. */
const IGNORED = /(^|[\\/])(\.git|node_modules|dist|out|build|target|\.next|coverage|__pycache__|\.venv|venv)([\\/]|$)/;

export class Workspace {
    private current?: Snapshot;
    private building?: Promise<Snapshot>;
    private stale = true;
    private watcher?: fs.FSWatcher;
    private engine?: Promise<{ analyzer: Analyzer; fs: NodeFileSystem }>;
    /** Deterministic cards survive rebuilds: unchanged inputs hash to the same card. */
    private readonly store = new MemoryCardStore();
    private readonly log: (message: string) => void;

    constructor(
        readonly root: string,
        private readonly options: WorkspaceOptions = {},
    ) {
        this.log = options.log ?? (() => undefined);
    }

    /** The current index, rebuilt first if files changed since it was built. */
    async snapshot(): Promise<Snapshot> {
        if (this.current && !this.stale) return this.current;
        this.building ??= this.build().finally(() => (this.building = undefined));
        return this.building;
    }

    /** Watch for edits (recursive watching works on macOS, Windows and Linux with Node 20+). */
    watch(): void {
        try {
            this.watcher = fs.watch(this.root, { recursive: true }, (_event, file) => {
                if (file && IGNORED.test(String(file))) return;
                this.stale = true;
                this.options.onChange?.(file ? String(file) : undefined);
            });
            this.watcher.on('error', () => this.fallbackToRebuildEachTime());
        } catch {
            this.fallbackToRebuildEachTime();
        }
    }

    close(): void {
        this.watcher?.close();
    }

    /** Reads a workspace file by its POSIX path; never anything outside the root. */
    async readFile(posixPath: string): Promise<string | undefined> {
        const full = fromPosix(this.root, posixPath);
        const rel = path.relative(this.root, full);
        if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
        try {
            return await fsp.readFile(full, 'utf8');
        } catch {
            return undefined;
        }
    }

    private fallbackToRebuildEachTime(): void {
        this.watcher?.close();
        this.watcher = undefined;
        this.log('File watching is unavailable here; the index is rebuilt when it is more than 30 s old.');
        setInterval(() => (this.stale = true), 30_000).unref();
    }

    private async build(): Promise<Snapshot> {
        const started = Date.now();
        this.stale = false; // edits during the build mark it stale again
        this.engine ??= createNodeAnalyzer({ root: this.root, maxFileSize: this.options.maxFileSize ?? 1_000_000 });
        const { analyzer, fs: fsPort } = await this.engine;
        const discovery = await discover(this.root, { languages: DEFAULT_LANGUAGE_IDS, excludePatterns: DEFAULT_EXCLUDE_PATTERNS, maxFiles: 0 });
        const analyses = await analyzer.analyzeAll(discovery.sourceFiles);
        const graph = buildGraph(analyses.values(), await readManifests(fsPort, discovery.manifests), {
            toHostPath: (p) => fromPosix(this.root, p),
        });
        const index = new HierarchyIndex(buildHierarchy(graph, { systemName: path.basename(this.root), packageMarkers: discovery.packageMarkers }));
        const flows = new FlowIndex(analyses, index);
        const languageCounts: Record<string, number> = {};
        let symbols = 0;
        for (const a of analyses.values()) {
            languageCounts[a.language] = (languageCounts[a.language] ?? 0) + 1;
            symbols += a.symbols.length;
        }
        const summarizer = new Summarizer({ index, readFile: (p) => this.readFile(p), store: this.store });
        const cardFor = async (key: string) => (index.node(key) && index.node(key)!.kind !== 'symbol' ? summarizer.card(key) : undefined);
        const files = discovery.sourceFiles.length;
        const search = files <= (this.options.cardSearchLimit ?? 5000) ? await NodeSearch.withCards(index, cardFor) : new NodeSearch(index);
        this.current = {
            index,
            search,
            cardFor,
            flows,
            tours: new TourIndex({ index, flows, files: discovery.tours, read: (p) => this.readFile(p), name: path.basename(this.root) }),
            tourFiles: discovery.tours,
            authorshipStatus: this.options.noAuthorship ? { state: 'unavailable', reason: 'Turned off.' } : { state: 'computing' },
            files,
            symbols,
            edges: graph.edges.length,
            languageCounts,
            languages: graph.metadata.languages,
            builtAt: Date.now(),
            buildMs: Date.now() - started,
        };
        if (!this.options.noAuthorship) {
            const lines = new Map([...analyses].map(([p, a]) => [p, a.lines]));
            void this.traceAuthorship(this.current, lines).catch((err: unknown) => this.log(`Authorship failed: ${err instanceof Error ? err.message : String(err)}`));
        }
        this.log(`Indexed ${files} files in ${this.current.buildMs} ms (${graph.metadata.languages.join(', ') || 'no supported languages'}).`);
        return this.current;
    }

    /** git log + blame for the snapshot just built; the snapshot gets it when done. */
    private async traceAuthorship(snap: Snapshot, lines: Map<string, number | undefined>): Promise<void> {
        const result = await computeGitAuthorship(this.root, lines.keys(), { isCancelled: () => this.current !== snap });
        if (this.current !== snap) return;
        // Files may have changed since the ledger last saw them: re-find its ranges first.
        const ledger = this.options.ledger;
        for (const p of ledger?.paths() ?? []) {
            const text = lines.has(p) ? await this.readFile(p) : undefined;
            if (text === undefined) ledger!.remove(p);
            else ledger!.reconcile(p, text);
        }
        if (ledger?.takeChanged()) this.options.onLedgerChange?.();
        this.authorshipInputs = { snap, lines, data: result.ok ? result.data : undefined };
        if (!result.ok && !ledger?.paths().length) snap.authorshipStatus = { state: 'unavailable', reason: result.reason };
        else this.rebuildAuthorship();
        this.options.onAuthorship?.();
    }

    /** The current snapshot's git evidence, kept so the ledger can be laid over it again after a mark. */
    private authorshipInputs?: { snap: Snapshot; lines: Map<string, number | undefined>; data: AuthorshipData | undefined };

    private rebuildAuthorship(): void {
        const inputs = this.authorshipInputs;
        if (!inputs || inputs.snap !== this.current) return;
        const data = this.options.ledger ? withLedger(inputs.data, this.options.ledger) : inputs.data!;
        inputs.snap.authorship = new AuthorshipIndex(inputs.snap.index, (p) => inputs.lines.get(p), data);
        inputs.snap.authorshipStatus = inputs.snap.authorship.status();
    }

    /** "Mark as reviewed" / "Correct attribution" from the web app (through the Companion). */
    async markAuthorship(path: string, start: number, end: number, as: 'reviewed' | AuthorshipOrigin): Promise<{ marked: number }> {
        const ledger = this.options.ledger;
        const snap = await this.snapshot();
        if (!ledger) throw new Error('Authorship marks are not kept here');
        if (!snap.index.node(`mod:${path}`)) throw new Error(`"${path}" is not an indexed source file`);
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1) throw new Error('start and end must be line numbers');
        const marked = markLines(ledger, snap.authorship?.describe(`mod:${path}`)?.ranges, path, start, end, as);
        const text = await this.readFile(path);
        if (text !== undefined) ledger.reconcile(path, text);
        this.rebuildAuthorship();
        if (ledger.takeChanged()) this.options.onLedgerChange?.();
        this.options.onAuthorship?.();
        return { marked };
    }
}
