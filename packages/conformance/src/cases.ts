/**
 * The adapter conformance suite (ADR-013): every platform's ports must pass
 * these, and must reproduce the golden polyglot graph exactly, so the same
 * repository indexes identically on Node and in every browser engine.
 */
import {
    Analyzer,
    buildGraph,
    classifyFiles,
    DEFAULT_EXCLUDE_PATTERNS,
    DEFAULT_LANGUAGE_IDS,
    IndexStore,
    Indexer,
    LANGUAGE_PACKS,
    LocalExecutor,
    grammarFor,
} from '@codearchy/core';
import type { ArchitectureGraph } from '@codearchy/protocol';
import { deepEqual, equal, ok, rejects } from './assert.js';
import { GOLDEN_POLYGLOT } from './expected/polyglot.js';
import type { CaseResult, ConformanceHarness } from './harness.js';

interface Case {
    name: string;
    run(h: ConformanceHarness): Promise<void | 'skip'>;
}

/** UTF-8 byte length without TextEncoder (keeps the suite free of host types). */
function utf8Length(s: string): number {
    let n = 0;
    for (const ch of s) {
        const c = ch.codePointAt(0)!;
        n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    }
    return n;
}

const edgeList = (g: ArchitectureGraph) => g.edges.map((e) => `${e.source} -> ${e.target}`).sort();

let dbCounter = 0;
const freshDb = (h: ConformanceHarness, tag: string) => h.openStorage(`conformance-${tag}-${Date.now()}-${dbCounter++}.db`);

async function indexFixture(h: ConformanceHarness) {
    const { fs, files } = await h.fixture();
    const d = classifyFiles(files, { languages: DEFAULT_LANGUAGE_IDS, excludePatterns: DEFAULT_EXCLUDE_PATTERNS, maxFiles: 0 }, 'conformance');
    return { fs, d };
}

export const CASES: Case[] = [
    {
        name: 'fs: reads text and reports size and mtime',
        async run(h) {
            const { fs } = await h.fixture();
            const text = await fs.readText('web/src/lib/util.ts');
            ok(text !== undefined && text.includes('export const util'), 'reads file contents');
            const st = await fs.stat('web/src/lib/util.ts');
            ok(st?.isFile, 'stat reports a file');
            equal(st.size, utf8Length(text), 'size is the byte length');
            ok(typeof st.mtimeMs === 'number' && st.mtimeMs > 0, 'mtimeMs is provided (enables warm re-indexing)');
        },
    },
    {
        name: 'fs: missing files and paths escaping the root are undefined',
        async run(h) {
            const { fs } = await h.fixture();
            for (const p of ['does/not/exist.ts', '../outside.ts', 'web/../../outside.ts', '/etc/passwd', '']) {
                equal(await fs.readText(p), undefined, `readText(${JSON.stringify(p)})`);
                equal(await fs.stat(p), undefined, `stat(${JSON.stringify(p)})`);
            }
            const dir = await fs.stat('web/src');
            ok(dir && !dir.isFile, 'a directory is reported as not-a-file');
        },
    },
    {
        name: 'storage: SQL, RETURNING, rollback and nested transactions',
        async run(h) {
            const db = await freshDb(h, 'sql');
            try {
                db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
                const row = db.prepare('INSERT INTO t (v) VALUES (?) RETURNING id').get('a');
                equal(Number(row?.id), 1, 'RETURNING gives the new id');
                await rejects(() => db.transaction(() => {
                    db.prepare('INSERT INTO t (v) VALUES (?)').run('b');
                    throw new Error('boom');
                }), 'a throwing transaction rethrows');
                equal(Number(db.prepare('SELECT count(*) AS n FROM t').get()?.n), 1, 'the failed transaction rolled back');
                db.transaction(() => db.transaction(() => db.prepare('INSERT INTO t (v) VALUES (?)').run('c')));
                deepEqual(db.prepare('SELECT v FROM t ORDER BY id').all().map((r) => r.v), ['a', 'c'], 'nested transactions join the outer one');
            } finally {
                db.close();
            }
        },
    },
    {
        name: 'storage: the fts5 feature flag is truthful',
        async run(h) {
            const db = await freshDb(h, 'fts');
            try {
                let works = true;
                try {
                    db.exec('CREATE VIRTUAL TABLE f USING fts5(x)');
                } catch {
                    works = false;
                }
                equal(db.features.fts5, works, 'features.fts5 matches what the build supports');
            } finally {
                db.close();
            }
        },
    },
    {
        name: 'parser: every grammar loads, compiles its query and parses',
        async run(h) {
            const runtime = await h.parser();
            const files = new Set<string>();
            for (const pack of LANGUAGE_PACKS) for (const ext of pack.extensions) files.add(`${pack.id}|${grammarFor(pack, ext)}`);
            for (const key of files) {
                const [id, file] = key.split('|');
                const pack = LANGUAGE_PACKS.find((p) => p.id === id)!;
                const lang = await runtime.loadLanguage(file);
                ok(lang, `grammar ${file} loads`);
                const query = runtime.compileQuery(lang, pack.query);
                const tree = runtime.parse(lang, pack.sample);
                ok(tree, `${file} parses`);
                ok(query.matches(tree.rootNode).length > 0, `${id} query matches a sample`);
                tree.delete();
                query.delete();
            }
        },
    },
    {
        name: 'index: reproduces the golden polyglot graph exactly',
        async run(h) {
            const { fs, d } = await indexFixture(h);
            const store = new IndexStore(await freshDb(h, 'golden'));
            try {
                const analyzer = new Analyzer({ fs, parser: await h.parser(), maxFileSize: 1_000_000 });
                const r = await new Indexer({ fs, store, executor: new LocalExecutor(analyzer) }).index(d.sourceFiles, d.manifests);
                const g = buildGraph(r.analyses.values(), r.manifests);
                deepEqual(d.sourceFiles, GOLDEN_POLYGLOT.files, 'discovers the same source files');
                deepEqual(edgeList(g), GOLDEN_POLYGLOT.edges, 'edges match the golden graph');
                equal(g.metadata.totalSymbols, GOLDEN_POLYGLOT.symbols, 'symbol count matches');
                equal(g.metadata.parserStats?.regex, 0, 'every file parsed with tree-sitter');

                const warm = await new Indexer({ fs, store, executor: new LocalExecutor(analyzer) }).index(d.sourceFiles, d.manifests);
                equal(warm.stats.parsed, 0, 'a second run re-parses nothing');
                equal(warm.stats.reused, d.sourceFiles.length, 'a second run reuses every file without reading it');
                deepEqual(edgeList(buildGraph(warm.analyses.values(), warm.manifests)), GOLDEN_POLYGLOT.edges, 'warm graph matches too');

                const hits = store.searchSymbols('OrderSer').map((x) => `${x.path}#${x.name}`);
                ok(hits.includes('cs/Orders/OrderService.cs#OrderService'), `symbol search finds C# OrderService (got ${hits.join(', ')})`);
            } finally {
                store.close();
            }
        },
    },
    {
        name: 'executor: the parallel worker pool reproduces the golden graph',
        async run(h) {
            if (!h.executor) return 'skip';
            const { fs, d } = await indexFixture(h);
            const executor = await h.executor();
            const store = new IndexStore(await freshDb(h, 'pool'));
            try {
                const r = await new Indexer({ fs, store, executor }).index(d.sourceFiles, d.manifests);
                ok(executor.lastRunWorkers > 0, 'jobs ran on worker threads');
                deepEqual(edgeList(buildGraph(r.analyses.values(), r.manifests)), GOLDEN_POLYGLOT.edges, 'edges match the golden graph');
            } finally {
                store.close();
                executor.dispose();
            }
        },
    },
];

export async function runConformance(h: ConformanceHarness, filter?: (name: string) => boolean): Promise<CaseResult[]> {
    const results: CaseResult[] = [];
    for (const c of CASES) {
        if (filter && !filter(c.name)) continue;
        const t = Date.now();
        try {
            const outcome = await c.run(h);
            results.push({ name: c.name, ok: true, ...(outcome === 'skip' ? { skipped: true } : {}), ms: Date.now() - t });
        } catch (err) {
            results.push({ name: c.name, ok: false, error: (err as Error).message, ms: Date.now() - t });
        }
    }
    return results;
}
