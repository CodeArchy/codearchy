/**
 * @codearchy/platform-browser/client — the UI-thread side of the browser
 * engine. WorkerEngine implements EngineClient over a module Worker running
 * runEngineWorker(); the helpers turn a folder picker, an
 * <input webkitdirectory> or a drag-and-drop into an EngineSource.
 *
 * Imports no engine code, so it adds next to nothing to a UI bundle.
 */
import type { EdgeExplanation, EngineClient, EngineEvent, NodeDetails, NodeSummary, SearchResult, View, ViewRequest, WorkspaceSummary } from '@codearchy/protocol';
import type { EngineReply, EngineRequest, EngineSource } from './engine/messages.js';

export type { EngineSource } from './engine/messages.js';

export class WorkerEngine implements EngineClient {
    private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
    private readonly listeners = new Set<(e: EngineEvent) => void>();
    private readonly hostListeners = new Set<(e: unknown) => void>();
    private nextId = 1;

    constructor(private readonly worker: Worker) {
        worker.onmessage = (ev: MessageEvent<EngineReply>) => {
            const msg = ev.data;
            if ('event' in msg) {
                for (const l of this.listeners) l(msg.event);
                return;
            }
            if ('hostEvent' in msg) {
                for (const l of this.hostListeners) l(msg.hostEvent);
                return;
            }
            const p = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if ('error' in msg) p?.reject(new Error(msg.error));
            else p?.resolve(msg.result);
        };
        worker.onerror = (ev) => {
            const err = new Error(ev.message || 'engine worker failed to load');
            for (const p of this.pending.values()) p.reject(err);
            this.pending.clear();
        };
    }

    /** Any request, including host-specific handlers. */
    call<T>(method: string, params: Record<string, unknown> = {}, transfer: Transferable[] = []): Promise<T> {
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
            this.worker.postMessage({ id, method, params } satisfies EngineRequest, transfer);
        });
    }

    /** Opens (indexes) a workspace; replaces the previous one. */
    open(source: EngineSource): Promise<WorkspaceSummary> {
        return this.call('open', { source }, source.kind === 'zip' ? [source.data] : []);
    }

    /** Events a host handler sent (HandlerContext.emit); their shape is the host's. Returns an unsubscribe. */
    onHostEvent(listener: (event: unknown) => void): () => void {
        this.hostListeners.add(listener);
        return () => this.hostListeners.delete(listener);
    }

    /** Progress while opening; `changed` when a watched folder changes. Returns an unsubscribe. */
    onEvent(listener: (e: EngineEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    view(request: ViewRequest): Promise<View | undefined> {
        return this.call('view', { request });
    }
    children(key: string): Promise<NodeSummary[] | undefined> {
        return this.call('children', { key });
    }
    describe(key: string): Promise<NodeDetails | undefined> {
        return this.call('describe', { key });
    }
    explain(source: string, target: string): Promise<EdgeExplanation | undefined> {
        return this.call('explain', { source, target });
    }
    search(query: string): Promise<SearchResult[]> {
        return this.call('search', { query });
    }
    /** A workspace file's text (the code viewer). */
    readFile(path: string): Promise<string | undefined> {
        return this.call('readFile', { path });
    }

    dispose(): void {
        this.worker.terminate();
        this.listeners.clear();
    }
}

// ─── sources ────────────────────────────────────────────────────────────────

const SKIP = /(^|\/)(node_modules|\.git)\//;

/** A folder from the File System Access picker (Chromium), watched for changes. Undefined if cancelled or unsupported. */
export async function pickDirectory(): Promise<EngineSource | undefined> {
    const picker = (globalThis as { showDirectoryPicker?: (o?: { mode?: string }) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
    if (!picker) return undefined;
    try {
        return { kind: 'handle', handle: await picker.call(globalThis, { mode: 'read' }), watch: true };
    } catch (err) {
        if ((err as DOMException).name === 'AbortError') return undefined;
        throw err;
    }
}

/** True when the browser can pick a folder in place (and watch it). */
export function canPickDirectory(): boolean {
    return typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

/** From <input type="file" webkitdirectory>: paths are relative to the chosen folder. */
export function sourceFromFileList(list: FileList | File[]): EngineSource | undefined {
    const all = [...list] as Array<File & { webkitRelativePath?: string }>;
    if (all.length === 0) return undefined;
    const rel = (f: File & { webkitRelativePath?: string }) => f.webkitRelativePath || f.name;
    const name = rel(all[0]).split('/')[0] || 'folder';
    const files = all
        .map((file) => ({ path: rel(file).split('/').slice(1).join('/') || file.name, file }))
        .filter((f) => !SKIP.test(`${f.path}/`));
    return { kind: 'files', name, files };
}

/** A single dropped .zip, or a list with one. */
export async function sourceFromZip(file: File): Promise<EngineSource> {
    return { kind: 'zip', name: file.name.replace(/\.zip$/i, ''), data: await file.arrayBuffer() };
}

export function isZip(file: File): boolean {
    return /\.zip$/i.test(file.name) || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
}

/**
 * A drag-and-drop: a folder (read in place and watched in Chromium, read as
 * files elsewhere), a .zip, or loose files.
 */
export async function sourceFromDrop(dt: DataTransfer): Promise<EngineSource | undefined> {
    // A DataTransfer is emptied once the drop event has been dispatched: read
    // everything synchronously, before the first await.
    const files = [...dt.files];
    const items = [...dt.items].filter((i) => i.kind === 'file');
    const first = items.length === 1 ? (items[0] as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> }) : undefined;
    const handlePromise = first?.getAsFileSystemHandle?.();
    const entry = first?.webkitGetAsEntry?.();
    const firstFile = first?.getAsFile();
    if (first) {
        const handle = await handlePromise?.catch(() => null);
        if (handle?.kind === 'directory') return { kind: 'handle', handle: handle as FileSystemDirectoryHandle, watch: true };
        if (firstFile && isZip(firstFile)) return sourceFromZip(firstFile);
        if (entry?.isDirectory) return { kind: 'files', name: entry.name, files: await readEntries(entry as FileSystemDirectoryEntry) };
    }
    if (files.length === 1 && isZip(files[0])) return sourceFromZip(files[0]);
    if (files.length === 0) return undefined;
    return { kind: 'files', name: 'dropped files', files: files.map((file) => ({ path: file.name, file })) };
}

/** Every file under a dropped directory entry (webkitGetAsEntry), with paths relative to it. */
async function readEntries(root: FileSystemDirectoryEntry): Promise<Array<{ path: string; file: File }>> {
    const out: Array<{ path: string; file: File }> = [];
    const walk = async (dir: FileSystemDirectoryEntry, prefix: string): Promise<void> => {
        const reader = dir.createReader();
        for (;;) {
            const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
            if (batch.length === 0) break;
            for (const e of batch) {
                const path = prefix ? `${prefix}/${e.name}` : e.name;
                if (SKIP.test(`${path}/`)) continue;
                if (e.isDirectory) await walk(e as FileSystemDirectoryEntry, path);
                else out.push({ path, file: await new Promise<File>((resolve, reject) => (e as FileSystemFileEntry).file(resolve, reject)) });
            }
        }
    };
    await walk(root, '');
    return out;
}
