/**
 * The persistent index: per-file facts (symbols, imports, namespace,
 * references) keyed by workspace path, plus manifests and symbol search.
 * It's a cache of derived data: an unknown or older schema is rebuilt, never
 * migrated in place, and facts produced by a different extractor version are
 * treated as stale.
 *
 * Schema v1 is the foundation of doc 08's model (`file` + facts); v2 adds each
 * file's flow facts (entrypoints and call sites, as compact JSON).
 */
import type { CallSite, EntryPoint, FileAnalysis, ImportInfo, SymbolInfo, SymbolKind } from '@codearchy/protocol';
import { LANGUAGE_PACKS } from '../languages/index.js';
import type { SqlRow, SqlStatement, StoragePort } from '../ports.js';
import { contentHash } from '../util/hash.js';

export const SCHEMA_VERSION = 2;

/** Bump when extraction logic changes in ways the queries don't capture. */
const EXTRACTOR_REVISION = 2;

/**
 * Identifies the extractor that produced stored facts: changing any language
 * pack's query (or the extractor revision) invalidates previously stored facts.
 */
export const FACTS_VERSION = contentHash(`${EXTRACTOR_REVISION}\n${LANGUAGE_PACKS.map((p) => `${p.id}:${p.query}`).join('\n')}`);

/** What the indexer needs to decide whether a file must be re-parsed. */
export interface StoredFileState {
    contentHash: string;
    size: number;
    mtimeMs: number | null;
    factsVersion: string;
}

export interface SymbolHit {
    path: string;
    name: string;
    kind: string;
    container: string | null;
    startLine: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS file (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  lang TEXT NOT NULL,
  parser TEXT,
  content_hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER,
  namespace TEXT,
  references_json TEXT,
  flow_json TEXT,
  facts_version TEXT NOT NULL,
  indexed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS symbol (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  container TEXT,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  exported INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS symbol_file ON symbol(file_id);
CREATE INDEX IF NOT EXISTS symbol_name ON symbol(name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS import (
  file_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  specifiers_json TEXT NOT NULL,
  is_default INTEGER NOT NULL,
  is_namespace INTEGER NOT NULL,
  line INTEGER
);
CREATE INDEX IF NOT EXISTS import_file ON import(file_id);
CREATE TABLE IF NOT EXISTS manifest (path TEXT PRIMARY KEY, text TEXT NOT NULL);
`;

/** External-content FTS over symbol names: no duplicated text, one prefix index (Spike A). */
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS symbol_fts USING fts5(
  name, container, content='symbol', content_rowid='id',
  tokenize = "unicode61 tokenchars '_'", prefix = '3'
);
CREATE TRIGGER IF NOT EXISTS symbol_ai AFTER INSERT ON symbol BEGIN
  INSERT INTO symbol_fts(rowid, name, container) VALUES (new.id, new.name, new.container);
END;
CREATE TRIGGER IF NOT EXISTS symbol_ad AFTER DELETE ON symbol BEGIN
  INSERT INTO symbol_fts(symbol_fts, rowid, name, container) VALUES ('delete', old.id, old.name, old.container);
END;
`;

const DROP_ALL = `
DROP TRIGGER IF EXISTS symbol_ai; DROP TRIGGER IF EXISTS symbol_ad;
DROP TABLE IF EXISTS symbol_fts; DROP TABLE IF EXISTS import; DROP TABLE IF EXISTS symbol;
DROP TABLE IF EXISTS file; DROP TABLE IF EXISTS manifest; DROP TABLE IF EXISTS meta;
`;

export class IndexStore {
    private readonly stmts: {
        fileId: SqlStatement;
        insertFile: SqlStatement;
        deleteFile: SqlStatement;
        deleteSymbols: SqlStatement;
        deleteImports: SqlStatement;
        insertSymbol: SqlStatement;
        insertImport: SqlStatement;
        updateStat: SqlStatement;
        upsertManifest: SqlStatement;
        deleteManifest: SqlStatement;
    };
    readonly searchEnabled: boolean;
    /** True when an incompatible index was found and rebuilt empty. */
    readonly wasReset: boolean;

    constructor(private readonly db: StoragePort) {
        // busy_timeout: two windows on the same workspace share one index file.
        db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY; PRAGMA busy_timeout = 3000;');
        let reset = false;
        const hasMeta = !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
        if (hasMeta) {
            const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
            const stored = row ? Number(row.value) : NaN;
            const ftsMismatch = db.features.fts5 !== !!db.prepare("SELECT name FROM sqlite_master WHERE name = 'symbol_fts'").get();
            if (stored !== SCHEMA_VERSION || ftsMismatch) {
                db.exec(DROP_ALL);
                reset = true;
            }
        }
        db.exec(SCHEMA);
        if (db.features.fts5) db.exec(FTS_SCHEMA);
        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
        this.searchEnabled = db.features.fts5;
        this.wasReset = reset;

        this.stmts = {
            fileId: db.prepare('SELECT id FROM file WHERE path = ?'),
            insertFile: db.prepare(
                `INSERT INTO file (path, lang, parser, content_hash, size, mtime_ms, namespace, references_json, flow_json, facts_version, indexed_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
            ),
            deleteFile: db.prepare('DELETE FROM file WHERE id = ?'),
            deleteSymbols: db.prepare('DELETE FROM symbol WHERE file_id = ?'),
            deleteImports: db.prepare('DELETE FROM import WHERE file_id = ?'),
            insertSymbol: db.prepare(
                'INSERT INTO symbol (file_id, name, kind, container, start_line, end_line, exported) VALUES (?, ?, ?, ?, ?, ?, ?)'
            ),
            insertImport: db.prepare(
                'INSERT INTO import (file_id, source, specifiers_json, is_default, is_namespace, line) VALUES (?, ?, ?, ?, ?, ?)'
            ),
            updateStat: db.prepare('UPDATE file SET size = ?, mtime_ms = ? WHERE path = ?'),
            upsertManifest: db.prepare('INSERT OR REPLACE INTO manifest (path, text) VALUES (?, ?)'),
            deleteManifest: db.prepare('DELETE FROM manifest WHERE path = ?'),
        };
    }

    /** Freshness data for every indexed file, keyed by path. */
    fileStates(): Map<string, StoredFileState> {
        const out = new Map<string, StoredFileState>();
        for (const r of this.db.prepare('SELECT path, content_hash, size, mtime_ms, facts_version FROM file').all()) {
            out.set(String(r.path), {
                contentHash: String(r.content_hash),
                size: Number(r.size),
                mtimeMs: r.mtime_ms === null ? null : Number(r.mtime_ms),
                factsVersion: String(r.facts_version),
            });
        }
        return out;
    }

    /** Rehydrates stored facts (for the given paths, or all). */
    loadAnalyses(paths?: Iterable<string>): Map<string, FileAnalysis> {
        const wanted = paths ? new Set(paths) : undefined;
        const files = new Map<number, FileAnalysis>();
        for (const r of this.db.prepare('SELECT id, path, lang, parser, namespace, references_json, flow_json FROM file').all()) {
            const path = String(r.path);
            if (wanted && !wanted.has(path)) continue;
            files.set(Number(r.id), {
                filePath: path,
                language: String(r.lang),
                symbols: [],
                imports: [],
                exports: [],
                ...(r.namespace !== null ? { namespace: String(r.namespace) } : {}),
                ...(r.references_json !== null ? { references: JSON.parse(String(r.references_json)) as string[] } : {}),
                ...(r.parser !== null ? { parser: String(r.parser) as FileAnalysis['parser'] } : {}),
                ...(r.flow_json !== null ? decodeFlowFacts(String(r.flow_json)) : {}),
            });
        }
        for (const r of this.db.prepare('SELECT file_id, name, kind, container, start_line, end_line, exported FROM symbol ORDER BY id').all()) {
            const f = files.get(Number(r.file_id));
            if (!f) continue;
            const symbol: SymbolInfo = {
                name: String(r.name),
                kind: String(r.kind) as SymbolKind,
                filePath: f.filePath,
                startLine: Number(r.start_line),
                endLine: Number(r.end_line),
                exported: Number(r.exported) === 1,
                ...(r.container !== null ? { container: String(r.container) } : {}),
            };
            f.symbols.push(symbol);
            if (symbol.exported) f.exports.push(symbol.name);
        }
        for (const r of this.db.prepare('SELECT file_id, source, specifiers_json, is_default, is_namespace, line FROM import ORDER BY rowid').all()) {
            const f = files.get(Number(r.file_id));
            if (!f) continue;
            const imp: ImportInfo = {
                source: String(r.source),
                specifiers: JSON.parse(String(r.specifiers_json)) as string[],
                isDefault: Number(r.is_default) === 1,
                isNamespace: Number(r.is_namespace) === 1,
                filePath: f.filePath,
                ...(r.line !== null ? { line: Number(r.line) } : {}),
            };
            f.imports.push(imp);
        }
        return new Map([...files.values()].map((f) => [f.filePath, f]));
    }

    /** Replaces one file's facts. */
    put(analysis: FileAnalysis, state: { contentHash: string; size: number; mtimeMs?: number }): void {
        this.db.transaction(() => this.putUnsafe(analysis, state));
    }

    /** Replaces many files' facts in one transaction (much faster than one per file). */
    putMany(items: Array<{ analysis: FileAnalysis; state: { contentHash: string; size: number; mtimeMs?: number } }>): void {
        if (items.length === 0) return;
        this.db.transaction(() => {
            for (const { analysis, state } of items) this.putUnsafe(analysis, state);
        });
    }

    remove(path: string): void {
        this.db.transaction(() => this.removeUnsafe(path));
    }

    removeMany(paths: Iterable<string>): void {
        this.db.transaction(() => {
            for (const p of paths) this.removeUnsafe(p);
        });
    }

    /** The file is unchanged (same hash) but its stat moved, e.g. after a checkout. */
    touch(path: string, size: number, mtimeMs?: number): void {
        this.stmts.updateStat.run(size, mtimeMs ?? null, path);
    }

    manifests(): Map<string, string> {
        return new Map(this.db.prepare('SELECT path, text FROM manifest').all().map((r) => [String(r.path), String(r.text)]));
    }

    setManifests(manifests: Map<string, string>): void {
        this.db.transaction(() => {
            this.db.exec('DELETE FROM manifest');
            for (const [p, text] of manifests) this.stmts.upsertManifest.run(p, text);
        });
    }

    putManifest(path: string, text: string): void {
        this.stmts.upsertManifest.run(path, text);
    }

    removeManifest(path: string): void {
        this.stmts.deleteManifest.run(path);
    }

    /** Symbols whose name starts with `prefix` (case-insensitive), best matches first. */
    searchSymbols(prefix: string, limit = 50): SymbolHit[] {
        const clean = prefix.replace(/[^\p{L}\p{N}_]/gu, '');
        if (!clean) return [];
        const rows: SqlRow[] = this.searchEnabled
            ? this.db
                  .prepare(
                      `SELECT f.path, s.name, s.kind, s.container, s.start_line
                       FROM symbol_fts JOIN symbol s ON s.id = symbol_fts.rowid JOIN file f ON f.id = s.file_id
                       WHERE symbol_fts MATCH ? ORDER BY s.container IS NOT NULL, s.exported DESC, bm25(symbol_fts) LIMIT ?`
                  )
                  .all(`name:${clean}*`, limit)
            : this.db
                  .prepare(
                      `SELECT f.path, s.name, s.kind, s.container, s.start_line
                       FROM symbol s JOIN file f ON f.id = s.file_id
                       WHERE s.name LIKE ? ESCAPE '\\' COLLATE NOCASE ORDER BY s.container IS NOT NULL, s.exported DESC, length(s.name) LIMIT ?`
                  )
                  .all(`${clean.replace(/[\\%_]/g, '\\$&')}%`, limit);
        return rows.map((r) => ({
            path: String(r.path),
            name: String(r.name),
            kind: String(r.kind),
            container: r.container === null ? null : String(r.container),
            startLine: Number(r.start_line),
        }));
    }

    stats(): { files: number; symbols: number; imports: number } {
        const n = (sql: string) => Number(this.db.prepare(sql).get()?.n ?? 0);
        return {
            files: n('SELECT count(*) AS n FROM file'),
            symbols: n('SELECT count(*) AS n FROM symbol'),
            imports: n('SELECT count(*) AS n FROM import'),
        };
    }

    close(): void {
        this.db.close();
    }

    private putUnsafe(a: FileAnalysis, state: { contentHash: string; size: number; mtimeMs?: number }): void {
        this.removeUnsafe(a.filePath);
        const row = this.stmts.insertFile.get(
            a.filePath,
            a.language,
            a.parser ?? null,
            state.contentHash,
            state.size,
            state.mtimeMs ?? null,
            a.namespace ?? null,
            a.references ? JSON.stringify(a.references) : null,
            encodeFlowFacts(a),
            FACTS_VERSION,
            Date.now()
        );
        const id = Number(row!.id);
        for (const s of a.symbols) {
            this.stmts.insertSymbol.run(id, s.name, s.kind, s.container ?? null, s.startLine, s.endLine, s.exported ? 1 : 0);
        }
        for (const i of a.imports) {
            this.stmts.insertImport.run(id, i.source, JSON.stringify(i.specifiers), i.isDefault ? 1 : 0, i.isNamespace ? 1 : 0, i.line ?? null);
        }
    }

    private removeUnsafe(path: string): void {
        const row = this.stmts.fileId.get(path);
        if (!row) return;
        const id = Number(row.id);
        this.stmts.deleteSymbols.run(id);
        this.stmts.deleteImports.run(id);
        this.stmts.deleteFile.run(id);
    }
}

/** Calls are stored as `[name, line, from, via]` tuples (a file can have thousands): from -1 = top level, via 0 bare / 1 self / 2 member. */
type StoredFlowFacts = { e?: EntryPoint[]; c?: Array<[string, number, number, number]> };
const VIA = [undefined, 'self', 'member'] as const;

function encodeFlowFacts(a: FileAnalysis): string | null {
    if (!a.entrypoints?.length && !a.calls?.length) return null;
    const facts: StoredFlowFacts = {};
    if (a.entrypoints?.length) facts.e = a.entrypoints;
    if (a.calls?.length) facts.c = a.calls.map((c) => [c.name, c.line, c.from ?? -1, c.via ? VIA.indexOf(c.via) : 0]);
    return JSON.stringify(facts);
}

function decodeFlowFacts(json: string): Pick<FileAnalysis, 'entrypoints' | 'calls'> {
    const facts = JSON.parse(json) as StoredFlowFacts;
    const out: Pick<FileAnalysis, 'entrypoints' | 'calls'> = {};
    if (facts.e?.length) out.entrypoints = facts.e;
    if (facts.c?.length) {
        out.calls = facts.c.map(([name, line, from, via]): CallSite => {
            const v = VIA[via];
            return { name, line, ...(from >= 0 ? { from } : {}), ...(v ? { via: v } : {}) };
        });
    }
    return out;
}
