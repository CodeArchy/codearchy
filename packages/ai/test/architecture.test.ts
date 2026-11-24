import { describe, expect, it } from 'vitest';
import type { AiHostEvent } from '@codearchy/protocol';
import { MemorySecretStore, type ChatEvent, type ChatRequest } from '@codearchy/providers';
import { AiHost, applyDesign, designFacts, type ProviderFactory, type StoredDesign } from '../src/index.js';
import { FILES, index, reader } from './fixture.js';

const S = 'mod:src/auth/session.ts';
const T = 'mod:src/auth/tokens.ts';
const C = 'mod:src/billing/charge.ts';
const I = 'mod:src/billing/invoice.ts';
const meta = { provider: 'ollama', model: 'qwen3:8b', createdAt: 7 };

describe('architecture design (v1 System view, grounded)', () => {
    it('groups real code into named subsystems and services, adds the systems around it, keeps real dependencies', () => {
        const f = designFacts(index());
        const reply = {
            pattern: 'Modular monolith',
            summary: 'A small shop: authentication and billing.',
            nodes: [
                { id: 'auth', label: 'Authentication Service', description: 'Signs users in and issues tokens.', type: 'service', layer: 'domain', parts: [S, T] },
                { id: 'billing', label: 'Billing Subsystem', description: 'Invoices and charges.', type: 'subsystem', parts: [C, I, 'mod:src/nope.ts'] },
                { id: 'ghost', label: 'Ghost', description: 'Nothing real.', type: 'service', parts: ['mod:src/nope.ts'] },
                { id: 'stripe', label: 'Stripe', description: 'Card payments.', type: 'external' },
                { id: 'customers', label: 'Customers', description: 'People buying.', type: 'actor' },
            ],
            edges: [
                { source: 'customers', target: 'billing', label: 'pay invoices', type: 'api-call' },
                { source: 'billing', target: 'auth', label: 'checks sessions', type: 'api-call' },
                { source: 'billing', target: 'stripe', label: 'charges cards', type: 'data-flow' },
                { source: 'billing', target: 'nowhere', label: 'x', type: 'event' },
            ],
        };
        const a = applyDesign(f, { reply, ...meta });
        expect(a).toMatchObject({ pattern: 'Modular monolith', source: 'ai', provider: 'ollama', model: 'qwen3:8b', createdAt: 7 });
        const byLabel = (l: string) => a.nodes.find((n) => n.label === l)!;
        expect(byLabel('Authentication Service')).toMatchObject({ kind: 'part', type: 'service', layer: 'domain', parts: [S, T], files: 2 });
        expect(byLabel('Billing Subsystem')).toMatchObject({ kind: 'part', type: 'subsystem', parts: [C, I], files: 2 }); // the invented file is dropped
        expect(a.nodes.some((n) => n.label === 'Ghost')).toBe(false); // nothing real: dropped
        expect(byLabel('Stripe')).toMatchObject({ kind: 'external', layer: 'external', parts: [] });
        expect(byLabel('Customers')).toMatchObject({ kind: 'actor', layer: 'actors' });
        const edge = (from: string, to: string) => a.edges.find((e) => e.source === byLabel(from).id && e.target === byLabel(to).id);
        expect(edge('Billing Subsystem', 'Authentication Service')).toMatchObject({ label: 'checks sessions', kind: 'request', weight: expect.any(Number) }); // charge.ts imports session.ts
        expect(edge('Billing Subsystem', 'Stripe')).toMatchObject({ kind: 'data' });
        expect(edge('Customers', 'Billing Subsystem')).toMatchObject({ kind: 'request' });
        const ids = new Set(a.nodes.map((n) => n.id));
        expect(a.edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true);
    });

    it('code the design leaves out stays on the diagram, and its real dependencies are drawn', () => {
        const f = designFacts(index());
        const a = applyDesign(f, { reply: { pattern: 'p', summary: 's', nodes: [{ id: 'auth', label: 'Auth', description: 'd', type: 'service', parts: [S, T] }], edges: [] }, ...meta });
        expect(a.nodes.filter((n) => n.kind === 'part').flatMap((n) => n.parts).sort()).toEqual([C, I, S, T].sort());
        const auth = a.nodes.find((n) => n.label === 'Auth')!;
        expect(a.edges).toContainEqual(expect.objectContaining({ source: C, target: auth.id, label: 'uses', kind: 'depends' }));
    });

    it('a reply without the required fields is refused', () => {
        expect(() => applyDesign(designFacts(index()), { reply: { pattern: 'x' }, ...meta })).toThrow(/required/);
    });

    it('AiHost asks the architect model, repairs a bad reply once, and keeps the design across a reload', async () => {
        const ix = index();
        const requests: ChatRequest[] = [];
        const replies = ['Sure! Here is the architecture.', JSON.stringify({ pattern: 'Layered service', summary: 'Auth and billing.', nodes: [{ id: 'auth', label: 'Identity', description: 'Users.', type: 'service', parts: [S, T] }], edges: [] })];
        const factory: ProviderFactory = {
            id: 'ollama',
            label: 'Ollama',
            acceptsKey: false,
            create: () => ({
                id: 'ollama',
                label: 'Ollama',
                kind: 'local',
                baseUrl: 'http://localhost:11434',
                detect: async () => ({ state: 'ready' }),
                listModels: async () => [{ id: 'qwen3:8b', label: 'qwen3:8b', provider: 'ollama', supports: { tools: true, jsonSchema: true }, locality: 'on-device' }],
                async *chat(request) {
                    requests.push(request);
                    const text = replies[Math.min(requests.length - 1, 1)]!;
                    yield { type: 'text', delta: text } as ChatEvent;
                    yield { type: 'done', stopReason: 'end', turn: { content: text, toolCalls: [] } } as ChatEvent;
                },
            }),
        };
        const kept = new Map<string, StoredDesign>();
        const designs = { load: async (k: string) => kept.get(k), save: async (k: string, d: StoredDesign) => void kept.set(k, d) };
        const make = () => new AiHost({ index: () => ix, readFile: reader(FILES), providers: [factory], secrets: new MemorySecretStore(), settings: { load: async () => undefined, save: async () => undefined }, emit: (_e: AiHostEvent) => undefined, designs });
        const h = make();
        expect(await h.describeArchitecture()).toBeUndefined();
        const a = (await h.describeArchitecture({ generate: true }))!;
        expect(a).toMatchObject({ pattern: 'Layered service', source: 'ai', provider: 'ollama', model: 'qwen3:8b' });
        expect(a.nodes.find((n) => n.label === 'Identity')).toMatchObject({ type: 'service', parts: [S, T] });
        expect(requests).toHaveLength(2); // one repair
        expect(requests[0]!.json?.name).toBe('architecture');
        expect(String(requests[0]!.messages[0]!.content)).toContain('buildingBlocks');
        // A new host (a reload) shows the kept design without asking the model again.
        const again = await make().describeArchitecture();
        expect(again?.pattern).toBe('Layered service');
        expect(requests).toHaveLength(2);
    });
});
