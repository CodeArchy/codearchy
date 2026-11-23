/**
 * A Web Worker parse pool implementing the core AnalyzeExecutor: the browser
 * counterpart of platform-node's NodeWorkerPool (same chunked, dynamically
 * balanced protocol). Workers get the workspace as a structured-cloneable
 * source (a directory handle, or in-memory file entries) and read files
 * themselves. Small batches run in-process.
 *
 * Spike D: ~3.2-3.7k files/s with 4 workers in Chromium, Firefox and WebKit.
 */
import { Analyzer, AnalysisCancelledError, LocalExecutor, type AnalyzeExecutor, type AnalyzeJob, type AnalyzeResult, type ExecutorOptions, type FileSystemPort } from '@codearchy/core';
import { HandleFileSystem, MemoryFileSystem, type MemoryEntry } from './fs.js';
import { createFetchParserRuntime, type FetchParserOptions } from './parser.js';

export type WorkspaceSource = { kind: 'handle'; handle: FileSystemDirectoryHandle } | { kind: 'memory'; entries: Array<[string, MemoryEntry]> };

export interface BrowserWorkerData extends FetchParserOptions {
    source: WorkspaceSource;
    maxFileSize: number;
}

export interface BrowserWorkerPoolOptions extends BrowserWorkerData {
    /** Module worker script that calls runBrowserParseWorker(). */
    workerUrl: string | URL;
    /** Default: min(hardwareConcurrency - 1, 4). */
    workers?: number;
    minJobsForWorkers?: number;
}

type ToWorker = { type: 'init'; data: BrowserWorkerData } | { type: 'jobs'; jobs: AnalyzeJob[] };
type FromWorker = { type: 'ready' } | { type: 'results'; results: AnalyzeResult[] } | { type: 'error'; message: string };

const CHUNK = 64;

export function fileSystemFor(source: WorkspaceSource): FileSystemPort {
    return source.kind === 'handle' ? new HandleFileSystem(source.handle) : new MemoryFileSystem(source.entries);
}

/** Lets the browser render and handle input during long runs. */
export const yieldToBrowser = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export async function createBrowserAnalyzer(data: BrowserWorkerData): Promise<Analyzer> {
    return new Analyzer({
        fs: fileSystemFor(data.source),
        parser: await createFetchParserRuntime(data),
        maxFileSize: data.maxFileSize,
        yieldToHost: yieldToBrowser,
    });
}

export class BrowserWorkerPool implements AnalyzeExecutor {
    private workers: Worker[] | undefined;
    private local: LocalExecutor | undefined;
    private localAnalyzer: Analyzer | undefined;
    private readonly size: number;
    lastRunWorkers = 0;

    constructor(private readonly options: BrowserWorkerPoolOptions) {
        const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;
        this.size = Math.max(1, options.workers ?? Math.min(cores - 1, 4));
    }

    async run(jobs: AnalyzeJob[], options: ExecutorOptions = {}): Promise<void> {
        this.lastRunWorkers = 0;
        if (jobs.length < (this.options.minJobsForWorkers ?? 100) || this.size <= 1) return (await this.getLocal()).run(jobs, options);
        let workers: Worker[];
        try {
            workers = await this.getWorkers();
        } catch {
            return (await this.getLocal()).run(jobs, options);
        }
        this.lastRunWorkers = workers.length;
        let next = 0;
        let cancelled = false;
        await Promise.all(
            workers.map(
                (w) =>
                    new Promise<void>((resolve, reject) => {
                        const send = () => {
                            if (options.isCancelled?.()) cancelled = true;
                            if (cancelled || next >= jobs.length) {
                                w.onmessage = null;
                                w.onerror = null;
                                resolve();
                                return;
                            }
                            const chunk = jobs.slice(next, next + CHUNK);
                            next += chunk.length;
                            w.postMessage({ type: 'jobs', jobs: chunk } satisfies ToWorker);
                        };
                        w.onmessage = (ev: MessageEvent<FromWorker>) => {
                            const m = ev.data;
                            if (m.type === 'results') {
                                for (const r of m.results) options.onResult?.(r);
                                send();
                            } else if (m.type === 'error') {
                                reject(new Error(m.message));
                            }
                        };
                        w.onerror = (e) => reject(new Error(e.message || 'parse worker failed'));
                        send();
                    })
            )
        );
        if (cancelled) throw new AnalysisCancelledError();
    }

    dispose(): void {
        for (const w of this.workers ?? []) w.terminate();
        this.workers = undefined;
        this.localAnalyzer?.dispose();
        this.local = undefined;
        this.localAnalyzer = undefined;
    }

    private async getLocal(): Promise<LocalExecutor> {
        if (!this.local) {
            this.localAnalyzer = await createBrowserAnalyzer(this.options);
            this.local = new LocalExecutor(this.localAnalyzer, yieldToBrowser);
        }
        return this.local;
    }

    private async getWorkers(): Promise<Worker[]> {
        if (this.workers) return this.workers;
        const data: BrowserWorkerData = {
            source: this.options.source,
            maxFileSize: this.options.maxFileSize,
            runtimeWasmUrl: new URL(this.options.runtimeWasmUrl, location.href).href,
            grammarBaseUrl: new URL(this.options.grammarBaseUrl, location.href).href,
        };
        const workers = Array.from({ length: this.size }, () => new Worker(this.options.workerUrl, { type: 'module' }));
        try {
            await Promise.all(
                workers.map(
                    (w) =>
                        new Promise<void>((resolve, reject) => {
                            w.onmessage = (ev: MessageEvent<FromWorker>) =>
                                ev.data.type === 'ready' ? resolve() : ev.data.type === 'error' ? reject(new Error(ev.data.message)) : undefined;
                            w.onerror = (e) => reject(new Error(e.message || 'parse worker failed to start'));
                            w.postMessage({ type: 'init', data } satisfies ToWorker);
                        })
                )
            );
        } catch (err) {
            for (const w of workers) w.terminate();
            throw err;
        }
        this.workers = workers;
        return workers;
    }
}

/** Worker-side loop. Call from the module worker entry script. */
export function runBrowserParseWorker(): void {
    const scope = self as unknown as { onmessage: ((ev: MessageEvent<ToWorker>) => void) | null; postMessage(m: FromWorker): void };
    let analyzer: Analyzer | undefined;
    scope.onmessage = async (ev) => {
        const m = ev.data;
        try {
            if (m.type === 'init') {
                analyzer = await createBrowserAnalyzer(m.data);
                scope.postMessage({ type: 'ready' });
            } else if (m.type === 'jobs' && analyzer) {
                const results: AnalyzeResult[] = [];
                for (const job of m.jobs) results.push(await analyzer.runJob(job));
                scope.postMessage({ type: 'results', results });
            }
        } catch (err) {
            scope.postMessage({ type: 'error', message: (err as Error).message });
        }
    };
}
