/**
 * Host-agnostic analysis orchestration: read → extract (tree-sitter when the
 * host provides a ParserRuntime, else the regex fallback).
 */
import type { FileAnalysis } from '@codearchy/protocol';
import { analyzeWithRegex } from './extract/regex.js';
import { TreeSitterExtractor } from './extract/treeSitter.js';
import { getPackForExtension } from './languages/index.js';
import type { FileSystemPort, Logger, ParserRuntime } from './ports.js';
import { contentHash } from './util/hash.js';
import { extname } from './util/posixPath.js';

export interface AnalyzerOptions {
    fs: FileSystemPort;
    /** Omit to use the regex fallback only. */
    parser?: ParserRuntime;
    maxFileSize: number;
    log?: Logger;
    /** Lets the host breathe during long runs (e.g. setImmediate in Node, a macrotask in browsers). */
    yieldToHost?: () => Promise<void>;
}

export interface AnalyzeProgress {
    current: number;
    total: number;
    file: string;
}

export interface AnalyzeAllOptions {
    onProgress?: (p: AnalyzeProgress) => void;
    isCancelled?: () => boolean;
}

/** One unit of indexing work: analyse `path` unless its content still hashes to `knownHash`. */
export interface AnalyzeJob {
    path: string;
    knownHash?: string;
}

export interface FileState {
    contentHash: string;
    size: number;
    mtimeMs?: number;
}

export interface AnalyzeResult {
    path: string;
    /** Missing when the file is unreadable, oversized, binary or unsupported. */
    state?: FileState;
    /** The new facts; absent when `unchanged` or not analysable. */
    analysis?: FileAnalysis;
    /** Content still matches `knownHash`: keep the stored facts. */
    unchanged?: boolean;
}

export class AnalysisCancelledError extends Error {
    constructor() {
        super('Analysis cancelled');
    }
}

/** Yield at most every this many milliseconds of work. */
const YIELD_INTERVAL_MS = 12;

export class Analyzer {
    private readonly extractor: TreeSitterExtractor | undefined;

    constructor(private readonly options: AnalyzerOptions) {
        this.extractor = options.parser ? new TreeSitterExtractor(options.parser, options.log) : undefined;
    }

    get treeSitterAvailable(): boolean {
        return !!this.extractor;
    }

    /** Undefined for unsupported, oversized, binary or unreadable files. */
    async analyzeFile(path: string, source?: string): Promise<FileAnalysis | undefined> {
        const pack = getPackForExtension(extname(path));
        if (!pack) return undefined;
        if (source === undefined) {
            const stat = await this.options.fs.stat(path);
            if (!stat?.isFile || stat.size > this.options.maxFileSize) return undefined;
            source = await this.options.fs.readText(path);
            if (source === undefined) return undefined;
        }
        if (source.length > this.options.maxFileSize || source.includes('\u0000')) return undefined;

        if (this.extractor) {
            try {
                const result = await this.extractor.analyze(source, path, pack);
                if (result) return result;
            } catch (err) {
                this.options.log?.(`tree-sitter failed on ${path}: ${(err as Error).message}`);
            }
        }
        return analyzeWithRegex(source, path, pack.id);
    }

    /** Reads, hashes and (if changed) analyses one file. */
    async runJob(job: AnalyzeJob): Promise<AnalyzeResult> {
        const { path } = job;
        if (!getPackForExtension(extname(path))) return { path };
        const stat = await this.options.fs.stat(path);
        if (!stat?.isFile || stat.size > this.options.maxFileSize) return { path };
        const source = await this.options.fs.readText(path);
        if (source === undefined) return { path };
        const state: FileState = { contentHash: contentHash(source), size: stat.size, ...(stat.mtimeMs !== undefined ? { mtimeMs: stat.mtimeMs } : {}) };
        if (job.knownHash && job.knownHash === state.contentHash) return { path, state, unchanged: true };
        const analysis = await this.analyzeFile(path, source);
        return analysis ? { path, state, analysis } : { path };
    }

    async analyzeAll(paths: string[], opts: AnalyzeAllOptions = {}): Promise<Map<string, FileAnalysis>> {
        const results = new Map<string, FileAnalysis>();
        const yieldToHost = this.options.yieldToHost;
        let lastYield = Date.now();
        for (let i = 0; i < paths.length; i++) {
            if (opts.isCancelled?.()) throw new AnalysisCancelledError();
            const path = paths[i];
            opts.onProgress?.({ current: i + 1, total: paths.length, file: path });
            const analysis = await this.analyzeFile(path);
            if (analysis) results.set(path, analysis);
            if (yieldToHost && Date.now() - lastYield > YIELD_INTERVAL_MS) {
                await yieldToHost();
                lastYield = Date.now();
            }
        }
        return results;
    }

    dispose(): void {
        this.extractor?.dispose();
    }
}

/** Reads manifest files through the port; unreadable or huge ones are skipped. */
export async function readManifests(fs: FileSystemPort, paths: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const read = await Promise.all(
        paths.map(async (p): Promise<[string, string] | undefined> => {
            const stat = await fs.stat(p);
            if (!stat?.isFile || stat.size >= 2_000_000) return undefined;
            const text = await fs.readText(p);
            return text === undefined ? undefined : [p, text];
        })
    );
    // Path order (not completion order): downstream results must not depend on I/O timing.
    for (const entry of read.filter((e): e is [string, string] => !!e).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) out.set(entry[0], entry[1]);
    return out;
}
