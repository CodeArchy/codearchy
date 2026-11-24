/**
 * @codearchy/platform-node — Node.js adapters for @codearchy/core:
 * the file system, git-based discovery, and the tree-sitter runtime loaded
 * from @codearchy/grammars. Used by the VS Code extension, the CLI and the
 * benchmark harness.
 *
 * The core speaks workspace-relative POSIX paths; this package converts at
 * the edge (`toPosix` / `fromPosix`) and never lets a path escape the root.
 */
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import {
    Analyzer,
    classifyFiles,
    type AnalyzerOptions,
    type DiscoveryOptions,
    type DiscoveryResult,
    type FileStat,
    type FileSystemPort,
    type Logger,
    type ParserRuntime,
} from '@codearchy/core';
import { createTreeSitterRuntime } from '@codearchy/treesitter';

/**
 * Package-relative resolution, created lazily: `import.meta.url` is unset when
 * this module is bundled into CommonJS (e.g. the VS Code extension), and the
 * bundled host passes explicit asset paths instead of resolving packages.
 */
function packageRequire(): NodeJS.Require {
    return createRequire(import.meta.url);
}

// ─── paths ──────────────────────────────────────────────────────────────────

/** OS path relative to `root` → workspace-relative POSIX path (undefined if outside). */
export function toPosix(root: string, osPath: string): string | undefined {
    const rel = path.relative(root, osPath);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return rel === '' ? '' : undefined;
    return rel.split(path.sep).join('/');
}

/** Workspace-relative POSIX path → absolute OS path. */
export function fromPosix(root: string, posixPath: string): string {
    return path.join(root, ...posixPath.split('/'));
}

// ─── file system ────────────────────────────────────────────────────────────

export class NodeFileSystem implements FileSystemPort {
    constructor(readonly root: string) {}

    private resolve(p: string): string | undefined {
        // Only clean workspace paths: no "", ".", "..", absolute or backslash segments
        // (the same rule as the browser adapters; checked by the conformance suite).
        if (!p || p.startsWith('/') || p.includes('\\') || p.split('/').some((s) => s === '' || s === '.' || s === '..')) return undefined;
        const abs = fromPosix(this.root, p);
        const rel = path.relative(this.root, abs);
        return rel.startsWith('..') || path.isAbsolute(rel) ? undefined : abs;
    }

    async readText(p: string): Promise<string | undefined> {
        const abs = this.resolve(p);
        if (!abs) return undefined;
        try {
            return await fs.promises.readFile(abs, 'utf8');
        } catch {
            return undefined;
        }
    }

    async stat(p: string): Promise<FileStat | undefined> {
        const abs = this.resolve(p);
        if (!abs) return undefined;
        try {
            const s = await fs.promises.stat(abs);
            return { size: s.size, isFile: s.isFile(), mtimeMs: Math.trunc(s.mtimeMs) };
        } catch {
            return undefined;
        }
    }
}

// ─── discovery ──────────────────────────────────────────────────────────────

/** Tracked + untracked-not-ignored files (POSIX, relative to root), or undefined without git. */
export function gitListFiles(root: string): Promise<string[] | undefined> {
    return new Promise((resolve) => {
        execFile(
            'git',
            ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
            { cwd: root, maxBuffer: 512 * 1024 * 1024, windowsHide: true },
            (err, stdout) => resolve(err ? undefined : [...new Set(stdout.split('\0').filter(Boolean))])
        );
    });
}

const WALK_SKIP = new Set(['.git', 'node_modules', '.hg', '.svn']);

/** Recursive listing for non-git folders (POSIX, relative to root). */
export async function walkFiles(root: string, rel = ''): Promise<string[]> {
    const out: string[] = [];
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(rel ? fromPosix(root, rel) : root, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const e of entries) {
        if (WALK_SKIP.has(e.name)) continue;
        const child = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) out.push(...(await walkFiles(root, child)));
        else if (e.isFile()) out.push(child);
    }
    return out;
}

/** git ls-files when available (honours .gitignore), else a directory walk. */
export async function discover(root: string, options: DiscoveryOptions): Promise<DiscoveryResult> {
    const viaGit = await gitListFiles(root);
    if (viaGit) return classifyFiles(viaGit, options, 'git');
    return classifyFiles(await walkFiles(root), options, 'walk');
}

/** Of `paths` (POSIX, relative), the ones git ignores. Empty when git is unavailable. */
export function gitIgnoredPaths(root: string, paths: string[]): Promise<Set<string>> {
    if (paths.length === 0) return Promise.resolve(new Set());
    return new Promise((resolve) => {
        const child = spawn('git', ['check-ignore', '-z', '--stdin'], { cwd: root, windowsHide: true });
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
        child.on('error', () => resolve(new Set()));
        child.on('close', (code) => resolve(code === 0 || code === 1 ? new Set(out.split('\0').filter(Boolean)) : new Set()));
        child.stdin.on('error', () => undefined);
        child.stdin.end(paths.join('\0') + '\0');
    });
}

// ─── tree-sitter ────────────────────────────────────────────────────────────

/** Directory holding the pinned grammar .wasm files (run `@codearchy/grammars` fetch first). */
export function defaultGrammarDir(): string {
    return path.join(path.dirname(packageRequire().resolve('@codearchy/grammars/package.json')), 'wasm');
}

/** Path of the web-tree-sitter runtime wasm that matches @codearchy/treesitter. */
export function defaultRuntimeWasmPath(): string {
    const treesitterDir = path.dirname(packageRequire().resolve('@codearchy/treesitter/package.json'));
    return createRequire(path.join(treesitterDir, 'package.json')).resolve('web-tree-sitter/web-tree-sitter.wasm');
}

export interface NodeParserOptions {
    grammarDir?: string;
    runtimeWasmPath?: string;
}

/** A ParserRuntime reading wasm files from disk, or undefined if the runtime can't load. */
export async function createNodeParserRuntime(options: NodeParserOptions = {}, log?: Logger): Promise<ParserRuntime | undefined> {
    const grammarDir = options.grammarDir ?? defaultGrammarDir();
    const runtimeWasmPath = options.runtimeWasmPath ?? defaultRuntimeWasmPath();
    try {
        return await createTreeSitterRuntime({
            runtimeWasm: async () => new Uint8Array(await fs.promises.readFile(runtimeWasmPath)),
            grammar: async (file) => {
                if (path.basename(file) !== file) return undefined; // file names only
                try {
                    return new Uint8Array(await fs.promises.readFile(path.join(grammarDir, file)));
                } catch {
                    return undefined;
                }
            },
        });
    } catch (err) {
        log?.(`tree-sitter runtime unavailable: ${(err as Error).message}`);
        return undefined;
    }
}

/** Lets Node process I/O and timers during long analyses. */
export const yieldToNode = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export interface NodeEngineOptions extends NodeParserOptions {
    root: string;
    maxFileSize: number;
    log?: Logger;
}

/** An Analyzer wired for Node: disk FS, tree-sitter (regex fallback if unavailable), cooperative yielding. */
export async function createNodeAnalyzer(options: NodeEngineOptions): Promise<{ analyzer: Analyzer; fs: NodeFileSystem }> {
    const fsPort = new NodeFileSystem(options.root);
    const parser = await createNodeParserRuntime(options, options.log);
    const analyzerOptions: AnalyzerOptions = {
        fs: fsPort,
        parser,
        maxFileSize: options.maxFileSize,
        log: options.log,
        yieldToHost: yieldToNode,
    };
    return { analyzer: new Analyzer(analyzerOptions), fs: fsPort };
}

export { openNodeSqlite, type NodeSqliteOptions } from './storage.js';
export { NodeWorkerPool, runParseWorker, type NodeWorkerPoolOptions, type ParseWorkerData } from './pool.js';
export { computeGitAuthorship, parseIncrementalBlame, type GitAuthorship, type GitAuthorshipOptions } from './authorship.js';
export { FileLedgerStore, companionDataDir } from './ledgerStore.js';
export { AgentLogIngester, AGENT_IDS, type AgentLogOptions, type AgentLogReport } from './agentLogs.js';
