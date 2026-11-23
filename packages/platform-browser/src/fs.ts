/**
 * FileSystemPort adapters for browsers.
 *
 *   HandleFileSystem  over a FileSystemDirectoryHandle: a folder opened with
 *                     the File System Access API (Chromium), or an OPFS
 *                     directory (every engine; same API).
 *   MemoryFileSystem  over Blobs/strings: dropped folders, <input webkitdirectory>,
 *                     unpacked zips.
 *
 * Paths are workspace-relative POSIX; anything that isn't a clean path inside
 * the root (empty, ".", "..", absolute) is rejected, never resolved.
 */
import type { FileStat, FileSystemPort } from '@codearchy/core';

/** Splits a workspace path into segments, or undefined if it isn't a clean relative path. */
function segments(path: string): string[] | undefined {
    if (!path || path.startsWith('/') || path.includes('\\')) return undefined;
    const parts = path.split('/');
    return parts.every((p) => p !== '' && p !== '.' && p !== '..') ? parts : undefined;
}

export class HandleFileSystem implements FileSystemPort {
    private readonly dirs = new Map<string, Promise<FileSystemDirectoryHandle | undefined>>();

    constructor(readonly root: FileSystemDirectoryHandle) {}

    async readText(path: string): Promise<string | undefined> {
        const file = await this.file(path);
        try {
            return file ? await file.text() : undefined;
        } catch {
            return undefined;
        }
    }

    async stat(path: string): Promise<FileStat | undefined> {
        const file = await this.file(path);
        if (file) return { size: file.size, isFile: true, mtimeMs: file.lastModified };
        const parts = segments(path);
        if (parts && (await this.dir(parts))) return { size: 0, isFile: false };
        return undefined;
    }

    private async file(path: string): Promise<File | undefined> {
        const parts = segments(path);
        if (!parts) return undefined;
        const dir = await this.dir(parts.slice(0, -1));
        if (!dir) return undefined;
        try {
            return await (await dir.getFileHandle(parts[parts.length - 1])).getFile();
        } catch {
            return undefined;
        }
    }

    private dir(parts: string[]): Promise<FileSystemDirectoryHandle | undefined> {
        const key = parts.join('/');
        let pending = this.dirs.get(key);
        if (!pending) {
            pending = (async () => {
                if (parts.length === 0) return this.root;
                const parent = await this.dir(parts.slice(0, -1));
                if (!parent) return undefined;
                try {
                    return await parent.getDirectoryHandle(parts[parts.length - 1]);
                } catch {
                    return undefined;
                }
            })();
            this.dirs.set(key, pending);
        }
        return pending;
    }
}

const LIST_SKIP = new Set(['.git', 'node_modules', '.hg', '.svn']);

/** Recursively lists files under a directory handle (POSIX, relative). */
export async function listHandleFiles(root: FileSystemDirectoryHandle, prefix = ''): Promise<string[]> {
    const out: string[] = [];
    for await (const [name, handle] of root.entries()) {
        if (LIST_SKIP.has(name)) continue;
        const path = prefix ? `${prefix}/${name}` : name;
        if (handle.kind === 'directory') out.push(...(await listHandleFiles(handle as FileSystemDirectoryHandle, path)));
        else out.push(path);
    }
    return out;
}

export interface MemoryEntry {
    data: Blob | string;
    mtimeMs?: number;
}

export class MemoryFileSystem implements FileSystemPort {
    private readonly files: Map<string, MemoryEntry>;
    private readonly dirs = new Set<string>();

    constructor(files: Iterable<[string, MemoryEntry]>) {
        this.files = new Map();
        for (const [path, entry] of files) {
            const parts = segments(path);
            if (!parts) continue; // skip anything that isn't a clean relative path
            this.files.set(path, entry);
            for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join('/'));
        }
    }

    /**
     * From <input webkitdirectory> or a dropped folder: `webkitRelativePath`
     * starts with the folder's own name, which is stripped to make paths
     * relative to the workspace root.
     */
    static fromFiles(files: Iterable<File>): MemoryFileSystem {
        const entries: Array<[string, MemoryEntry]> = [];
        for (const f of files) {
            const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
            const path = rel.includes('/') ? rel.slice(rel.indexOf('/') + 1) : rel;
            entries.push([path, { data: f, mtimeMs: f.lastModified }]);
        }
        return new MemoryFileSystem(entries);
    }

    paths(): string[] {
        return [...this.files.keys()];
    }

    /** Structured-cloneable form, for handing the same files to Web Workers. */
    entries(): Array<[string, MemoryEntry]> {
        return [...this.files];
    }

    async readText(path: string): Promise<string | undefined> {
        const e = this.files.get(path);
        if (!e) return undefined;
        return typeof e.data === 'string' ? e.data : e.data.text();
    }

    async stat(path: string): Promise<FileStat | undefined> {
        const e = this.files.get(path);
        if (e) {
            const size = typeof e.data === 'string' ? new TextEncoder().encode(e.data).length : e.data.size;
            return { size, isFile: true, ...(e.mtimeMs !== undefined ? { mtimeMs: e.mtimeMs } : {}) };
        }
        return this.dirs.has(path) ? { size: 0, isFile: false } : undefined;
    }
}
