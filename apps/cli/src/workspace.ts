/**
 * One indexed workspace for the CLI: discovery (git ls-files when available,
 * so .gitignore is honoured), parsing, the hierarchy, deterministic cards and
 * search. A file watcher marks the index stale; the next request rebuilds it,
 * so an agent that edits files keeps seeing the current code.
 */
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildGraph, buildHierarchy, DEFAULT_EXCLUDE_PATTERNS, DEFAULT_LANGUAGE_IDS, HierarchyIndex, readManifests, type Analyzer } from '@codearchy/core';
import { createNodeAnalyzer, discover, fromPosix, type NodeFileSystem } from '@codearchy/platform-node';
import { MemoryCardStore, NodeSearch, Summarizer, type Card } from '@codearchy/ai';

export interface Snapshot {
    index: HierarchyIndex;
    search: NodeSearch;
    cardFor: (key: string) => Promise<Card | undefined>;
    files: number;
    languages: string[];
    builtAt: number;
    buildMs: number;
}

export interface WorkspaceOptions {
    maxFileSize?: number;
    /** Above this many files, search covers names and paths only (cards would mean reading every file up front). */
    cardSearchLimit?: number;
    log?: (message: string) => void;
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
        const index = new HierarchyIndex(buildHierarchy(graph, { systemName: path.basename(this.root) }));
        const summarizer = new Summarizer({ index, readFile: (p) => this.readFile(p), store: this.store });
        const cardFor = async (key: string) => (index.node(key) && index.node(key)!.kind !== 'symbol' ? summarizer.card(key) : undefined);
        const files = discovery.sourceFiles.length;
        const search = files <= (this.options.cardSearchLimit ?? 5000) ? await NodeSearch.withCards(index, cardFor) : new NodeSearch(index);
        this.current = {
            index,
            search,
            cardFor,
            files,
            languages: graph.metadata.languages,
            builtAt: Date.now(),
            buildMs: Date.now() - started,
        };
        this.log(`Indexed ${files} files in ${this.current.buildMs} ms (${graph.metadata.languages.join(', ') || 'no supported languages'}).`);
        return this.current;
    }
}
