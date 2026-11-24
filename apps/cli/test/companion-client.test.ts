import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { CompanionEngine, parsePairing, type WebSocketLike } from '@codearchy/platform-browser/companion';
import type { EngineEvent } from '@codearchy/protocol';
import { startCompanion, type Companion } from '../src/companion.js';
import { Workspace } from '../src/workspace.js';

const POLYGLOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures/polyglot');
/** The page's WebSocket, as the app's origin would open it. */
const asApp = (url: string) => new WebSocket(url, { origin: 'https://app.codearchy.com' }) as unknown as WebSocketLike;

describe('CompanionEngine (the page side) against codearchy serve', () => {
    let companion: Companion;
    beforeAll(async () => {
        companion = await startCompanion(new Workspace(POLYGLOT), { version: 'test' });
    }, 60_000);
    afterAll(() => companion.close());

    it('parses only pairing links for this machine', () => {
        expect(parsePairing('#pair=abcdefghijklmnopqrstuvwx@127.0.0.1:4823')).toEqual({ token: 'abcdefghijklmnopqrstuvwx', host: '127.0.0.1', port: 4823 });
        expect(parsePairing('#pair=abcdefghijklmnopqrstuvwx@localhost:80')).toMatchObject({ host: 'localhost', port: 80 });
        expect(parsePairing('#pair=abcdefghijklmnopqrstuvwx@evil.example:4823')).toBeUndefined();
        expect(parsePairing('#pair=short@127.0.0.1:4823')).toBeUndefined();
        expect(parsePairing('#pair=abcdefghijklmnopqrstuvwx@127.0.0.1:99999')).toBeUndefined();
        expect(parsePairing('#other')).toBeUndefined();
    });

    it('pairs from the printed link, browses the engine, gets change events, and resumes with the session', async () => {
        const pairing = parsePairing(new URL(companion.pairingUrl).hash)!;
        const { engine, session, summary } = await CompanionEngine.connect(pairing, { token: pairing.token }, asApp);
        expect(summary).toMatchObject({ name: 'polyglot', storage: 'native' });
        expect((await engine.view({}))!.nodes.some((n) => n.key === 'pkg:rust')).toBe(true);
        expect((await engine.flows()).map((f) => f.label)).toContain('main');
        expect((await engine.tour('start-here'))!.steps[0]!.title).toBe('The big picture');
        expect(await engine.readFile('rb/lib/billing.rb')).toContain("require 'json'");

        const events: EngineEvent[] = [];
        engine.onEvent((e) => events.push(e));
        companion.notify('rb/lib/billing.rb');
        await expect.poll(() => events.length, { timeout: 5000 }).toBe(1);
        expect(events[0]).toMatchObject({ type: 'changed', paths: ['rb/lib/billing.rb'] });

        const closed = new Promise((r) => engine.onClose(r));
        engine.dispose();
        await closed;
        await expect(engine.view({})).rejects.toThrow(/Not connected/);

        // The link is spent; the session isn't.
        await expect(CompanionEngine.connect(pairing, { token: pairing.token }, asApp)).rejects.toMatchObject({ code: 4401 });
        const again = await CompanionEngine.connect(pairing, { session }, asApp);
        expect((await again.engine.summary()).storage).toBe('native');
        again.engine.dispose();
    });

    it('never connects anywhere but this machine', async () => {
        await expect(CompanionEngine.connect({ host: 'evil.example', port: 80 }, { session: 'x' }, asApp)).rejects.toThrow(/this machine only/);
    });
});
