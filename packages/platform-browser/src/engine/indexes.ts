/**
 * The indexes this browser keeps (one SQLite database per codebase, in the
 * OPFS pool), and what the user chose to do with them (the app's Settings):
 *
 *   catalog        what each index is, how big it is, when it was last opened;
 *   limit          off by default. When on, the least recently opened indexes
 *                  are removed once together they pass the user's maximum. The
 *                  open one never is;
 *   export folder  a folder on the device (Chromium). Each index is copied there
 *                  when it's built or changes, and an index this browser doesn't
 *                  have is imported from there when its codebase opens. So
 *                  another browser, or this one after its storage was cleared,
 *                  picks up where it left off: unchanged files aren't parsed again.
 *
 * An index holds what CodeArchy computed (files, symbols, dependencies), not the
 * source code: a folder is read in place, a repository is held in memory only.
 *
 * The live database stays in OPFS (SQLite's fast sync access only works there);
 * the export folder gets copies.
 */
import { IdbKeyValue } from '../stores.js';
import type { SqlitePool } from '../storage.js';

export type IndexSourceKind = 'folder' | 'files' | 'zip' | 'sample' | 'repository';

export interface StoredIndex {
    /** The database's file name in the pool, e.g. `react.db` (its key). */
    db: string;
    /** The codebase's name, as shown. */
    name: string;
    source?: IndexSourceKind;
    /** A repository's URL, so another browser can open the same one. */
    url?: string;
    sizeBytes: number;
    files?: number;
    /** 0 when it predates the catalog. */
    openedAt: number;
    /** When it was last copied to the export folder. */
    exportedAt?: number;
}

export interface StorageSettings {
    /** Off by default: nothing is removed unless the user turns it on. */
    limit: { enabled: boolean; maxMB: number };
}

export const DEFAULT_STORAGE_SETTINGS: StorageSettings = { limit: { enabled: false, maxMB: 500 } };
/** The smallest and largest maximum the limit accepts (MB). */
export const STORAGE_LIMIT_RANGE = { min: 10, max: 100_000 } as const;

export interface ExportFolderStatus {
    name: string;
    /** For the page to ask for access again (only a page can, on a click). */
    handle: FileSystemDirectoryHandle;
    permission: PermissionState;
    /** Indexes in the folder (other browsers' too). */
    indexes: number;
    lastExportAt?: number;
    lastError?: string;
}

export interface StorageStatus {
    /** False when indexes can't be kept here: private browsing, or another tab of the app holds the storage. */
    persistent: boolean;
    reason?: string;
    /** Most recently opened first. */
    indexes: StoredIndex[];
    totalBytes: number;
    /** The open codebase's index. */
    current?: string;
    settings: StorageSettings;
    /** Whether the engine can write files into a folder (the page also needs showDirectoryPicker). */
    canExport: boolean;
    exportFolder?: ExportFolderStatus;
    /** Everything this site keeps in the browser: the indexes, the voice model, the app's own files. */
    origin?: { usage: number; quota: number };
}

interface Catalog {
    settings: StorageSettings;
    entries: Record<string, StoredIndex>;
}

type ManifestEntry = Omit<StoredIndex, 'openedAt' | 'exportedAt'>;

/** The list the export folder carries, so a browser that imports knows what each file is. */
const MANIFEST = 'codearchy-indexes.json';
const EXPORT_DEBOUNCE_MS = 5000;

type PermissionHandle = FileSystemDirectoryHandle & { queryPermission?(o: { mode: 'readwrite' }): Promise<PermissionState> };

export class IndexLibrary {
    private readonly kv: IdbKeyValue;
    private catalog?: Promise<Catalog>;
    private queue: Promise<unknown> = Promise.resolve();
    private exportError?: string;
    private lastExportAt?: number;
    private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

    /** `pool` gives no pool where indexes aren't kept (see StorageStatus.persistent). */
    constructor(
        poolName: string,
        private readonly pool: () => Promise<{ pool?: SqlitePool; reason?: string }>
    ) {
        this.kv = new IdbKeyValue(`${poolName}-indexes`);
    }

    /** One change at a time: the catalog is read, changed and written whole. */
    private serial<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.queue.then(fn, fn);
        this.queue = run.catch(() => undefined);
        return run;
    }

    private load(): Promise<Catalog> {
        this.catalog ??= this.kv.get<Catalog>('catalog').then((c) => ({
            settings: normalizeSettings(c?.settings),
            entries: c?.entries && typeof c.entries === 'object' ? c.entries : {},
        }));
        return this.catalog;
    }

    private async save(c: Catalog): Promise<void> {
        await this.kv.set('catalog', c);
    }

    /** The catalog matched to the pool: indexes made before it existed are listed, deleted ones dropped. */
    private async reconcile(pool: SqlitePool, c: Catalog): Promise<void> {
        const inPool = new Set(pool.getFileNames().filter((n) => n.endsWith('.db')).map((n) => n.replace(/^\//, '')));
        let dirty = false;
        for (const db of Object.keys(c.entries)) {
            if (!inPool.has(db)) {
                delete c.entries[db];
                dirty = true;
            }
        }
        for (const db of inPool) {
            if (c.entries[db]) continue;
            let sizeBytes = 0;
            try {
                sizeBytes = pool.exportFile(`/${db}`).byteLength;
            } catch {
                // unreadable right now: its size shows once it's opened here
            }
            c.entries[db] = { db, name: db.replace(/\.db$/, ''), sizeBytes, openedAt: 0 };
            dirty = true;
        }
        if (dirty) await this.save(c);
    }

    // ── export folder ───────────────────────────────────────────────────────

    private async folder(): Promise<PermissionHandle | undefined> {
        return (await this.kv.get<PermissionHandle>('exportFolder')) ?? undefined;
    }

    private async writable(): Promise<FileSystemDirectoryHandle | undefined> {
        const dir = await this.folder();
        if (!dir) return undefined;
        if ((await permission(dir)) !== 'granted') {
            this.exportError = 'This browser needs your OK to use the folder again.';
            return undefined;
        }
        return dir;
    }

    /**
     * Before a codebase opens: if this browser has no index for it and the export folder does, the
     * folder's copy is imported, so the codebase opens without parsing what hasn't changed.
     */
    beforeOpen(db: string): Promise<boolean> {
        return this.serial(async () => {
            const { pool } = await this.pool();
            if (!pool || pool.getFileNames().includes(`/${db}`)) return false;
            const dir = await this.writable();
            if (!dir) return false;
            try {
                const file = await (await dir.getFileHandle(db)).getFile();
                const bytes = new Uint8Array(await file.arrayBuffer());
                await pool.reserveMinimumCapacity(Number(pool.getFileCount()) + 3);
                pool.importDb(`/${db}`, bytes);
                const c = await this.load();
                const known = (await readManifest(dir))[db];
                c.entries[db] = { ...(known ?? { name: db.replace(/\.db$/, '') }), db, sizeBytes: bytes.byteLength, openedAt: Date.now(), exportedAt: file.lastModified };
                await this.save(c);
                return true;
            } catch {
                // not in the folder (NotFoundError), or not a database: index from scratch
                return false;
            }
        });
    }

    /** After a codebase was indexed (or reopened): recorded, the limit applied, and copied to the export folder. Returns the names the limit removed. */
    opened(entry: ManifestEntry): Promise<string[]> {
        return this.serial(async () => {
            const c = await this.load();
            c.entries[entry.db] = { ...c.entries[entry.db], ...entry, openedAt: Date.now() };
            await this.save(c);
            const removed = await this.applyLimit(c, entry.db);
            this.scheduleExport(entry.db, 0);
            return removed;
        });
    }

    /** A live folder changed: the new size is recorded, and the export follows a few seconds later. */
    changed(db: string, sizeBytes: number, files: number): Promise<void> {
        return this.serial(async () => {
            const c = await this.load();
            const e = c.entries[db];
            if (!e) return;
            e.sizeBytes = sizeBytes;
            e.files = files;
            await this.save(c);
            this.scheduleExport(db, EXPORT_DEBOUNCE_MS);
        });
    }

    private scheduleExport(db: string, delay: number): void {
        clearTimeout(this.pending.get(db));
        this.pending.set(
            db,
            setTimeout(() => {
                this.pending.delete(db);
                void this.serial(() => this.exportOne(db)).catch(() => undefined);
            }, delay)
        );
    }

    private async exportOne(db: string, dir?: FileSystemDirectoryHandle): Promise<boolean> {
        const target = dir ?? (await this.writable());
        const { pool } = await this.pool();
        if (!target || !pool) return false;
        const c = await this.load();
        const e = c.entries[db];
        if (!e || !pool.getFileNames().includes(`/${db}`)) return false;
        try {
            await writeFile(target, db, pool.exportFile(`/${db}`));
            e.exportedAt = Date.now();
            await this.save(c);
            const manifest = await readManifest(target);
            manifest[db] = { db: e.db, name: e.name, sizeBytes: e.sizeBytes, ...(e.source ? { source: e.source } : {}), ...(e.url ? { url: e.url } : {}), ...(e.files !== undefined ? { files: e.files } : {}) };
            await writeFile(target, MANIFEST, new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
            this.lastExportAt = e.exportedAt;
            this.exportError = undefined;
            return true;
        } catch (err) {
            this.exportError = `Couldn't write to the folder: ${(err as Error).message}`;
            return false;
        }
    }

    /** Copies every index to the export folder now. Returns how many were copied. */
    exportAll(): Promise<number> {
        return this.serial(async () => {
            const dir = await this.writable();
            if (!dir) return 0;
            let n = 0;
            for (const db of Object.keys((await this.load()).entries)) if (await this.exportOne(db, dir)) n++;
            return n;
        });
    }

    /** Sets (or, with undefined, forgets) the export folder; a new folder gets every index at once. */
    async setExportFolder(handle: FileSystemDirectoryHandle | undefined): Promise<void> {
        await this.serial(async () => {
            if (handle) await this.kv.set('exportFolder', handle);
            else await this.kv.delete('exportFolder');
            this.exportError = undefined;
            this.lastExportAt = undefined;
        });
        if (handle) await this.exportAll();
    }

    // ── limit and deleting ──────────────────────────────────────────────────

    private async applyLimit(c: Catalog, current: string | undefined): Promise<string[]> {
        if (!c.settings.limit.enabled) return [];
        const { pool } = await this.pool();
        if (!pool) return [];
        const max = c.settings.limit.maxMB * 1024 * 1024;
        let total = Object.values(c.entries).reduce((s, e) => s + e.sizeBytes, 0);
        const removed: string[] = [];
        for (const e of Object.values(c.entries).sort((a, b) => a.openedAt - b.openedAt)) {
            if (total <= max) break;
            if (e.db === current) continue;
            unlink(pool, e.db);
            delete c.entries[e.db];
            total -= e.sizeBytes;
            removed.push(e.name);
        }
        if (removed.length) await this.save(c);
        return removed;
    }

    /** Saves the settings and applies the limit at once. Returns the names it removed. */
    setSettings(settings: unknown, current: string | undefined): Promise<string[]> {
        return this.serial(async () => {
            const c = await this.load();
            c.settings = normalizeSettings(settings);
            await this.save(c);
            return this.applyLimit(c, current);
        });
    }

    /** Deletes one index from this browser (its copy in the export folder stays). */
    remove(db: string, current: string | undefined): Promise<void> {
        return this.serial(async () => {
            if (db === current) throw new Error('That codebase is open: open another one first, then delete its index.');
            const c = await this.load();
            const { pool } = await this.pool();
            if (pool) unlink(pool, db);
            delete c.entries[db];
            await this.save(c);
        });
    }

    // ── status ──────────────────────────────────────────────────────────────

    status(current: string | undefined): Promise<StorageStatus> {
        return this.serial(async () => {
            const c = await this.load();
            const { pool, reason } = await this.pool();
            if (pool) await this.reconcile(pool, c);
            const indexes = Object.values(c.entries).sort((a, b) => b.openedAt - a.openedAt);
            const dir = await this.folder();
            let exportFolder: ExportFolderStatus | undefined;
            if (dir) {
                const state = await permission(dir);
                exportFolder = {
                    name: dir.name,
                    handle: dir,
                    permission: state,
                    indexes: state === 'granted' ? Object.keys(await readManifest(dir)).length : 0,
                    ...(this.lastExportAt ? { lastExportAt: this.lastExportAt } : {}),
                    ...(this.exportError ? { lastError: this.exportError } : {}),
                };
            }
            const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
            const fileHandle = (globalThis as { FileSystemFileHandle?: { prototype: object } }).FileSystemFileHandle;
            return {
                persistent: !!pool,
                ...(reason ? { reason } : {}),
                indexes,
                totalBytes: indexes.reduce((s, e) => s + e.sizeBytes, 0),
                ...(current && c.entries[current] ? { current } : {}),
                settings: c.settings,
                canExport: !!fileHandle && 'createWritable' in fileHandle.prototype,
                ...(exportFolder ? { exportFolder } : {}),
                ...(estimate?.quota ? { origin: { usage: estimate.usage ?? 0, quota: estimate.quota } } : {}),
            };
        });
    }
}

// ─── helpers ────────────────────────────────────────────────────────────────

export function normalizeSettings(raw: unknown): StorageSettings {
    const limit = (raw as Partial<StorageSettings> | undefined)?.limit;
    const maxMB = Number(limit?.maxMB);
    return {
        limit: {
            enabled: limit?.enabled === true,
            maxMB: Number.isFinite(maxMB) && limit?.maxMB !== undefined ? Math.round(Math.min(STORAGE_LIMIT_RANGE.max, Math.max(STORAGE_LIMIT_RANGE.min, maxMB))) : DEFAULT_STORAGE_SETTINGS.limit.maxMB,
        },
    };
}

async function permission(dir: PermissionHandle): Promise<PermissionState> {
    if (!dir.queryPermission) return 'granted';
    return dir.queryPermission({ mode: 'readwrite' }).catch(() => 'prompt' as const);
}

function unlink(pool: SqlitePool, db: string): void {
    pool.unlink(`/${db}`);
    pool.unlink(`/${db}-journal`);
}

async function writeFile(dir: FileSystemDirectoryHandle, name: string, bytes: Uint8Array): Promise<void> {
    const handle = (await dir.getFileHandle(name, { create: true })) as FileSystemFileHandle & { createWritable(): Promise<{ write(d: BufferSource): Promise<void>; close(): Promise<void> }> };
    const out = await handle.createWritable();
    await out.write(bytes as Uint8Array<ArrayBuffer>);
    await out.close();
}

async function readManifest(dir: FileSystemDirectoryHandle): Promise<Record<string, ManifestEntry>> {
    try {
        const parsed = JSON.parse(await (await (await dir.getFileHandle(MANIFEST)).getFile()).text()) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, ManifestEntry>) : {};
    } catch {
        return {};
    }
}
