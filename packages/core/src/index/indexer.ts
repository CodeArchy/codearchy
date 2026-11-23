/**
 * Incremental indexing. For each discovered file:
 *   - stored facts current and size + mtime unchanged → reuse (no read)
 *   - otherwise → read + hash; same hash → reuse (stat refreshed); else parse
 * Files no longer discovered are dropped. Work runs on an AnalyzeExecutor:
 * in-process here, or a worker pool supplied by the host.
 */
import type { FileAnalysis } from '@codearchy/protocol';
import { AnalysisCancelledError, type AnalyzeJob, type AnalyzeResult, type Analyzer } from '../analyzer.js';
import { readManifests } from '../analyzer.js';
import type { FileSystemPort, FileStat } from '../ports.js';
import { FACTS_VERSION, type IndexStore } from './store.js';

export interface ExecutorOptions {
    isCancelled?: () => boolean;
    /** Called once per job, in completion order. */
    onResult?: (result: AnalyzeResult) => void;
}

/** Runs analyse jobs. Hosts may provide a parallel implementation (worker threads / Web Workers). */
export interface AnalyzeExecutor {
    run(jobs: AnalyzeJob[], options?: ExecutorOptions): Promise<void>;
    dispose(): void;
}

/** Runs jobs in-process on one Analyzer (with the analyzer's cooperative yielding). */
export class LocalExecutor implements AnalyzeExecutor {
    constructor(
        private readonly analyzer: Analyzer,
        private readonly yieldToHost?: () => Promise<void>
    ) {}

    async run(jobs: AnalyzeJob[], options: ExecutorOptions = {}): Promise<void> {
        let last = Date.now();
        for (const job of jobs) {
            if (options.isCancelled?.()) throw new AnalysisCancelledError();
            options.onResult?.(await this.analyzer.runJob(job));
            if (this.yieldToHost && Date.now() - last > 12) {
                await this.yieldToHost();
                last = Date.now();
            }
        }
    }

    dispose(): void {
        // The analyzer is owned by the caller.
    }
}

export interface IndexProgress {
    phase: 'checking' | 'parsing' | 'saving';
    current: number;
    total: number;
    path?: string;
}

export interface IndexStats {
    /** Facts reused without reading the file (stat unchanged). */
    reused: number;
    /** Read and hashed, content unchanged: facts reused. */
    unchanged: number;
    /** Parsed (new or changed). */
    parsed: number;
    /** Dropped from the index (deleted, excluded or no longer analysable). */
    removed: number;
    durationMs: number;
}

export interface IndexResult {
    analyses: Map<string, FileAnalysis>;
    manifests: Map<string, string>;
    stats: IndexStats;
}

export interface IndexerOptions {
    fs: FileSystemPort;
    executor: AnalyzeExecutor;
    /** Optional persistent store; without it everything is parsed (in-memory indexing). */
    store?: IndexStore;
    /** Concurrent stat calls while checking freshness. */
    statConcurrency?: number;
}

export interface IndexRunOptions {
    onProgress?: (p: IndexProgress) => void;
    isCancelled?: () => boolean;
}

/** Facts written to the store in batches of this many files. */
const SAVE_BATCH = 500;

export class Indexer {
    constructor(private readonly options: IndexerOptions) {}

    /** Full (incremental) index of the discovered files. */
    async index(sourceFiles: string[], manifestPaths: string[], run: IndexRunOptions = {}): Promise<IndexResult> {
        const started = Date.now();
        const { store, fs } = this.options;
        const stats: IndexStats = { reused: 0, unchanged: 0, parsed: 0, removed: 0, durationMs: 0 };
        const stored = store?.fileStates() ?? new Map();
        const wanted = new Set(sourceFiles);

        const gone = [...stored.keys()].filter((p) => !wanted.has(p));
        if (store && gone.length) store.removeMany(gone);
        stats.removed += gone.length;

        // 1. Freshness check by stat.
        const reuse: string[] = [];
        const jobs: AnalyzeJob[] = [];
        const stats_ = await this.statAll(sourceFiles, run);
        for (const p of sourceFiles) {
            const prev = stored.get(p);
            const st = stats_.get(p);
            const current = prev && prev.factsVersion === FACTS_VERSION;
            if (current && st && st.mtimeMs !== undefined && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
                reuse.push(p);
            } else {
                jobs.push({ path: p, ...(current ? { knownHash: prev.contentHash } : {}) });
            }
        }
        stats.reused = reuse.length;

        // 2. Analyse what may have changed.
        const fresh = new Map<string, FileAnalysis>();
        const toSave: Array<{ analysis: FileAnalysis; state: { contentHash: string; size: number; mtimeMs?: number } }> = [];
        const dropped: string[] = [];
        let done = 0;
        await this.options.executor.run(jobs, {
            isCancelled: run.isCancelled,
            onResult: (r) => {
                done++;
                run.onProgress?.({ phase: 'parsing', current: done, total: jobs.length, path: r.path });
                if (r.unchanged && r.state) {
                    stats.unchanged++;
                    reuse.push(r.path);
                    store?.touch(r.path, r.state.size, r.state.mtimeMs);
                } else if (r.analysis && r.state) {
                    stats.parsed++;
                    fresh.set(r.path, r.analysis);
                    toSave.push({ analysis: r.analysis, state: r.state });
                    if (store && toSave.length >= SAVE_BATCH) store.putMany(toSave.splice(0));
                } else if (stored.has(r.path)) {
                    dropped.push(r.path); // no longer analysable (now binary, too big, unreadable)
                }
            },
        });
        run.onProgress?.({ phase: 'saving', current: 0, total: 1 });
        if (store) {
            store.putMany(toSave);
            if (dropped.length) store.removeMany(dropped);
        }
        stats.removed += dropped.length;

        // 3. Assemble: stored facts for reused files + fresh facts.
        const analyses = store && reuse.length ? store.loadAnalyses(reuse) : new Map<string, FileAnalysis>();
        for (const [p, a] of fresh) analyses.set(p, a);

        const manifests = await readManifests(fs, manifestPaths);
        store?.setManifests(manifests);
        stats.durationMs = Date.now() - started;
        return { analyses, manifests, stats };
    }

    /** Re-checks specific files (from a watcher). Returns new facts, or null when a file is gone/unanalysable. */
    async update(paths: string[]): Promise<Map<string, FileAnalysis | null>> {
        const { store } = this.options;
        const stored = store?.fileStates();
        const jobs = paths.map((p) => {
            const prev = stored?.get(p);
            return { path: p, ...(prev && prev.factsVersion === FACTS_VERSION ? { knownHash: prev.contentHash } : {}) };
        });
        const out = new Map<string, FileAnalysis | null>();
        const unchangedPaths: string[] = [];
        const toSave: Array<{ analysis: FileAnalysis; state: { contentHash: string; size: number; mtimeMs?: number } }> = [];
        await this.options.executor.run(jobs, {
            onResult: (r) => {
                if (r.unchanged && r.state) {
                    store?.touch(r.path, r.state.size, r.state.mtimeMs);
                    unchangedPaths.push(r.path);
                } else if (r.analysis && r.state) {
                    out.set(r.path, r.analysis);
                    toSave.push({ analysis: r.analysis, state: r.state });
                } else {
                    out.set(r.path, null);
                }
            },
        });
        if (store) {
            store.putMany(toSave);
            const gone = [...out].filter(([, a]) => a === null).map(([p]) => p);
            if (gone.length) store.removeMany(gone);
            for (const [p, a] of store.loadAnalyses(unchangedPaths)) out.set(p, a);
        }
        return out;
    }

    remove(paths: string[]): void {
        this.options.store?.removeMany(paths);
    }

    private async statAll(paths: string[], run: IndexRunOptions): Promise<Map<string, FileStat | undefined>> {
        const out = new Map<string, FileStat | undefined>();
        const limit = this.options.statConcurrency ?? 64;
        let next = 0;
        let done = 0;
        const worker = async () => {
            while (next < paths.length) {
                if (run.isCancelled?.()) throw new AnalysisCancelledError();
                const p = paths[next++];
                out.set(p, await this.options.fs.stat(p));
                if (++done % 500 === 0) run.onProgress?.({ phase: 'checking', current: done, total: paths.length });
            }
        };
        await Promise.all(Array.from({ length: Math.min(limit, paths.length) }, worker));
        return out;
    }
}
