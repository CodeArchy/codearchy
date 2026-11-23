/**
 * Classifies a host's file listing into source files and manifests, applying
 * the language and exclude filters. Hosts produce the listing (git ls-files,
 * a directory walk, a dropped folder, a zip) as workspace-relative POSIX paths.
 */
import { compileGlobs } from '../util/glob.js';
import { getPackForExtension } from '../languages/index.js';
import { basename, extname } from '../util/posixPath.js';

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
export const MANIFEST_FILES = new Set(['package.json', 'tsconfig.json', 'jsconfig.json', 'go.mod', 'Cargo.toml', 'composer.json']);

export function isManifest(name: string): boolean {
    return MANIFEST_FILES.has(name) || /^(tsconfig|jsconfig)\..+\.json$/.test(name);
}

export interface DiscoveryOptions {
    languages: string[];
    excludePatterns: string[];
    /** 0 = unlimited. */
    maxFiles: number;
}

export interface DiscoveryResult {
    /** Workspace-relative source files, sorted. */
    sourceFiles: string[];
    /** Workspace-relative manifest files. */
    manifests: string[];
    /** Source files found before `maxFiles` was applied. */
    discovered: number;
    truncated: boolean;
    /** How the host listed files (e.g. "git", "walk", "drop"). */
    method: string;
}

export function classifyFiles(relativePaths: Iterable<string>, options: DiscoveryOptions, method: string): DiscoveryResult {
    const isExcluded = compileGlobs(options.excludePatterns);
    const languages = new Set(options.languages);
    const sources: string[] = [];
    const manifests: string[] = [];
    for (const p of relativePaths) {
        if (isExcluded(p)) continue;
        if (isManifest(basename(p))) {
            manifests.push(p);
            continue;
        }
        const pack = getPackForExtension(extname(p));
        if (pack && languages.has(pack.id)) sources.push(p);
    }
    sources.sort();
    const discovered = sources.length;
    const truncated = options.maxFiles > 0 && discovered > options.maxFiles;
    return { sourceFiles: truncated ? sources.slice(0, options.maxFiles) : sources, manifests, discovered, truncated, method };
}
