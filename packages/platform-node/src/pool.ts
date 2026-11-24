/**
 * A worker_threads parse pool implementing the core AnalyzeExecutor. Each
 * worker owns one Analyzer (tree-sitter runtime + grammars load once, ~10 ms)
 * and pulls chunks of jobs, so faster workers take more (dynamic balancing).
 * Small batches run in-process: spinning workers up isn't worth it.
 *
 * Spike B: ~745 files/s per worker, ~4.2x with 8 workers on an Apple M1.
 */
import * as os from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { AnalysisCancelledError, LocalExecutor, type AnalyzeExecutor, type AnalyzeJob, type AnalyzeResult, type ExecutorOptions } from '@codearchy/core';
import { createNodeAnalyzer, type NodeParserOptions } from './index.js';

export interface ParseWorkerData extends NodeParserOptions {
    root: string;
    maxFileSize: number;
}

export interface NodeWorkerPoolOptions extends ParseWorkerData {
    /** Script that calls runParseWorker() (bundled hosts pass their own; defaults to this package's worker). */
    workerScript?: string | URL;
    /** Default: min(available cores - 1, 8). */
    workers?: number;
    /** Batches smaller than this run in-process. */
    minJobsForWorkers?: number;
    log?: (message: string) => void;
}

const CHUNK = 64;

type ToWorker = { type: 'jobs'; jobs: AnalyzeJob[] };
type FromWorker = { type: 'ready' } | { type: 'results'; results: AnalyzeResult[] } | { type: 'error'; message: string };

export class NodeWorkerPool implements AnalyzeExecutor {
    private workers: Worker[] | undefined;
    private local: LocalExecutor | undefined;
    private localDispose: (() => void) | undefined;
    private readonly size: number;

    constructor(private readonly options: NodeWorkerPoolOptions) {
        const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
        this.size = Math.max(1, options.workers ?? Math.min(cores - 1, 8));
    }

    get workerCount(): number {
        return this.size;
    }

    /** Worker threads used by the most recent run (0 when it ran in-process). */
    lastRunWorkers = 0;
    /** Jobs completed on worker threads since the pool started, across every run (full index or update). */
    workerJobs = 0;

    async run(jobs: AnalyzeJob[], options: ExecutorOptions = {}): Promise<void> {
        this.lastRunWorkers = 0;
        if (jobs.length < (this.options.minJobsForWorkers ?? 200) || this.size <= 1) {
            return (await this.getLocal()).run(jobs, options);
        }
        let workers: Worker[];
        try {
            workers = await this.getWorkers();
        } catch (err) {
            this.options.log?.(`parse workers unavailable (${(err as Error).message}); parsing in-process`);
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
                                w.off('message', onMessage);
                                w.off('error', onError);
                                resolve();
                                return;
                            }
                            const chunk = jobs.slice(next, next + CHUNK);
                            next += chunk.length;
                            w.postMessage({ type: 'jobs', jobs: chunk } satisfies ToWorker);
                        };
                        const onMessage = (m: FromWorker) => {
                            if (m.type === 'results') {
                                this.workerJobs += m.results.length;
                                for (const r of m.results) options.onResult?.(r);
                                send();
                            } else if (m.type === 'error') {
                                onError(new Error(m.message));
                            }
                        };
                        const onError = (err: Error) => {
                            w.off('message', onMessage);
                            w.off('error', onError);
                            reject(err);
                        };
                        w.on('message', onMessage);
                        w.on('error', onError);
                        send();
                    })
            )
        );
        if (cancelled) throw new AnalysisCancelledError();
    }

    dispose(): void {
        for (const w of this.workers ?? []) void w.terminate();
        this.workers = undefined;
        this.localDispose?.();
        this.local = undefined;
    }

    private async getLocal(): Promise<LocalExecutor> {
        if (!this.local) {
            const { analyzer } = await createNodeAnalyzer(this.options);
            this.local = new LocalExecutor(analyzer, () => new Promise((r) => setImmediate(r)));
            this.localDispose = () => analyzer.dispose();
        }
        return this.local;
    }

    private async getWorkers(): Promise<Worker[]> {
        if (this.workers) return this.workers;
        const script = this.options.workerScript ?? new URL('./worker.js', import.meta.url);
        const data: ParseWorkerData = {
            root: this.options.root,
            maxFileSize: this.options.maxFileSize,
            grammarDir: this.options.grammarDir,
            runtimeWasmPath: this.options.runtimeWasmPath,
        };
        const workers = Array.from({ length: this.size }, () => new Worker(script, { workerData: data }));
        // Wait for every worker to load its runtime; fail fast if one can't.
        await Promise.all(
            workers.map(
                (w) =>
                    new Promise<void>((resolve, reject) => {
                        const onMessage = (m: FromWorker) => {
                            if (m.type === 'ready') {
                                w.off('error', reject);
                                w.off('message', onMessage);
                                resolve();
                            } else if (m.type === 'error') {
                                reject(new Error(m.message));
                            }
                        };
                        w.on('message', onMessage);
                        w.once('error', reject);
                    })
            )
        ).catch((err) => {
            for (const w of workers) void w.terminate();
            throw err;
        });
        for (const w of workers) w.unref(); // never keep the host process alive on their own
        this.workers = workers;
        return workers;
    }
}

/** Worker-side loop. Call from the worker entry script. */
export async function runParseWorker(): Promise<void> {
    if (isMainThread || !parentPort) throw new Error('runParseWorker() must run inside a worker thread');
    const port = parentPort;
    try {
        const { analyzer } = await createNodeAnalyzer(workerData as ParseWorkerData);
        port.on('message', async (m: ToWorker) => {
            if (m.type !== 'jobs') return;
            const results: AnalyzeResult[] = [];
            for (const job of m.jobs) results.push(await analyzer.runJob(job));
            port.postMessage({ type: 'results', results } satisfies FromWorker);
        });
        port.postMessage({ type: 'ready' } satisfies FromWorker);
    } catch (err) {
        port.postMessage({ type: 'error', message: (err as Error).message } satisfies FromWorker);
    }
}
