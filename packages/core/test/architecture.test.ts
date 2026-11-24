import { describe, test } from 'vitest';
import * as assert from 'node:assert';
import type { FileAnalysis } from '@codearchy/protocol';
import { analyzeWithRegex, buildArchitecture, buildGraph, buildHierarchy, enrich, FlowIndex, HierarchyIndex } from '../src/index.js';

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

function workspace(files: Record<string, string> = FILES) {
    const analyses = new Map<string, FileAnalysis>();
    for (const [path, src] of Object.entries(files)) analyses.set(path, enrich(analyzeWithRegex(src, path, 'typescript')!, src));
    const index = new HierarchyIndex(buildHierarchy(buildGraph(analyses.values()), { systemName: 'shop' }));
    const flows = new FlowIndex(analyses, index);
    return { index, flows };
}

describe('architecture', () => {
    test('opens a single-package repo to its main parts, with who calls in and what it reaches', () => {
        const { index, flows } = workspace();
        const a = buildArchitecture(index, flows, 1);
        const parts = a.nodes.filter((n) => n.kind === 'part');
        assert.ok(parts.length >= 4, parts.map((p) => p.label).join(', '));
        assert.ok(!parts.some((p) => p.role === 'test'), 'test-only parts are left out');
        for (const p of parts) assert.deepStrictEqual(p.parts, [p.id]);
        // Callers of the HTTP routes, into the part that declares them.
        const actor = a.nodes.find((n) => n.id === 'actor:http');
        assert.ok(actor, JSON.stringify(a.nodes.map((n) => n.id)));
        const into = a.edges.find((e) => e.source === 'actor:http')!;
        assert.match(into.label, /HTTP requests \(2\)/);
        assert.ok(parts.some((p) => p.id === into.target));
        // pg is PostgreSQL, reached from the part holding the db files.
        const pg = a.nodes.find((n) => n.kind === 'external')!;
        assert.strictEqual(pg.label, 'PostgreSQL');
        assert.strictEqual(pg.sink, 'database');
        assert.strictEqual(pg.layer, 'external');
        const toPg = a.edges.filter((e) => e.target === pg.id);
        assert.ok(toPg.length >= 1 && toPg.every((e) => e.label === 'reads and writes' && parts.some((p) => p.id === e.source)));
        // Every edge joins drawn nodes.
        const ids = new Set(a.nodes.map((n) => n.id));
        for (const e of a.edges) assert.ok(ids.has(e.source) && ids.has(e.target), `${e.source} -> ${e.target}`);
        assert.match(a.summary, /^shop has 8 source files in \d+ main parts/);
        assert.match(a.summary, /2 HTTP routes/);
        assert.match(a.summary, /PostgreSQL/);
        assert.ok(a.pattern.length > 0);
        assert.strictEqual(a.source, 'deterministic');
    });

    test('works without flows: the parts and their dependencies', () => {
        const { index } = workspace();
        const a = buildArchitecture(index, undefined, 1);
        assert.ok(a.nodes.every((n) => n.kind === 'part'));
        assert.ok(a.edges.length > 0 && a.edges.every((e) => e.kind === 'depends'));
    });
});
