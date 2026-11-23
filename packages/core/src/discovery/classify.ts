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

/**
 * Files that mark a package (L1 in the hierarchy) by their presence. Not all
 * of them are read: names come from the manifests the resolver reads anyway.
 */
const PACKAGE_MARKER_FILES = new Set([
    'package.json', 'go.mod', 'Cargo.toml', 'composer.json',
    'pyproject.toml', 'setup.py', 'setup.cfg', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile',
]);

export function isPackageMarker(name: string): boolean {
    return PACKAGE_MARKER_FILES.has(name) || /\.(csproj|fsproj|gemspec)$/.test(name);
}

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
    /** Files whose directory is a package root (package.json, go.mod, pom.xml, *.csproj, ...), sorted. */
    packageMarkers: string[];
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
    const packageMarkers: string[] = [];
    for (const p of relativePaths) {
        if (isExcluded(p)) continue;
        const name = basename(p);
        if (isPackageMarker(name)) packageMarkers.push(p);
        if (isManifest(name)) {
            manifests.push(p);
            continue;
        }
        const pack = getPackForExtension(extname(p));
        if (pack && languages.has(pack.id)) sources.push(p);
    }
    sources.sort();
    packageMarkers.sort();
    const discovered = sources.length;
    const truncated = options.maxFiles > 0 && discovered > options.maxFiles;
    return { sourceFiles: truncated ? sources.slice(0, options.maxFiles) : sources, manifests, packageMarkers, discovered, truncated, method };
}
