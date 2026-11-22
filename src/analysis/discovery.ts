/**
 * File discovery. Prefers `git ls-files` (fast, honours .gitignore, no file
 * cap); callers fall back to a host-specific walker when this returns
 * undefined (not a git repo, or git isn't installed).
 */
import { execFile, spawn } from 'child_process';
import * as path from 'path';
import { compileGlobs } from './glob';
import { getPackForExtension } from './languages';

export const DEFAULT_EXCLUDE_PATTERNS = [
    '**/node_modules/**',
    '**/dist/**',
    '**/out/**',
    '**/build/**',
    '**/.git/**',
    '**/vendor/**',
    '**/target/**',
    '**/__pycache__/**',
    '**/.venv/**',
    '**/venv/**',
    '**/.next/**',
    '**/coverage/**',
    '**/*.min.js',
];

/** Project manifests the import resolver reads (module roots, path aliases). */
export const MANIFEST_FILES = new Set([
    'package.json',
    'tsconfig.json',
    'jsconfig.json',
    'go.mod',
    'Cargo.toml',
    'composer.json',
]);

export function isManifest(basename: string): boolean {
    return MANIFEST_FILES.has(basename) || /^(tsconfig|jsconfig)\..+\.json$/.test(basename);
}

export interface DiscoveryResult {
    /** Absolute paths of source files, sorted. */
    sourceFiles: string[];
    /** Absolute paths of manifest files (see MANIFEST_FILES). */
    manifests: string[];
    /** Total source files found before `maxFiles` was applied. */
    discovered: number;
    truncated: boolean;
    method: 'git' | 'walk';
}

export interface DiscoveryOptions {
    languages: string[];
    excludePatterns: string[];
    /** 0 = unlimited. */
    maxFiles: number;
}

/** Lists files tracked or untracked-but-not-ignored by git, relative to `root`. */
export function gitListFiles(root: string): Promise<string[] | undefined> {
    return new Promise((resolve) => {
        execFile(
            'git',
            ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
            { cwd: root, maxBuffer: 512 * 1024 * 1024, windowsHide: true },
            (err, stdout) => {
                if (err) {
                    resolve(undefined);
                    return;
                }
                // Unmerged paths are listed once per stage; dedupe.
                resolve([...new Set(stdout.split('\0').filter(Boolean))]);
            }
        );
    });
}

/**
 * Returns the subset of `relativePaths` that git ignores. Resolves to an empty
 * set when git is unavailable, so callers fail open (keep the files).
 */
export function gitIgnoredPaths(root: string, relativePaths: string[]): Promise<Set<string>> {
    if (relativePaths.length === 0) return Promise.resolve(new Set());
    return new Promise((resolve) => {
        const child = spawn('git', ['check-ignore', '-z', '--stdin'], { cwd: root, windowsHide: true });
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
        child.on('error', () => resolve(new Set()));
        // Exit code 1 just means "nothing ignored".
        child.on('close', (code) => resolve(code === 0 || code === 1 ? new Set(out.split('\0').filter(Boolean)) : new Set()));
        child.stdin.on('error', () => undefined);
        child.stdin.end(relativePaths.join('\0') + '\0');
    });
}

/**
 * Classifies relative paths into source files and manifests, applying
 * language and exclude filters. Shared by the git path and host walkers.
 */
export function classifyFiles(root: string, relativePaths: string[], options: DiscoveryOptions, method: 'git' | 'walk'): DiscoveryResult {
    const isExcluded = compileGlobs(options.excludePatterns);
    const languages = new Set(options.languages);
    const sources: string[] = [];
    const manifests: string[] = [];

    for (const rel of relativePaths) {
        const posix = rel.split(path.sep).join('/');
        if (isExcluded(posix)) continue;
        const base = posix.slice(posix.lastIndexOf('/') + 1);
        if (isManifest(base)) {
            manifests.push(path.join(root, rel));
            continue;
        }
        const pack = getPackForExtension(path.extname(base));
        if (pack && languages.has(pack.id)) sources.push(path.join(root, rel));
    }

    sources.sort();
    const discovered = sources.length;
    const truncated = options.maxFiles > 0 && discovered > options.maxFiles;
    return {
        sourceFiles: truncated ? sources.slice(0, options.maxFiles) : sources,
        manifests,
        discovered,
        truncated,
        method,
    };
}

export async function discoverWithGit(root: string, options: DiscoveryOptions): Promise<DiscoveryResult | undefined> {
    const files = await gitListFiles(root);
    if (!files) return undefined;
    return classifyFiles(root, files, options, 'git');
}
