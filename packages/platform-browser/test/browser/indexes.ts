/**
 * Checks for the indexes a browser keeps (src/engine/indexes.ts and the pool
 * capacity in src/storage.ts), run inside the conformance worker in each engine.
 */
import { IndexLibrary } from '../../src/engine/indexes.js';
import { openSqliteWasm, opfsPool, opfsSyncAccessAvailable } from '../../src/storage.js';

type Result = { name: string; ok: boolean; ms: number; error?: string; skipped?: boolean };

const POOL = 'codearchy-index-test';
const WASM = '/sqlite/sqlite3.wasm';
const MB = 1024 * 1024;

async function check(name: string, body: () => Promise<void | 'skip'>): Promise<Result> {
    const t = performance.now();
    try {
        const skipped = (await body()) === 'skip';
        return { name, ok: true, ms: Math.round(performance.now() - t), ...(skipped ? { skipped } : {}) };
    } catch (err) {
        return { name, ok: false, ms: Math.round(performance.now() - t), error: (err as Error).stack ?? String(err) };
    }
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

/** Makes an index database the way the engine does, with one row to read back. */
async function makeIndex(db: string, value: string): Promise<void> {
    const port = await openSqliteWasm({ mode: 'opfs-sahpool', name: db, poolName: POOL, wasmUrl: WASM });
    port.exec('CREATE TABLE IF NOT EXISTS t (v TEXT); DELETE FROM t;');
    port.prepare('INSERT INTO t (v) VALUES (?)').run(value);
    port.close();
}

async function readIndex(db: string): Promise<string | undefined> {
    const port = await openSqliteWasm({ mode: 'opfs-sahpool', name: db, poolName: POOL, wasmUrl: WASM });
    try {
        return port.prepare('SELECT v FROM t').get()?.v as string | undefined;
    } finally {
        port.close();
    }
}

export async function indexChecks(): Promise<Result[]> {
    if (!(await opfsSyncAccessAvailable())) return [{ name: 'browser indexes: (no OPFS sync access here)', ok: true, ms: 0, skipped: true }];
    const pool = await opfsPool({ poolName: POOL, wasmUrl: WASM });
    await pool.wipeFiles();
    const library = new IndexLibrary(`${POOL}-${Math.random().toString(36).slice(2)}`, async () => ({ pool }));
    const names = Array.from({ length: 8 }, (_, i) => `repo-${i}.db`);
    return [
        await check('browser indexes: the pool grows, so more than five codebases keep their index', async () => {
            for (const db of names) await makeIndex(db, db);
            const stored = pool.getFileNames().filter((n) => n.endsWith('.db'));
            assert(stored.length === names.length, `stored ${stored.length} of ${names.length}: ${stored.join(', ')}`);
            assert((await readIndex('repo-7.db')) === 'repo-7.db', 'the last one reads back');
        }),
        await check('browser indexes: the catalog lists what the pool holds, with sizes', async () => {
            const s = await library.status(undefined);
            assert(s.persistent, 'persistent');
            assert(s.indexes.length === names.length, `listed ${s.indexes.length}`);
            assert(s.indexes.every((e) => e.sizeBytes > 0), 'every index has a size');
            assert(s.settings.limit.enabled === false, 'the limit is off by default');
            assert(s.totalBytes === s.indexes.reduce((n, e) => n + e.sizeBytes, 0), 'total');
        }),
        await check('browser indexes: the limit is off until turned on, then removes the least recently opened but never the open one', async () => {
            // Opened in order, oldest first; each counted as 4 MB.
            for (const db of names) {
                await library.opened({ db, name: db.replace('.db', ''), sizeBytes: 4 * MB });
                await new Promise((r) => setTimeout(r, 2));
            }
            assert((await library.status(undefined)).indexes.length === names.length, 'nothing removed while the limit is off');
            // 8 × 4 MB = 32 MB, limit 12 MB: the oldest go first, skipping repo-0 (open), until 12 MB are left
            // (repo-0, repo-6, repo-7) → removes repo-1 … repo-5.
            const removed = await library.setSettings({ limit: { enabled: true, maxMB: 12 } }, 'repo-0.db');
            assert(removed.join(',') === 'repo-1,repo-2,repo-3,repo-4,repo-5', `removed ${removed.join(',')}`);
            const left = (await library.status('repo-0.db')).indexes.map((e) => e.db).sort();
            assert(left.join(',') === 'repo-0.db,repo-6.db,repo-7.db', `left ${left.join(',')}`);
            assert(!pool.getFileNames().includes('/repo-1.db'), 'the database is gone from the pool');
            await library.setSettings({ limit: { enabled: false, maxMB: 10 } }, 'repo-0.db');
        }),
        await check('browser indexes: the open codebase\'s index can\'t be deleted; another can', async () => {
            let refused = false;
            await library.remove('repo-0.db', 'repo-0.db').catch(() => (refused = true));
            assert(refused, 'deleting the open one is refused');
            await library.remove('repo-6.db', 'repo-0.db');
            assert(!pool.getFileNames().includes('/repo-6.db'), 'deleted');
        }),
        await check('browser indexes: an export folder gets a copy of each, and a browser without one imports it', async () => {
            const fileHandle = (globalThis as { FileSystemFileHandle?: { prototype: object } }).FileSystemFileHandle;
            if (!fileHandle || !('createWritable' in fileHandle.prototype)) return 'skip';
            const root = await navigator.storage.getDirectory();
            await root.removeEntry('index-export-test', { recursive: true }).catch(() => undefined);
            const folder = await root.getDirectoryHandle('index-export-test', { create: true });
            await library.setExportFolder(folder);
            const s = await library.status(undefined);
            assert(s.exportFolder?.name === 'index-export-test', `folder ${s.exportFolder?.name}`);
            assert(s.exportFolder.indexes === 2, `the manifest lists ${s.exportFolder.indexes} (repo-0, repo-7)`);
            assert(!s.exportFolder.lastError, `error: ${s.exportFolder.lastError}`);
            // This browser loses repo-7's index (cleared storage, or another browser): it comes back from the folder.
            await library.remove('repo-7.db', undefined);
            assert(!pool.getFileNames().includes('/repo-7.db'), 'removed here');
            assert(await library.beforeOpen('repo-7.db'), 'imported');
            assert((await readIndex('repo-7.db')) === 'repo-7.db', 'the imported index reads back');
            assert(!(await library.beforeOpen('repo-7.db')), 'not imported again while this browser has it');
            assert(!(await library.beforeOpen('missing.db')), 'nothing to import');
            await library.setExportFolder(undefined);
            assert(!(await library.status(undefined)).exportFolder, 'forgotten');
        }),
    ];
}
