import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { COMPANION_PROTOCOL, type CompanionServerMessage } from '@codearchy/protocol';
import { originAllowed, startCompanion, type Companion } from '../src/companion.js';
import { Workspace } from '../src/workspace.js';

const POLYGLOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures/polyglot');
const APP = 'https://app.codearchy.com';

type Conn = { ws: WebSocket; next(): Promise<CompanionServerMessage>; closed: Promise<{ code: number; reason: string }> };

function connect(port: number, opts: { origin?: string; host?: string } = {}): Promise<Conn> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
            ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
            ...(opts.host ? { headers: { host: opts.host } } : {}),
        });
        const queue: CompanionServerMessage[] = [];
        const waiting: Array<(m: CompanionServerMessage) => void> = [];
        ws.on('message', (d) => {
            const m = JSON.parse(d.toString()) as CompanionServerMessage;
            const w = waiting.shift();
            if (w) w(m);
            else queue.push(m);
        });
        const closed = new Promise<{ code: number; reason: string }>((r) => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
        ws.on('open', () => resolve({ ws, closed, next: () => new Promise((r) => (queue.length ? r(queue.shift()!) : waiting.push(r))) }));
        ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
        ws.on('error', reject);
    });
}

describe('the Companion (codearchy serve)', () => {
    const workspace = new Workspace(POLYGLOT);
    let companion: Companion;
    let session = '';
    let id = 0;
    const request = async (c: Conn, method: string, params: Record<string, unknown> = {}) => {
        const rid = ++id;
        c.ws.send(JSON.stringify({ type: 'request', id: rid, method, params }));
        const m = await c.next();
        expect(m).toMatchObject({ type: 'response', id: rid });
        return m as Extract<CompanionServerMessage, { type: 'response' }>;
    };

    beforeAll(async () => {
        companion = await startCompanion(workspace, { version: 'test', token: 'one-time-token' });
    }, 60_000);
    afterAll(() => companion.close());

    it('prints a pairing link that carries the token in the fragment', () => {
        expect(companion.pairingUrl).toBe(`${APP}/#pair=one-time-token@127.0.0.1:${companion.port}`);
    });

    it('accepts only the app, localhost dev servers and allowed origins', () => {
        expect(originAllowed(APP)).toBe(true);
        expect(originAllowed('http://localhost:5173')).toBe(true);
        expect(originAllowed('http://127.0.0.1:8080')).toBe(true);
        expect(originAllowed('https://evil.example')).toBe(false);
        expect(originAllowed('https://app.codearchy.com.evil.example')).toBe(false);
        expect(originAllowed('https://localhost:5173')).toBe(false); // dev servers are plain http on this machine
        expect(originAllowed(undefined)).toBe(false);
        expect(originAllowed('https://code.acme.internal', ['https://code.acme.internal'])).toBe(true);
    });

    it('refuses other origins, no origin, and other Host names (DNS rebinding)', async () => {
        await expect(connect(companion.port, { origin: 'https://evil.example' })).rejects.toThrow('HTTP 403');
        await expect(connect(companion.port, { origin: '' })).rejects.toThrow('HTTP 403');
        await expect(connect(companion.port, { origin: APP, host: `rebind.example:${companion.port}` })).rejects.toThrow('HTTP 403');
    });

    it('closes a connection whose first frame is not a valid pairing', async () => {
        const c = await connect(companion.port, { origin: APP });
        c.ws.send(JSON.stringify({ type: 'request', id: 1, method: 'view' }));
        expect((await c.closed).code).toBe(4400);
        const wrong = await connect(companion.port, { origin: APP });
        wrong.ws.send(JSON.stringify({ type: 'pair', protocol: COMPANION_PROTOCOL, token: 'guess' }));
        expect((await wrong.closed).code).toBe(4401);
    });

    it('pairs once with the token, then serves the engine read-only', async () => {
        const c = await connect(companion.port, { origin: APP });
        c.ws.send(JSON.stringify({ type: 'pair', protocol: COMPANION_PROTOCOL, token: 'one-time-token' }));
        const ready = await c.next();
        expect(ready).toMatchObject({ type: 'ready', protocol: COMPANION_PROTOCOL, version: 'test', summary: { name: 'polyglot', storage: 'native', live: true } });
        if (ready.type !== 'ready') throw new Error('not ready');
        session = ready.session;
        expect(ready.summary.files).toBeGreaterThan(20);

        const view = (await request(c, 'view', { request: {} })).result as { nodes: Array<{ key: string }> };
        expect(view.nodes.some((n) => n.key === 'pkg:rust')).toBe(true);
        const d = (await request(c, 'describe', { key: 'mod:web/src/index.ts' })).result as { dependsOn: Array<{ key: string }> };
        expect(d.dependsOn.some((l) => l.key === 'mod:web/src/esm.ts')).toBe(true);
        const hits = (await request(c, 'search', { query: 'OrderSer' })).result as Array<{ key: string }>;
        expect(hits.some((h) => h.key === 'mod:cs/Orders/OrderService.cs')).toBe(true);
        const flows = (await request(c, 'flows')).result as Array<{ label: string }>;
        expect(flows.map((f) => f.label)).toContain('main');
        const tours = (await request(c, 'tours')).result as Array<{ id: string }>;
        expect(tours.map((t) => t.id)).toEqual(['start-here']);

        // Indexed source files only: not manifests, not paths outside the workspace.
        expect((await request(c, 'readFile', { path: 'rb/lib/billing.rb' })).result).toContain("require 'json'");
        expect((await request(c, 'readFile', { path: 'package.json' })).result).toBeUndefined();
        expect((await request(c, 'readFile', { path: '../../package.json' })).result).toBeUndefined();
        expect((await request(c, 'saveTour', { tour: {} })).error).toMatch(/Unknown request/);
        c.ws.close();
    });

    it('the token works once; the session key resumes', async () => {
        const again = await connect(companion.port, { origin: APP });
        again.ws.send(JSON.stringify({ type: 'pair', protocol: COMPANION_PROTOCOL, token: 'one-time-token' }));
        expect((await again.closed).code).toBe(4401);
        const resumed = await connect(companion.port, { origin: 'http://localhost:5173' });
        resumed.ws.send(JSON.stringify({ type: 'resume', protocol: COMPANION_PROTOCOL, session }));
        expect(await resumed.next()).toMatchObject({ type: 'ready', session });
        resumed.ws.close();
    });

    it('pushes a change event to connected pages', async () => {
        const c = await connect(companion.port, { origin: APP });
        c.ws.send(JSON.stringify({ type: 'resume', protocol: COMPANION_PROTOCOL, session }));
        await c.next();
        companion.notify('web/src/index.ts');
        expect(await c.next()).toMatchObject({ type: 'event', event: { type: 'changed', paths: ['web/src/index.ts'], summary: { storage: 'native' } } });
        c.ws.close();
    });

    it('rejects binary frames and request floods', async () => {
        const bin = await connect(companion.port, { origin: APP });
        bin.ws.send(Buffer.from([1, 2, 3]));
        expect((await bin.closed).code).toBe(1003);
        const flood = await connect(companion.port, { origin: APP });
        flood.ws.send(JSON.stringify({ type: 'resume', protocol: COMPANION_PROTOCOL, session }));
        await flood.next();
        for (let i = 0; i < 400; i++) flood.ws.send(JSON.stringify({ type: 'request', id: 10_000 + i, method: 'summary' }));
        expect((await flood.closed).code).toBe(4429);
    });
});
