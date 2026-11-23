/**
 * StoragePort over Node's built-in SQLite (node:sqlite). Available in Node
 * >= 22.13; FTS5 only from 22.18 / 24.0 (not 23.x), which is probed at open
 * (Spike A). VS Code >= 1.104 ships a Node with both.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SqlRow, SqlStatement, SqlValue, StoragePort } from '@codearchy/core';

export interface NodeSqliteOptions {
    /** Database file; ":memory:" for an in-memory database. */
    file: string;
}

interface DatabaseSyncLike {
    exec(sql: string): void;
    prepare(sql: string): {
        run(...params: SqlValue[]): unknown;
        get(...params: SqlValue[]): unknown;
        all(...params: SqlValue[]): unknown[];
    };
    close(): void;
}

/** Opens the database, or returns undefined when node:sqlite is unavailable in this runtime. */
export async function openNodeSqlite(options: NodeSqliteOptions): Promise<StoragePort | undefined> {
    let DatabaseSync: new (file: string) => DatabaseSyncLike;
    try {
        // Runtime probe (not a static import): older runtimes don't have the module,
        // and bundlers must leave it to the host's Node.
        const specifier = 'node:sqlite';
        ({ DatabaseSync } = (await import(specifier)) as { DatabaseSync: new (file: string) => DatabaseSyncLike });
    } catch {
        return undefined;
    }
    if (options.file !== ':memory:') fs.mkdirSync(path.dirname(options.file), { recursive: true });
    const db = new DatabaseSync(options.file);

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
        exec: (sql) => db.exec(sql),
        prepare(sql): SqlStatement {
            const st = db.prepare(sql);
            return {
                run: (...params) => void st.run(...params),
                get: (...params) => st.get(...params) as SqlRow | undefined,
                all: (...params) => st.all(...params) as SqlRow[],
            };
        },
        transaction<T>(fn: () => T): T {
            // Nested calls join the outer transaction.
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
