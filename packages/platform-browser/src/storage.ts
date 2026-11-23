/**
 * StoragePort over the official SQLite WASM build.
 *
 *   'opfs-sahpool'  persistent, in OPFS, without COOP/COEP (Spike D: works in
 *                   Chromium, Firefox and WebKit; must run inside a Worker; one
 *                   connection per database, so coordinate tabs with Web Locks).
 *   'memory'        in-memory (e.g. Safari Private Browsing, where OPFS sync
 *                   access is unavailable).
 *
 * The SQL and schema are identical to node:sqlite, so @codearchy/core's
 * IndexStore runs unchanged.
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { SqlRow, SqlStatement, SqlValue, StoragePort } from '@codearchy/core';

export interface SqliteWasmOptions {
    mode: 'opfs-sahpool' | 'memory';
    /** Database name within the pool (opfs-sahpool). */
    name?: string;
    /** OPFS pool directory name (opfs-sahpool). */
    poolName?: string;
    /** URL of sqlite3.wasm, when it isn't next to the bundled module. */
    wasmUrl?: string;
}

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;
type OoDb = InstanceType<Sqlite3['oo1']['DB']>;

/** The module accepts Emscripten options at runtime, though its typings declare none. */
const initModule = sqlite3InitModule as unknown as (options: {
    print?: (s: string) => void;
    printErr?: (s: string) => void;
    locateFile?: (file: string) => string;
}) => Promise<Sqlite3>;

let sqlite3: Promise<Sqlite3> | undefined;

function init(wasmUrl?: string): Promise<Sqlite3> {
    sqlite3 ??= initModule({
        print: () => undefined,
        printErr: () => undefined,
        ...(wasmUrl ? { locateFile: (file: string) => (file.endsWith('.wasm') ? wasmUrl : file) } : {}),
    });
    return sqlite3;
}

/** Whether OPFS sync access handles work here (false in Safari Private Browsing, or outside a Worker). */
export async function opfsSyncAccessAvailable(): Promise<boolean> {
    try {
        const root = await navigator.storage.getDirectory();
        const handle = await root.getFileHandle('.codearchy-probe', { create: true });
        const access = await (handle as FileSystemFileHandle & { createSyncAccessHandle(): Promise<{ close(): void }> }).createSyncAccessHandle();
        access.close();
        await root.removeEntry('.codearchy-probe');
        return true;
    } catch {
        return false;
    }
}

export async function openSqliteWasm(options: SqliteWasmOptions): Promise<StoragePort> {
    const s3 = await init(options.wasmUrl);
    let db: OoDb;
    if (options.mode === 'opfs-sahpool') {
        const pool = await s3.installOpfsSAHPoolVfs({ name: options.poolName ?? 'codearchy' });
        db = new pool.OpfsSAHPoolDb(`/${options.name ?? 'codearchy-index.db'}`);
    } else {
        db = new s3.oo1.DB(':memory:');
    }

    let fts5 = false;
    try {
        db.exec('CREATE VIRTUAL TABLE temp.__codearchy_fts_probe USING fts5(x); DROP TABLE temp.__codearchy_fts_probe;');
        fts5 = true;
    } catch {
        fts5 = false;
    }

    let depth = 0;
    return {
        features: { fts5 },
        exec: (sql) => void db.exec(sql),
        prepare(sql): SqlStatement {
            const st = db.prepare(sql);
            const bind = (params: SqlValue[]) => {
                st.reset(true);
                if (params.length) st.bind(params as never);
            };
            return {
                run: (...params) => {
                    bind(params);
                    st.step();
                    st.reset();
                },
                get: (...params) => {
                    bind(params);
                    const row = st.step() ? (st.get({}) as SqlRow) : undefined;
                    st.reset();
                    return row;
                },
                all: (...params) => {
                    bind(params);
                    const rows: SqlRow[] = [];
                    while (st.step()) rows.push(st.get({}) as SqlRow);
                    st.reset();
                    return rows;
                },
            };
        },
        transaction<T>(fn: () => T): T {
            if (depth > 0) return fn();
            depth++;
            db.exec('BEGIN');
            try {
                const result = fn();
                db.exec('COMMIT');
                return result;
            } catch (err) {
                db.exec('ROLLBACK');
                throw err;
            } finally {
                depth--;
            }
        },
        close: () => db.close(),
    };
}
