/**
 * Host-agnostic analysis orchestration: read → extract (tree-sitter, else
 * regex) → keep per-file results so single-file updates are cheap.
 *
 * Reads files straight from disk (never through an editor's document model)
 * and yields to the event loop regularly so the host stays responsive.
 */
import * as fs from 'fs';
import * as path from 'path';
import { FileAnalysis } from '../model';
import { getPackForExtension } from './languages';
import { analyzeWithRegex } from './regexFallback';
import { TreeSitterEngine } from './TreeSitterEngine';

export interface AnalyzerOptions {
    grammarDir: string;
    maxFileSize: number;
    log?: (message: string) => void;
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

export class AnalysisCancelledError extends Error {
    constructor() {
        super('Analysis cancelled');
    }
}

/** Yield to the event loop at most every this many milliseconds of work. */
const YIELD_INTERVAL_MS = 12;

export class Analyzer {
    private constructor(
        private readonly engine: TreeSitterEngine | undefined,
        private readonly options: AnalyzerOptions
    ) {}

    static async create(options: AnalyzerOptions): Promise<Analyzer> {
        const engine = await TreeSitterEngine.create({ grammarDir: options.grammarDir, log: options.log });
        return new Analyzer(engine, options);
    }

    get treeSitterAvailable(): boolean {
        return !!this.engine;
    }

    availableGrammars(): string[] {
        return this.engine?.availableGrammars() ?? [];
    }

    /** Returns undefined for unsupported, oversized, binary or unreadable files. */
    async analyzeFile(filePath: string, source?: string): Promise<FileAnalysis | undefined> {
        const pack = getPackForExtension(path.extname(filePath));
        if (!pack) return undefined;

        if (source === undefined) {
            try {
                const stat = await fs.promises.stat(filePath);
                if (!stat.isFile() || stat.size > this.options.maxFileSize) return undefined;
                source = await fs.promises.readFile(filePath, 'utf8');
            } catch {
                return undefined;
            }
        }
        if (source.length > this.options.maxFileSize || source.includes('\u0000')) return undefined;

        if (this.engine) {
            try {
                const result = await this.engine.analyze(source, filePath, pack);
                if (result) return result;
            } catch (err) {
                this.options.log?.(`tree-sitter failed on ${filePath}: ${(err as Error).message}`);
            }
        }
        return analyzeWithRegex(source, filePath, pack.id);
    }

    async analyzeAll(files: string[], opts: AnalyzeAllOptions = {}): Promise<Map<string, FileAnalysis>> {
        const results = new Map<string, FileAnalysis>();
        let lastYield = Date.now();
        for (let i = 0; i < files.length; i++) {
            if (opts.isCancelled?.()) throw new AnalysisCancelledError();
            const file = files[i];
            opts.onProgress?.({ current: i + 1, total: files.length, file });
            const analysis = await this.analyzeFile(file);
            if (analysis) results.set(file, analysis);

            if (Date.now() - lastYield > YIELD_INTERVAL_MS) {
                await new Promise<void>((resolve) => setImmediate(resolve));
                lastYield = Date.now();
            }
        }
        return results;
    }

    dispose(): void {
        this.engine?.dispose();
    }
}

/** Reads manifest files; unreadable ones are skipped. */
export async function readManifests(files: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    await Promise.all(
        files.map(async (f) => {
            try {
                const stat = await fs.promises.stat(f);
                if (stat.size < 2_000_000) out.set(f, await fs.promises.readFile(f, 'utf8'));
            } catch {
                // ignore
            }
        })
    );
    return out;
}
