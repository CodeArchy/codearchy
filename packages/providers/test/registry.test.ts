import { describe, expect, it } from 'vitest';
import {
    anthropic,
    collect,
    MemoryAuditLog,
    ollama,
    openai,
    ProviderRegistry,
    type ChatEvent,
    type ModelInfo,
    type ProviderAdapter,
} from '../src/index.js';
import { mockFetch } from './helpers.js';

const model = (id: string, provider: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
    id,
    label: id,
    provider,
    supports: {},
    locality: 'cloud',
    ...extra,
});

/** A scriptable adapter that records the requests it receives. */
function fake(id: string, opts: { local?: boolean; models: ModelInfo[]; usage?: number; embed?: boolean }) {
    const requests: unknown[] = [];
    const adapter: ProviderAdapter = {
        id,
        label: id.toUpperCase(),
        kind: opts.local ? 'local' : 'api-key',
        baseUrl: opts.local ? 'http://localhost:9' : `https://${id}.example.com`,
        detect: async () => ({ state: 'ready' }),
        listModels: async () => opts.models,
        async *chat(request) {
            requests.push(request);
            yield { type: 'text', delta: 'hi' } as ChatEvent;
            yield { type: 'usage', usage: { inputTokens: opts.usage ?? 10, outputTokens: 5 } } as ChatEvent;
            yield { type: 'done', stopReason: 'end', turn: { content: 'hi', toolCalls: [] } } as ChatEvent;
        },
        ...(opts.embed
            ? {
                  embed: async (r: { input: string[] }) => {
                      requests.push(r);
                      return r.input.map(() => [0.1]);
                  },
              }
            : {}),
    };
    return { adapter, requests };
}

const ask = { messages: [{ role: 'user' as const, content: 'hello' }] };

describe('ProviderRegistry', () => {
    it('makes no network calls to remote providers under "local only" (refresh and chat)', async () => {
        const net = mockFetch((url) => (url.includes('localhost:11434') ? undefined : { json: {} }));
        const registry = new ProviderRegistry(
            [anthropic({ apiKey: 'sk-ant-test-0000000000', fetch: net.fetch }), openai({ apiKey: 'sk-test-0000000000', fetch: net.fetch })],
            { policy: { tier: 'local-only' } },
        );
        const snapshots = await registry.refresh();
        expect(snapshots.map((s) => [s.id, s.allowed.ok, s.status])).toEqual([
            ['anthropic', false, undefined],
            ['openai', false, undefined],
        ]);
        const events = await collect(registry.chat('chat', ask, { model: { provider: 'anthropic', model: 'claude-opus-5-5' } }));
        expect(events).toEqual([{ type: 'error', error: expect.objectContaining({ code: 'policy' }) }]);
        expect(net.requests).toEqual([]); // nothing left the machine

        // The same registry does reach a provider on this machine.
        const local = mockFetch((url) => (url.endsWith('/api/version') ? { json: { version: '1' } } : url.endsWith('/api/tags') ? { json: { models: [] } } : undefined));
        const withLocal = new ProviderRegistry([ollama({ fetch: local.fetch }), anthropic({ apiKey: 'k', fetch: net.fetch })], {
            policy: { tier: 'local-only' },
        });
        await withLocal.refresh();
        expect(local.requests.map((r) => r.url)).toEqual(['http://localhost:11434/api/version', 'http://localhost:11434/api/tags']);
        expect(net.requests).toEqual([]);
    });

    it('picks models automatically, with reasons: on-device first for the summarizer, the user order and defaults otherwise', async () => {
        const local = fake('ollama', { local: true, models: [model('small', 'ollama', { contextWindow: 8192, supports: { tools: false } })] });
        const cloud = fake('cloud', {
            models: [
                model('a', 'cloud', { contextWindow: 200_000, supports: { tools: true } }),
                model('b', 'cloud', { contextWindow: 1_000_000, supports: { tools: true } }),
                model('emb', 'cloud', { supports: { embeddings: true } }),
            ],
        });
        const registry = new ProviderRegistry([cloud.adapter, local.adapter], { policy: { tier: 'structure' }, defaults: { cloud: 'a' } }, { resilience: false });
        await registry.refresh();
        expect(registry.resolve('summarizer')).toMatchObject({ ok: true, provider: 'ollama', model: 'small', why: expect.stringContaining('runs on this machine') });
        expect(registry.resolve('chat')).toMatchObject({ ok: true, provider: 'cloud', model: 'a', why: expect.stringContaining('your chosen model') });
        registry.configure({ policy: { tier: 'structure' }, defaults: {} });
        expect(registry.resolve('chat')).toMatchObject({ provider: 'cloud', model: 'b' }); // tool-capable and the largest context
        registry.configure({ policy: { tier: 'structure' }, defaults: { cloud: 'a' } });
        expect(registry.resolve('embedder')).toMatchObject({ ok: true, provider: 'cloud', model: 'emb' });

        registry.configure({ policy: { tier: 'structure' } }); // no defaults: the largest context wins
        expect(registry.resolve('architect')).toMatchObject({ provider: 'cloud', model: 'b' });

        registry.configure({ policy: { tier: 'structure' }, roles: { chat: { provider: 'ollama', model: 'small' } } });
        expect(registry.resolve('chat')).toMatchObject({ ok: true, provider: 'ollama', why: 'Assigned to Chat in settings' });

        registry.configure({ policy: { tier: 'local-only' } });
        // The local model can't call tools: chat still takes it (and answers by retrieval)…
        expect(registry.resolve('chat')).toMatchObject({ ok: true, provider: 'ollama', model: 'small' });
        // …but nothing can embed.
        expect(registry.resolve('embedder')).toEqual({ ok: false, reason: 'No ready provider has a model for the Embedder role' });
    });

    it('blocks code excerpts under the structure tier and treats undeclared content as excerpts', async () => {
        const cloud = fake('cloud', { models: [model('m', 'cloud')] });
        const registry = new ProviderRegistry([cloud.adapter], { policy: { tier: 'structure' } }, { resilience: false });
        await registry.refresh();
        const undeclared = await collect(registry.chat('chat', ask));
        expect(undeclared[0]).toMatchObject({ type: 'error', error: { code: 'policy', message: expect.stringContaining('includes code') } });
        const structure = await collect(registry.chat('chat', ask, { contains: ['structure'] }));
        expect(structure.at(-1)).toMatchObject({ type: 'done' });
        expect(cloud.requests).toHaveLength(1);
    });

    it('redacts secrets before a remote request, and audits what was sent without the text', async () => {
        const cloud = fake('cloud', { models: [model('m', 'cloud')] });
        const audit = new MemoryAuditLog();
        let now = 1000;
        const registry = new ProviderRegistry([cloud.adapter], { policy: { tier: 'excerpts' } }, { resilience: false, audit, now: () => (now += 5) });
        await registry.refresh();
        const key = 'AKIAIOSFODNN7EXAMPLE';
        await collect(registry.chat('chat', { messages: [{ role: 'user', content: `my key is ${key}` }] }, { contains: ['excerpts'], nodes: ['mod:src/a.ts'] }));
        expect(JSON.stringify(cloud.requests)).not.toContain(key);
        expect(audit.entries()).toEqual([
            {
                at: expect.any(Number),
                provider: 'cloud',
                model: 'm',
                role: 'chat',
                remote: true,
                tier: 'excerpts',
                contains: ['excerpts'],
                outcome: 'sent',
                inputTokens: 10,
                outputTokens: 5,
                redactions: { 'aws-access-key': 1 },
                nodes: ['mod:src/a.ts'],
                durationMs: expect.any(Number),
            },
        ]);
        expect(JSON.stringify(audit.entries())).not.toContain('my key');
    });

    it('does not redact for on-device models (nothing leaves the machine)', async () => {
        const local = fake('ollama', { local: true, models: [model('m', 'ollama')] });
        const registry = new ProviderRegistry([local.adapter], { policy: { tier: 'local-only' } }, { resilience: false });
        await registry.refresh();
        await collect(registry.chat('summarizer', { messages: [{ role: 'user', content: 'AKIAIOSFODNN7EXAMPLE' }] }));
        expect(JSON.stringify(local.requests)).toContain('AKIAIOSFODNN7EXAMPLE');
    });

    it('stops at the budget', async () => {
        const cloud = fake('cloud', { models: [model('m', 'cloud')], usage: 995 });
        const registry = new ProviderRegistry([cloud.adapter], { policy: { tier: 'structure' }, budgets: { cloud: { tokensPerDay: 1000 } } }, { resilience: false });
        await registry.refresh();
        expect((await collect(registry.chat('chat', ask, { contains: ['structure'] }))).at(-1)).toMatchObject({ type: 'done' });
        const second = await collect(registry.chat('chat', ask, { contains: ['structure'] }));
        expect(second).toEqual([{ type: 'error', error: expect.objectContaining({ code: 'policy', message: expect.stringMatching(/daily budget/) }) }]);
        expect(cloud.requests).toHaveLength(1);
    });

    it('asks before sending when told to, and fails closed without a way to ask', async () => {
        const cloud = fake('cloud', { models: [model('m', 'cloud')] });
        const previews: unknown[] = [];
        let answer = false;
        const registry = new ProviderRegistry([cloud.adapter], { policy: { tier: 'structure', askBeforeSend: true } }, {
            resilience: false,
            inspect: async (p) => {
                previews.push(p);
                return answer;
            },
        });
        await registry.refresh();
        const declined = await collect(registry.chat('chat', ask, { contains: ['structure'] }));
        expect(declined[0]).toMatchObject({ type: 'error', error: { code: 'policy', message: 'You declined to send this request' } });
        expect(previews[0]).toMatchObject({ provider: 'cloud', providerLabel: 'CLOUD', model: 'm', findings: [], request: { model: 'm' } });
        answer = true;
        expect((await collect(registry.chat('chat', ask, { contains: ['structure'] }))).at(-1)).toMatchObject({ type: 'done' });
        expect(cloud.requests).toHaveLength(1);

        const noHook = new ProviderRegistry([fake('c2', { models: [model('m', 'c2')] }).adapter], { policy: { tier: 'structure', askBeforeSend: true } }, { resilience: false });
        await noHook.refresh();
        expect((await collect(noHook.chat('chat', ask, { contains: ['structure'] })))[0]).toMatchObject({ error: { code: 'policy' } });
    });

    it('embeds through the embedder role with the same checks', async () => {
        const cloud = fake('cloud', { models: [model('emb', 'cloud', { supports: { embeddings: true } })], embed: true });
        const audit = new MemoryAuditLog();
        const registry = new ProviderRegistry([cloud.adapter], { policy: { tier: 'structure' } }, { resilience: false, audit });
        await registry.refresh();
        await expect(registry.embed(['code'])).rejects.toMatchObject({ code: 'policy' }); // undeclared → excerpts
        expect(await registry.embed(['name AKIAIOSFODNN7EXAMPLE'], { contains: ['structure'] })).toEqual([[0.1]]);
        expect(JSON.stringify(cloud.requests)).not.toContain('AKIA');
        expect(audit.entries().map((e) => e.outcome)).toEqual(['blocked', 'sent']);
    });
});
