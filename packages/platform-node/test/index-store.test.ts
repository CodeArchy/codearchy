import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildGraph,
    classifyFiles,
    DEFAULT_EXCLUDE_PATTERNS,
    DEFAULT_LANGUAGE_IDS,
    IndexStore,
    Indexer,
    LocalExecutor,
    SCHEMA_VERSION,
    type StoragePort,
} from '@codearchy/core';
import { createNodeAnalyzer, NodeWorkerPool, openNodeSqlite, walkFiles } from '../src/index.js';
import { FIXTURES } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(here, '..', 'dist', 'worker.js');
const sqlite = await openNodeSqlite({ file: ':memory:' });
const describeSqlite = sqlite ? describe : describe.skip;
sqlite?.close();

let tmp: string;
let repo: string;
/** Every store opened by a test; closed in afterEach (Windows can't delete open DB files). */
const open: Array<{ close(): void }> = [];

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codearchy-index-'));
    repo = path.join(tmp, 'repo');
    fs.cpSync(path.join(FIXTURES, 'polyglot'), repo, { recursive: true });
});
afterEach(() => {
    for (const s of open.splice(0)) {
        try {
            s.close();
        } catch {
            // already closed by the test
        }
    }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function discover() {
    return classifyFiles(await walkFiles(repo), { languages: DEFAULT_LANGUAGE_IDS, excludePatterns: DEFAULT_EXCLUDE_PATTERNS, maxFiles: 0 }, 'walk');
}

async function setup(dbFile = path.join(tmp, 'index.db')) {
    const db = (await openNodeSqlite({ file: dbFile }))!;
    const store = new IndexStore(db);
    open.push(store);
    const { analyzer, fs: fsPort } = await createNodeAnalyzer({ root: repo, maxFileSize: 1_000_000 });
    const indexer = new Indexer({ fs: fsPort, store, executor: new LocalExecutor(analyzer) });
    return { db, store, analyzer, indexer };
}

const edgeSet = (g: ReturnType<typeof buildGraph>) => g.edges.map((e) => `${e.source} -> ${e.target}`).sort();

describeSqlite('IndexStore (node:sqlite)', () => {
    test('round-trips facts exactly and supports search', async () => {
        const { store, analyzer } = await setup();
        const d = await discover();
        const analyses = await analyzer.analyzeAll(d.sourceFiles);
        store.putMany([...analyses.values()].map((a) => ({ analysis: a, state: { contentHash: 'h', size: 1, mtimeMs: 1 } })));
        const loaded = store.loadAnalyses();
        expect(loaded.size).toBe(analyses.size);
        for (const [p, a] of analyses) expect(loaded.get(p)).toEqual(a);

        const hits = store.searchSymbols('OrderSer');
        expect(hits.map((h) => `${h.path}#${h.name}`)).toEqual(
            expect.arrayContaining(['jvm/src/main/java/com/acme/orders/OrderService.java#OrderService', 'cs/Orders/OrderService.cs#OrderService'])
        );
        expect(hits[0].container).toBeNull(); // top-level types rank before members
        expect(store.searchSymbols('%_')).toEqual([]); // LIKE wildcards are escaped / stripped

        store.remove('web/src/index.ts');
        expect(store.loadAnalyses().has('web/src/index.ts')).toBe(false);
        expect(store.stats().files).toBe(analyses.size - 1);
        store.close();
    });

    test('an index with another schema version is rebuilt, not trusted', async () => {
        const file = path.join(tmp, 'old.db');
        const db = (await openNodeSqlite({ file }))!;
        new IndexStore(db).putManifest('package.json', '{}');
        db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION + 99));
        db.close();
        const reopened = new IndexStore((await openNodeSqlite({ file }))!);
        expect(reopened.wasReset).toBe(true);
        expect(reopened.manifests().size).toBe(0);
        reopened.close();
    });

    test('search falls back to a prefix scan without FTS5', async () => {
        const db = (await openNodeSqlite({ file: ':memory:' }))!;
        const noFts: StoragePort = { ...db, features: { fts5: false }, prepare: db.prepare, exec: db.exec, transaction: db.transaction, close: db.close };
        const store = new IndexStore(noFts);
        expect(store.searchEnabled).toBe(false);
        const { analyzer } = await createNodeAnalyzer({ root: repo, maxFileSize: 1_000_000 });
        const a = (await analyzer.analyzeFile('cs/Billing/Invoice.cs'))!;
        store.put(a, { contentHash: 'h', size: 1 });
        expect(store.searchSymbols('invo').map((h) => h.name)).toEqual(['Invoice']);
        store.close();
    });
});

describeSqlite('Indexer (incremental)', () => {
    test('warm start reuses everything; edits, touches and deletes are handled precisely', async () => {
        const d = await discover();
        const cold = await (await setup()).indexer.index(d.sourceFiles, d.manifests);
        expect(cold.stats.parsed).toBe(d.sourceFiles.length);
        const coldGraph = buildGraph(cold.analyses.values(), cold.manifests);

        // Warm: nothing re-read or re-parsed, identical graph.
        const s2 = await setup();
        const warm = await s2.indexer.index(d.sourceFiles, d.manifests);
        expect(warm.stats).toMatchObject({ reused: d.sourceFiles.length, parsed: 0, unchanged: 0, removed: 0 });
        expect(edgeSet(buildGraph(warm.analyses.values(), warm.manifests))).toEqual(edgeSet(coldGraph));
        for (const [p, a] of cold.analyses) expect(warm.analyses.get(p)).toEqual(a);

        // Touch (mtime changes, content doesn't) → hashed, not parsed.
        const touched = path.join(repo, 'py', 'app', 'config.py');
        const later = new Date(Date.now() + 60_000);
        fs.utimesSync(touched, later, later);
        // Edit → parsed. Delete → removed.
        fs.appendFileSync(path.join(repo, 'web', 'src', 'lib', 'util.ts'), '\nexport const added = 2;\n');
        fs.rmSync(path.join(repo, 'go', 'internal', 'store', 'other.go'));
        const d2 = await discover();
        const s3 = await setup();
        const third = await s3.indexer.index(d2.sourceFiles, d2.manifests);
        expect(third.stats).toMatchObject({ parsed: 1, unchanged: 1, removed: 1, reused: d2.sourceFiles.length - 2 });
        expect(third.analyses.get('web/src/lib/util.ts')!.symbols.map((s) => s.name)).toContain('added');
        expect(third.analyses.has('go/internal/store/other.go')).toBe(false);

        // A fourth run is fully warm again (the touch refreshed the stored stat).
        const fourth = await (await setup()).indexer.index(d2.sourceFiles, d2.manifests);
        expect(fourth.stats).toMatchObject({ reused: d2.sourceFiles.length, parsed: 0, unchanged: 0 });
    });

    test('without a store everything is parsed (in-memory indexing)', async () => {
        const d = await discover();
        const { analyzer, fs: fsPort } = await createNodeAnalyzer({ root: repo, maxFileSize: 1_000_000 });
        const r = await new Indexer({ fs: fsPort, executor: new LocalExecutor(analyzer) }).index(d.sourceFiles, d.manifests);
        expect(r.stats.parsed).toBe(d.sourceFiles.length);
        expect(r.analyses.size).toBe(d.sourceFiles.length);
    });
});

describe('NodeWorkerPool', () => {
    test('worker threads produce exactly the in-process results', async () => {
        const d = await discover();
        const jobs = d.sourceFiles.map((p) => ({ path: p }));
        const { analyzer } = await createNodeAnalyzer({ root: repo, maxFileSize: 1_000_000 });
        const local = new Map<string, unknown>();
        await new LocalExecutor(analyzer).run(jobs, { onResult: (r) => local.set(r.path, r) });

        const pool = new NodeWorkerPool({ root: repo, maxFileSize: 1_000_000, workers: 2, minJobsForWorkers: 1, workerScript: WORKER });
        const pooled = new Map<string, unknown>();
        await pool.run(jobs, { onResult: (r) => pooled.set(r.path, r) });
        pool.dispose();
        expect(pooled.size).toBe(jobs.length);
        expect(pooled).toEqual(local);
    });
});
