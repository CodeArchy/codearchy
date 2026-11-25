/**
 * A public repository, opened by its URL, straight into the browser.
 *
 * GitHub: its zip downloads (codeload) only allow GitHub's own pages, so the
 * repository is read through the APIs that allow any page: the REST API for
 * the default branch and the file list (2 requests of the 60 an hour GitHub
 * gives anonymous callers), then raw.githubusercontent.com for the files the
 * indexer reads (sources, manifests, package markers, tours), several at once.
 *
 * GitLab (gitlab.com): its archive endpoint allows any page, so the repository
 * comes as one zip.
 *
 * Only public repositories: nothing here sends credentials.
 */
import { classifyFiles, DEFAULT_EXCLUDE_PATTERNS, DEFAULT_LANGUAGE_IDS } from '@codearchy/core';
import type { MemoryEntry } from '../fs.js';
import { MAX_REPOSITORY_FILES, parseRepositoryUrl, type RepositoryRef } from './repositoryUrl.js';

export { MAX_REPOSITORY_FILES, parseRepositoryUrl, type RepositoryRef };

const CONCURRENCY = 16;

export class RepositoryError extends Error {}

export interface RepositoryDownload {
    /** `owner/repo`, for the workspace name. */
    name: string;
    entries: Array<[string, MemoryEntry]>;
    /** Files left out by MAX_REPOSITORY_FILES. */
    truncated: boolean;
}

export interface RepositoryOptions {
    maxFileSize: number;
    /** Files (GitHub) or kilobytes (GitLab) so far, of the total when known. */
    onProgress?(current: number, total: number): void;
    fetch?: typeof fetch;
    /** Pause before retrying a GitLab archive it isn't ready to give (ms). */
    retryDelayMs?: number;
    /** For tests: unzip a GitLab archive. */
    unzip?(data: Uint8Array): Array<[string, MemoryEntry]>;
    isCancelled?(): boolean;
}

export async function downloadRepository(input: string, options: RepositoryOptions): Promise<RepositoryDownload> {
    const ref = parseRepositoryUrl(input);
    if (!ref) throw new RepositoryError('That isn’t a GitHub or GitLab repository URL. Try https://github.com/owner/repo.');
    return ref.host === 'github' ? github(ref, options) : gitlab(ref, options);
}

// ─── GitHub ─────────────────────────────────────────────────────────────────

interface TreeEntry {
    path: string;
    type: 'blob' | 'tree' | 'commit';
    sha: string;
    size?: number;
}

async function github(ref: RepositoryRef, options: RepositoryOptions): Promise<RepositoryDownload> {
    const get = options.fetch ?? fetch;
    const api = `https://api.github.com/repos/${ref.path}`;
    const json = async <T>(url: string): Promise<T> => {
        const r = await get(url, { headers: { Accept: 'application/vnd.github+json' } }).catch(() => {
            throw new RepositoryError('Couldn’t reach GitHub. Check your connection, or open a .zip of the repository instead.');
        });
        if (r.status === 404) throw new RepositoryError(`GitHub has no public repository ${ref.path}. Private repositories can’t be opened by URL: download a .zip, or use the Companion on a clone.`);
        if ((r.status === 403 || r.status === 429) && r.headers.get('x-ratelimit-remaining') === '0') {
            const reset = Number(r.headers.get('x-ratelimit-reset')) * 1000;
            const at = reset ? new Date(reset).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : 'in an hour';
            throw new RepositoryError(`GitHub’s limit for anonymous requests from this network is reached (60 an hour). Try again ${reset ? `after ${at}` : at}, or download the repository as a .zip and open that.`);
        }
        if (!r.ok) throw new RepositoryError(`GitHub answered ${r.status} for ${ref.path}.`);
        return (await r.json()) as T;
    };
    const branch = ref.ref ?? (await json<{ default_branch: string }>(api)).default_branch;
    const tree = await json<{ tree: TreeEntry[]; truncated?: boolean }>(`${api}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    const blobs = new Map(tree.tree.filter((e) => e.type === 'blob' && (e.size ?? 0) <= options.maxFileSize).map((e) => [e.path, e]));
    const wanted = readable([...blobs.keys()]);
    const paths = wanted.slice(0, MAX_REPOSITORY_FILES);
    const raw = `https://raw.githubusercontent.com/${ref.path}/${encodeURIComponent(branch)}/`;
    const entries: Array<[string, MemoryEntry]> = [];
    let done = 0;
    let next = 0;
    options.onProgress?.(0, paths.length);
    const worker = async () => {
        while (next < paths.length && !options.isCancelled?.()) {
            const path = paths[next++]!;
            const r = await get(raw + path.split('/').map(encodeURIComponent).join('/')).catch(() => undefined);
            if (r?.ok) {
                // A content-derived "modified time" (from the blob's hash): reopening reuses unchanged files and re-reads changed ones.
                entries.push([path, { data: await r.blob(), mtimeMs: shaStamp(blobs.get(path)!.sha) }]);
            }
            options.onProgress?.(++done, paths.length);
        }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (options.isCancelled?.()) throw new RepositoryError('Cancelled');
    if (!entries.length && paths.length) throw new RepositoryError('Couldn’t download the files from GitHub. Try again, or open a .zip of the repository.');
    return { name: ref.path, entries: entries.sort((a, b) => (a[0] < b[0] ? -1 : 1)), truncated: !!tree.truncated || wanted.length > paths.length };
}

/** The files the indexer reads: sources, manifests, package markers and tours (the rest are never downloaded). */
function readable(paths: string[]): string[] {
    const d = classifyFiles(paths, { languages: DEFAULT_LANGUAGE_IDS, excludePatterns: DEFAULT_EXCLUDE_PATTERNS, maxFiles: 0 }, 'repository');
    return [...new Set([...d.manifests, ...d.packageMarkers, ...d.tours, ...d.sourceFiles])];
}

/** A stable number from a git blob hash (same content, same number). */
function shaStamp(sha: string): number {
    return parseInt(sha.slice(0, 12), 16) || 1;
}

// ─── GitLab ─────────────────────────────────────────────────────────────────

async function gitlab(ref: RepositoryRef, options: RepositoryOptions): Promise<RepositoryDownload> {
    const get = options.fetch ?? fetch;
    const url = `https://gitlab.com/api/v4/projects/${encodeURIComponent(ref.path)}/repository/archive.zip${ref.ref ? `?sha=${encodeURIComponent(ref.ref)}` : ''}`;
    const ask = () =>
        get(url).catch(() => {
            throw new RepositoryError('Couldn’t reach GitLab. Check your connection, or open a .zip of the repository instead.');
        });
    let r = await ask();
    // GitLab.com limits archive downloads and sometimes answers 406 while it prepares one: one more try, a moment later.
    if (r.status === 406 || r.status === 429) {
        await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 2500));
        r = await ask();
        if (r.status === 406 || r.status === 429) throw new RepositoryError('GitLab is limiting archive downloads right now. Try again in a minute, or download the project as a .zip and open that.');
    }
    if (r.status === 404 || r.status === 401) throw new RepositoryError(`GitLab has no public project ${ref.path}. Private projects can’t be opened by URL: download a .zip, or use the Companion on a clone.`);
    if (!r.ok) throw new RepositoryError(`GitLab answered ${r.status} for ${ref.path}.`);
    const data = await readWithProgress(r, options);
    if (!options.unzip) throw new RepositoryError('No unzip available');
    return { name: ref.path, entries: options.unzip(data), truncated: false };
}

/** The body, reporting kilobytes read (of the total when the server says). */
async function readWithProgress(r: Response, options: RepositoryOptions): Promise<Uint8Array> {
    const total = Math.round(Number(r.headers.get('content-length') ?? 0) / 1024);
    if (!r.body) return new Uint8Array(await r.arrayBuffer());
    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        if (options.isCancelled?.()) {
            await reader.cancel();
            throw new RepositoryError('Cancelled');
        }
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.length;
        options.onProgress?.(Math.round(size / 1024), total);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
        out.set(c, at);
        at += c.length;
    }
    return out;
}
