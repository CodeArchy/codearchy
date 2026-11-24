import { describe, test } from 'vitest';
import * as assert from 'node:assert';
import type { FileAnalysis, Tour } from '@codearchy/protocol';
import {
    analyzeWithRegex,
    anchorFor,
    buildGraph,
    buildHierarchy,
    classifyFiles,
    DEFAULT_EXCLUDE_PATTERNS,
    enrich,
    FlowIndex,
    generateStartHere,
    HierarchyIndex,
    isTourFile,
    parseTour,
    TourIndex,
} from '../src/index.js';

/** A small shop: routes → handlers → services → db, with tests for one service. */
const FILES: Record<string, string> = {
    'src/api/routes.ts': [
        "import express from 'express';",
        "import { login, createOrder } from './handlers';",
        'const router = express.Router();',
        "router.post('/login', login);",
        "router.post('/orders', createOrder);",
    ].join('\n'),
    'src/api/handlers.ts': [
        "import { authenticate } from '../auth/service';",
        "import { placeOrder } from '../orders/service';",
        'export async function login(req, res) { res.json(await authenticate(req.body)); }',
        'export async function createOrder(req, res) { res.json(await placeOrder(req.body)); }',
    ].join('\n'),
    'src/auth/service.ts': ["import { findUser } from '../db/users';", 'export async function authenticate(body) { return findUser(body.email); }'].join('\n'),
    'src/orders/service.ts': ["import { insertOrder } from '../db/orders';", 'export async function placeOrder(body) { return insertOrder(body); }'].join('\n'),
    'src/db/users.ts': ["import { Pool } from 'pg';", 'const pool = new Pool();', 'export async function findUser(email) { return pool.query(email); }'].join('\n'),
    'src/db/orders.ts': ["import { Pool } from 'pg';", 'const pool = new Pool();', 'export async function insertOrder(o) { return pool.query(o); }'].join('\n'),
    'src/util/format.ts': 'export function money(n) { return `$${n}`; }',
    'test/orders.test.ts': ["import { placeOrder } from '../src/orders/service';", "test('x', () => placeOrder({}));"].join('\n'),
};

function workspace(files: Record<string, string> = FILES, tourFiles: Record<string, string> = {}) {
    const analyses = new Map<string, FileAnalysis>();
    for (const [path, src] of Object.entries(files)) analyses.set(path, enrich(analyzeWithRegex(src, path, 'typescript')!, src));
    const index = new HierarchyIndex(buildHierarchy(buildGraph(analyses.values()), { systemName: 'shop' }));
    const flows = new FlowIndex(analyses, index);
    const all = { ...files, ...tourFiles };
    const read = async (p: string) => all[p];
    return { index, flows, read, tours: new TourIndex({ index, flows, files: Object.keys(tourFiles), read }) };
}

describe('Start Here', () => {
    test('walks from the big picture through an entrypoint, the core and the data layer to a first change', () => {
        const { index, flows } = workspace();
        const tour = generateStartHere(index, flows);
        assert.strictEqual(tour.id, 'start-here');
        assert.strictEqual(tour.origin, 'generated');
        const titles = tour.steps.map((s) => s.title);
        assert.strictEqual(titles[0], 'The big picture');
        assert.strictEqual(titles[1], 'Where things start');
        assert.ok(titles.some((t) => t.startsWith('The core')), titles.join(' | '));
        assert.ok(titles.includes('The data layer'), titles.join(' | '));
        assert.ok(titles.includes('Integrations'), titles.join(' | '));
        assert.strictEqual(titles[titles.length - 1], 'A good first change');

        const entry = tour.steps[1];
        assert.match(entry.target.flow ?? '', /^flow:src\/api\/routes\.ts#http:POST \//);
        assert.match(entry.body, /2 HTTP routes/);
        assert.deepStrictEqual(entry.view, { mode: 'flows' });

        // Every node a step targets or links to is in the index; ids are unique.
        const keys = tour.steps.flatMap((s) => [s.target.node, ...[...s.body.matchAll(/\(node:([^)]+)\)/g)].map((m) => m[1])]).filter((k): k is string => !!k);
        for (const k of keys) assert.ok(index.node(k), `unknown key ${k}`);
        assert.strictEqual(new Set(tour.steps.map((s) => s.id)).size, tour.steps.length);
        // The first change is the tested service, with its test named.
        const first = tour.steps[tour.steps.length - 1];
        assert.strictEqual(first.target.node, 'mod:src/orders/service.ts');
        assert.match(first.body, /orders\.test\.ts/);
        assert.deepStrictEqual(first.code, [{ path: 'src/orders/service.ts', start: 2, end: 2 }]);
    });

    test('never features a part together with one inside it', () => {
        const { index, flows } = workspace();
        const featured = generateStartHere(index, flows)
            .steps.filter((s) => /^The core|^The data layer|^Shared/.test(s.title))
            .map((s) => index.node(s.target.node!)!);
        for (const a of featured) for (const b of featured) if (a !== b) assert.ok(!index.contains(a.tin, b.tin), `${a.key} contains ${b.key}`);
    });

    test('without flows or tests it still has the big picture', () => {
        const { index } = workspace({ 'a.ts': 'export function a() {}', 'b.ts': "import { a } from './a';\nexport function b() { a(); }" });
        const tour = generateStartHere(index);
        assert.strictEqual(tour.steps[0].title, 'The big picture');
        assert.ok(!tour.steps.some((s) => s.title === 'Where things start'));
    });
});

describe('tour files', () => {
    const valid = {
        version: 1,
        title: 'Orders, end to end',
        steps: [
            { id: 'one', target: { node: 'mod:src/orders/service.ts' }, title: 'Orders', body: 'Where orders live.' },
            { target: { node: 'mod:src/db/orders.ts' }, title: 'Storage', body: 'Writes.', code: [{ path: 'src/db/orders.ts', start: 3, end: 3 }] },
        ],
    };

    test('isTourFile: only .codearchy/tours/*.json at the root', () => {
        assert.deepStrictEqual(
            ['.codearchy/tours/a.json', '.codearchy/tours/sub/a.json', 'x/.codearchy/tours/a.json', '.codearchy/tours/a.yaml', '.codearchy/tours/.json'].map(isTourFile),
            [true, false, false, false, false]
        );
        const d = classifyFiles(['.codearchy/tours/b.json', '.codearchy/tours/a.json', 'src/a.ts'], { languages: ['typescript'], excludePatterns: DEFAULT_EXCLUDE_PATTERNS, maxFiles: 0 }, 'test');
        assert.deepStrictEqual(d.tours, ['.codearchy/tours/a.json', '.codearchy/tours/b.json']);
        assert.deepStrictEqual(d.sourceFiles, ['src/a.ts']);
    });

    test('parses a tour: id from the file name, step ids filled in', () => {
        const r = parseTour(JSON.stringify(valid), '.codearchy/tours/orders.json');
        assert.ok(r.ok);
        assert.strictEqual(r.tour.id, 'orders');
        assert.strictEqual(r.tour.origin, 'authored');
        assert.deepStrictEqual(r.tour.steps.map((s) => s.id), ['one', 's2']);
    });

    test('says what is wrong with a broken file', () => {
        const err = (v: unknown) => {
            const r = parseTour(typeof v === 'string' ? v : JSON.stringify(v), '.codearchy/tours/x.json');
            return r.ok ? 'ok' : r.error;
        };
        assert.match(err('{nope'), /Not valid JSON/);
        assert.match(err({ ...valid, version: 2 }), /version/);
        assert.match(err({ ...valid, title: '' }), /title/);
        assert.match(err({ ...valid, steps: [] }), /steps/);
        assert.match(err({ ...valid, steps: [{ title: 'a', body: 'b', target: {} }] }), /step 1: needs a target/);
        assert.match(err({ ...valid, steps: [{ title: 'a', body: 'b', code: [{ path: '../etc/passwd', start: 1, end: 2 }] }] }), /step 1: each "code" range/);
        assert.match(err({ ...valid, steps: [{ title: 'a', body: 'b', code: [{ path: 'a.ts', start: 5, end: 2 }] }] }), /start ≤ end/);
    });
});

describe('TourIndex', () => {
    test('lists the generated Start Here tour and authored ones, flagging broken files', async () => {
        const { tours } = workspace(FILES, { '.codearchy/tours/orders.json': JSON.stringify({ version: 1, title: 'Orders', steps: [{ target: { node: 'mod:src/orders/service.ts' }, title: 'a', body: 'b' }] }), '.codearchy/tours/bad.json': '{' });
        const list = await tours.list();
        assert.deepStrictEqual(
            list.map((t) => `${t.id}:${t.origin}:${t.steps}${t.error ? ':error' : ''}`),
            ['start-here:generated:' + list[0].steps, 'bad:authored:0:error', 'orders:authored:1']
        );
        assert.ok((await tours.get('start-here'))!.steps.length > 3);
        assert.strictEqual(await tours.get('bad'), undefined);
        assert.strictEqual(await tours.get('nope'), undefined);
    });

    test('a committed start-here.json replaces the generated tour', async () => {
        const committed: Tour = { version: 1, id: 'start-here', title: 'Our own start', origin: 'authored', steps: [{ id: 'a', target: { node: 'sys:root' }, title: 'Hi', body: 'Welcome.' }] };
        const { tours } = workspace(FILES, { '.codearchy/tours/start-here.json': JSON.stringify(committed) });
        const list = await tours.list();
        assert.deepStrictEqual(list.map((t) => `${t.id}:${t.origin}`), ['start-here:authored']);
        assert.strictEqual((await tours.get('start-here'))!.title, 'Our own start');
    });

    test('marks steps whose target is gone or whose code changed', async () => {
        const base = workspace();
        const steps = [
            { id: 'ok', target: { node: 'mod:src/db/orders.ts' }, title: 'ok', body: '', code: [{ path: 'src/db/orders.ts', start: 3, end: 3 }] },
            { id: 'node', target: { node: 'mod:src/orders/service.ts' }, title: 'node', body: '' },
            { id: 'gone', target: { node: 'mod:src/legacy.ts' }, title: 'gone', body: '' },
            { id: 'edited', target: { node: 'mod:src/db/users.ts' }, title: 'edited', body: '', code: [{ path: 'src/db/users.ts', start: 3, end: 3 }] },
            { id: 'flow', target: { flow: 'flow:src/api/routes.ts#http:GET /removed' }, title: 'flow', body: '' },
        ];
        // Anchors as the author saw the code…
        const anchored = await Promise.all(steps.map(async (s) => ({ ...s, anchorHash: await anchorFor(s, base.index, base.read) })));
        // …then someone edits users.ts line 3.
        const edited = { ...FILES, 'src/db/users.ts': FILES['src/db/users.ts']!.replace('pool.query(email)', 'pool.query(email.toLowerCase())') };
        const file = JSON.stringify({ version: 1, title: 'Checked', steps: anchored });
        const { tours } = workspace(edited, { '.codearchy/tours/checked.json': file });
        const t = (await tours.get('checked'))!;
        assert.deepStrictEqual(
            t.status.map((s, i) => `${t.steps[i].id}:${s.stale ?? 'fresh'}`),
            ['ok:fresh', 'node:fresh', 'gone:missing', 'edited:changed', 'flow:missing']
        );
        assert.strictEqual((await tours.list()).find((x) => x.id === 'checked')!.stale, 3);
    });
});
