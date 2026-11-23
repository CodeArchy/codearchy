import { describe, expect, it } from 'vitest';
import type { HierarchyIndex } from '@codearchy/core';
import { FILES, index, reader } from './fixture.js';
import { ProviderRegistry, type ChatEvent, type ChatRequest, type ProviderAdapter } from '@codearchy/providers';
import { MemoryCardStore, Summarizer, type Card } from '../src/index.js';


/** A local model that answers every card request with `reply(request)`, recording what it was sent. */
function model(reply: (req: ChatRequest, n: number) => string, opts: { remote?: boolean } = {}) {
    const requests: ChatRequest[] = [];
    const adapter: ProviderAdapter = {
        id: 'fake',
        label: 'Fake',
        kind: opts.remote ? 'api-key' : 'local',
        baseUrl: opts.remote ? 'https://fake.example.com' : 'http://localhost:1',
        detect: async () => ({ state: 'ready' }),
        listModels: async () => [{ id: 'm1', label: 'm1', provider: 'fake', supports: { jsonSchema: true }, locality: 'on-device' }],
        async *chat(request) {
            requests.push(request);
            const text = reply(request, requests.length);
            yield { type: 'text', delta: text } as ChatEvent;
            yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } } as ChatEvent;
            yield { type: 'done', stopReason: 'end', turn: { content: text, toolCalls: [] } } as ChatEvent;
        },
    };
    return { adapter, requests };
}

const goodCard = (req: ChatRequest) => {
    const facts = req.messages[0]!.content as string;
    const first = /\b([SC]1)\b/.exec(facts)?.[1] ?? 'S1';
    return JSON.stringify({ title: 'A part', purpose: 'Does a thing.', responsibilities: ['one'], keyNodes: [first, 'Z99'], risks: [], confidence: 0.8 });
};

async function registryWith(adapter: ProviderAdapter, tier: 'local-only' | 'structure' = 'structure', budgets = {}) {
    const registry = new ProviderRegistry([adapter], { policy: { tier }, budgets }, { resilience: false });
    await registry.refresh();
    return registry;
}

const nonSymbol = (ix: HierarchyIndex) => ix.hierarchy.nodes.filter((n) => n.kind !== 'symbol');

describe('Summarizer', () => {
    it('writes deterministic cards from docs, READMEs and manifests when there is no AI', async () => {
        const ix = index();
        const s = new Summarizer({ index: ix, readFile: reader(FILES) });
        const session = await s.card('mod:src/auth/session.ts');
        expect(session).toMatchObject({
            title: 'session.ts',
            purpose: 'Session handling.',
            source: 'deterministic',
            keyNodes: ['sym:src/auth/session.ts#login', 'sym:src/auth/session.ts#logout'],
        });
        expect(session.responsibilities[0]).toBe('export function login(user: string)');
        const billing = ix.hierarchy.nodes.find((n) => n.path === 'src/billing' && n.kind !== 'module')!;
        expect((await s.card(billing.key)).purpose).toBe('Invoices and payment runs for the shop.');
        expect((await s.card('sys:root')).purpose).toBe('A small online shop.');
    });

    it('summarizes bottom-up with the right roles, citing only refs it was shown, and never sends code bodies', async () => {
        const ix = index();
        const fake = model(goodCard);
        const order: string[] = [];
        const s = new Summarizer({ index: ix, readFile: reader(FILES), registry: await registryWith(fake.adapter) });
        const result = await s.crawl(['sys:root'], { onCard: (c) => order.push(c.key) });
        const nodes = nonSymbol(ix);
        expect(result).toEqual({ cards: nodes.length, aiCards: nodes.length, calls: nodes.length });
        expect(order.at(-1)).toBe('sys:root');
        for (const n of nodes) {
            if (n.parent >= 0) expect(order.indexOf(n.key), n.key).toBeLessThan(order.indexOf(ix.hierarchy.nodes[n.parent]!.key)); // children first
        }

        const card = await s.card('mod:src/auth/session.ts');
        expect(card).toMatchObject({ source: 'ai', provider: 'fake', model: 'm1', keyNodes: ['sym:src/auth/session.ts#login'], confidence: 0.4 });

        const all = JSON.stringify(fake.requests);
        expect(all).toContain('export function login(user: string)'); // signatures are structure
        expect(all).not.toContain('secretInternalLogic'); // bodies never are
        expect(fake.requests.every((r) => r.json?.schema && r.maxOutputTokens)).toBe(true);
    });

    it('declares its requests as structure, so a remote model under the structure tier accepts them', async () => {
        const fake = model(goodCard, { remote: true });
        const s = new Summarizer({ index: index(), readFile: reader(FILES), registry: await registryWith(fake.adapter, 'structure') });
        expect((await s.card('mod:src/auth/tokens.ts')).source).toBe('ai');
    });

    it('reuses cached cards and re-summarizes only the path from a changed file to the root', async () => {
        const store = new MemoryCardStore();
        const first = model(goodCard);
        await new Summarizer({ index: index(), readFile: reader(FILES), registry: await registryWith(first.adapter), store }).crawl(['sys:root']);

        const again = model(goodCard);
        await new Summarizer({ index: index(), readFile: reader(FILES), registry: await registryWith(again.adapter), store }).crawl(['sys:root']);
        expect(again.requests).toHaveLength(0);

        const edited = { ...FILES, 'src/auth/tokens.ts': FILES['src/auth/tokens.ts']!.replace('Token signing.', 'Signs and verifies tokens.') };
        const ix = index(edited);
        const after = model(goodCard);
        await new Summarizer({ index: ix, readFile: reader(edited), registry: await registryWith(after.adapter), store }).crawl(['sys:root']);
        const pathToRoot = ix.ancestors(ix.indexOf('mod:src/auth/tokens.ts')!).length + 1;
        // The module, then each ancestor whose children's cards changed. The fake answers identically,
        // so a parent's inputs only change where a child's card text did: here just the module.
        expect(after.requests.length).toBeGreaterThanOrEqual(1);
        expect(after.requests.length).toBeLessThanOrEqual(pathToRoot);
        expect(after.requests[0]!.messages[0]!.content).toContain('Signs and verifies tokens.');
    });

    it('repairs one bad reply, and falls back (without caching the fallback) after two', async () => {
        const ix = index();
        let bad = 1;
        const flaky = model((req) => (bad-- > 0 ? 'not json' : goodCard(req)));
        const s = new Summarizer({ index: ix, readFile: reader(FILES), registry: await registryWith(flaky.adapter) });
        const card = await s.card('mod:src/billing/charge.ts');
        expect(card.source).toBe('ai');
        expect(flaky.requests).toHaveLength(2);
        expect(flaky.requests[1]!.messages.at(-1)!.content).toMatch(/wasn't usable/);

        const store = new MemoryCardStore();
        const broken = model(() => '{"title": 3}');
        const s2 = new Summarizer({ index: ix, readFile: reader(FILES), registry: await registryWith(broken.adapter), store });
        const fallback = await s2.card('mod:src/billing/charge.ts');
        expect(fallback).toMatchObject({ source: 'deterministic', note: expect.stringMatching(/couldn't be used/) });
        expect(await store.latest('mod:src/billing/charge.ts')).toBeUndefined();
        await s2.card('mod:src/billing/charge.ts'); // retried, not served from cache
        expect(broken.requests).toHaveLength(4);
    });

    it('stops calling at maxCalls or when the registry blocks (budget), and still returns every card', async () => {
        const ix = index();
        const total = nonSymbol(ix).length;
        const fake = model(goodCard);
        const limited = await new Summarizer({ index: ix, readFile: reader(FILES), registry: await registryWith(fake.adapter) }).crawl(['sys:root'], { maxCalls: 3 });
        expect(limited).toMatchObject({ cards: total, aiCards: 3, calls: 3, stopped: 'Stopped after 3 AI calls' });

        const metered = model(goodCard);
        const registry = await registryWith(metered.adapter, 'structure', { fake: { tokensPerDay: 300 } });
        // One call at a time, so the cap is exact (calls already in flight can overshoot it).
        const result = await new Summarizer({ index: ix, readFile: reader(FILES), registry, concurrency: 1 }).crawl(['sys:root']);
        expect(metered.requests).toHaveLength(2); // 150 tokens each
        expect(result.stopped).toMatch(/daily budget/);
        expect(result.cards).toBe(total);
    });

    it('gives deterministic cards and makes no calls when the tier rules every model out', async () => {
        const remote = model(goodCard, { remote: true });
        const s = new Summarizer({ index: index(), readFile: reader(FILES), registry: await registryWith(remote.adapter, 'local-only') });
        const card: Card = await s.card('sys:root');
        expect(card).toMatchObject({ source: 'deterministic', note: expect.stringMatching(/privacy tier/) });
        expect(remote.requests).toHaveLength(0);
    });

    it('estimates the calls a subtree still needs', async () => {
        const ix = index();
        const s = new Summarizer({ index: ix, readFile: reader(FILES), registry: await registryWith(model(goodCard).adapter) });
        const before = await s.estimate('sys:root');
        expect(before).toMatchObject({ nodes: nonSymbol(ix).length, uncached: nonSymbol(ix).length, calls: nonSymbol(ix).length });
        expect(before.inputTokens).toBeGreaterThan(0);
        await s.crawl(['sys:root']);
        expect((await s.estimate('sys:root')).uncached).toBe(0);
    });
});
