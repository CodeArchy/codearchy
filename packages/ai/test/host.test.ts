import { describe, expect, it } from 'vitest';
import type { AiHostEvent, AiSettings, ChatEvent as UiChatEvent } from '@codearchy/protocol';
import { apiKeyName, MemorySecretStore, type ChatEvent, type ChatRequest, type ProviderAdapter } from '@codearchy/providers';
import { AiHost, type ProviderFactory } from '../src/index.js';
import { FILES, index, reader } from './fixture.js';

/** A provider that answers card requests with a valid card and chat with a short cited answer. */
function provider(id: string, opts: { local?: boolean; needsKey?: boolean; slow?: boolean } = {}) {
    const requests: ChatRequest[] = [];
    const detects: number[] = [];
    const factory: ProviderFactory = {
        id,
        label: id.toUpperCase(),
        acceptsKey: !!opts.needsKey,
        ...(opts.local ? { setup: { title: 'Install it', steps: ['run it'] } } : {}),
        create(apiKey): ProviderAdapter {
            return {
                id,
                label: id.toUpperCase(),
                kind: opts.local ? 'local' : 'api-key',
                baseUrl: opts.local ? 'http://localhost:1' : `https://${id}.example.com`,
                detect: async () => {
                    detects.push(Date.now());
                    return opts.needsKey && !apiKey ? { state: 'needs-key' } : { state: 'ready' };
                },
                listModels: async () => [{ id: 'm', label: 'M', provider: id, supports: { tools: true, jsonSchema: true }, locality: opts.local ? 'on-device' : 'cloud' }],
                async *chat(request, signal) {
                    requests.push(request);
                    if (opts.slow) {
                        await new Promise<void>((resolve) => {
                            const t = setTimeout(resolve, 2000);
                            signal?.addEventListener('abort', () => {
                                clearTimeout(t);
                                resolve();
                            });
                        });
                        if (signal?.aborted) {
                            yield { type: 'error', error: Object.assign(new Error('Cancelled'), { code: 'cancelled', provider: id, retryable: false }) } as ChatEvent;
                            return;
                        }
                    }
                    const text = request.json
                        ? JSON.stringify({ title: 'Written', purpose: 'Written by the model.', responsibilities: [], keyNodes: [], risks: [], confidence: 0.8 })
                        : 'See [session.ts](node:mod:src/auth/session.ts).';
                    yield { type: 'text', delta: text } as ChatEvent;
                    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } } as ChatEvent;
                    yield { type: 'done', stopReason: 'end', turn: { content: text, toolCalls: [] } } as ChatEvent;
                },
            };
        },
    };
    return { factory, requests, detects };
}

function host(factories: ProviderFactory[], saved?: Partial<AiSettings>) {
    const events: AiHostEvent[] = [];
    const secrets = new MemorySecretStore();
    const stored: AiSettings[] = [];
    const ix = index();
    const h = new AiHost({
        index: () => ix,
        readFile: reader(FILES),
        providers: factories,
        secrets,
        settings: { load: async () => saved, save: async (s) => void stored.push(s) },
        emit: (e) => events.push(e),
    });
    return { h, events, secrets, stored };
}

const run = async (h: AiHost, conversation: string, question: string, selection?: string) => {
    const events: UiChatEvent[] = [];
    await h.ask(conversation, question, { selection }, (e) => events.push(e));
    return events;
};

describe('AiHost', () => {
    it('starts private: local only, so cloud providers are blocked and never contacted', async () => {
        const local = provider('ollama', { local: true });
        const cloud = provider('cloud', { needsKey: true });
        const { h } = host([local.factory, cloud.factory]);
        const state = await h.state();
        expect(state.settings.tier).toBe('local-only');
        expect(state.providers.map((p) => [p.id, p.allowed, p.state ?? null, p.onDevice])).toEqual([
            ['ollama', true, 'ready', true],
            ['cloud', false, null, false],
        ]);
        expect(state.providers[0]!.setup).toEqual({ title: 'Install it', steps: ['run it'] });
        expect(state.resolved.chat).toMatchObject({ ok: true, provider: 'ollama' });
    });

    it('checks no provider until AI is used: an auto-built card makes no network request', async () => {
        const local = provider('ollama', { local: true });
        const { h } = host([local.factory]);
        expect(await h.card('mod:src/auth/session.ts')).toMatchObject({ source: 'deterministic' });
        expect(local.detects).toHaveLength(0);
        await h.state(); // the Ask panel or AI settings opened
        expect(local.detects).toHaveLength(1);
        await h.state();
        expect(local.detects).toHaveLength(1); // checked once
        await h.updateSettings({ askBeforeSend: true });
        expect(local.detects).toHaveLength(2); // re-checked after a change, once in use
    });

    it('stores keys only in the secret store and never returns them', async () => {
        const cloud = provider('cloud', { needsKey: true });
        const { h, secrets, events } = host([cloud.factory], { tier: 'structure' });
        expect((await h.state()).providers[0]).toMatchObject({ state: 'needs-key', hasKey: false });
        const after = await h.setKey('cloud', '  sk-secret-value-123456  ');
        expect(await secrets.get(apiKeyName('cloud'))).toBe('sk-secret-value-123456');
        expect(after.providers[0]).toMatchObject({ state: 'ready', hasKey: true });
        expect(JSON.stringify(after)).not.toContain('sk-secret');
        expect(JSON.stringify(events)).not.toContain('sk-secret');
        expect(events.at(-1)).toMatchObject({ type: 'state' });
        await h.setKey('cloud', null);
        expect(await secrets.get(apiKeyName('cloud'))).toBeUndefined();
        await expect(h.setKey('nope', 'x')).rejects.toThrow(/doesn't take an API key/);
    });

    it('cleans and saves settings from the UI, and re-applies the tier', async () => {
        const cloud = provider('cloud');
        const { h, stored } = host([cloud.factory]);
        const state = await h.updateSettings({
            tier: 'nonsense' as never,
            roles: { chat: { provider: 'cloud', model: 'm' }, summarizer: 42 as never },
            budgets: { cloud: { tokensPerDay: 1000, tokensPerMonth: -5 } },
            defaults: { cloud: 'm', bad: '' },
        });
        expect(state.settings).toEqual({ tier: 'local-only', askBeforeSend: false, roles: { chat: { provider: 'cloud', model: 'm' } }, defaults: { cloud: 'm' }, budgets: { cloud: { tokensPerDay: 1000 } } });
        expect(stored).toHaveLength(1);
        expect(state.resolved.chat).toMatchObject({ ok: false }); // cloud is assigned but local only rules it out
        const open = await h.updateSettings({ tier: 'structure' });
        expect(open.resolved.chat).toMatchObject({ ok: true, provider: 'cloud', why: 'Assigned to Chat in settings' });
    });

    it('gives auto-built cards until asked, then writes AI cards for the subtree, announcing each', async () => {
        const local = provider('ollama', { local: true });
        const { h, events } = host([local.factory]);
        expect(await h.card('mod:src/auth/session.ts')).toMatchObject({ source: 'deterministic', purpose: 'Session handling.' });
        expect(local.requests).toHaveLength(0);
        const billing = index().hierarchy.nodes.find((n) => n.path === 'src/billing' && n.kind !== 'module')!;
        const card = await h.card(billing.key, { generate: true });
        expect(card).toMatchObject({ source: 'ai', title: 'Written', provider: 'ollama', model: 'm' });
        const announced = events.filter((e) => e.type === 'card').map((e) => (e as { card: { key: string } }).card.key);
        expect(announced).toEqual(['mod:src/billing/charge.ts', 'mod:src/billing/invoice.ts', billing.key]);
        expect(await h.card('sym:src/auth/session.ts#login')).toBeUndefined();
    });

    it('answers in conversations that remember their history', async () => {
        const local = provider('ollama', { local: true });
        const { h } = host([local.factory]);
        const first = await run(h, 'c1', 'where is login?');
        expect(first.at(-1)).toMatchObject({ type: 'done', answer: 'See [session.ts](node:mod:src/auth/session.ts).', citations: [{ type: 'node', key: 'mod:src/auth/session.ts' }] });
        await run(h, 'c1', 'and logout?');
        expect(local.requests[1]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
        h.reset('c1');
        await run(h, 'c1', 'again');
        expect(local.requests[2]!.messages).toHaveLength(1);
    });

    it('cancels a running answer', async () => {
        const slow = provider('ollama', { local: true, slow: true });
        const { h } = host([slow.factory]);
        const pending = run(h, 'c1', 'q');
        await new Promise((r) => setTimeout(r, 50));
        h.cancel('c1');
        expect((await pending).at(-1)).toMatchObject({ type: 'error', code: 'cancelled' });
    });

    it('asks before sending to a cloud model when told to, and respects the answer', async () => {
        const cloud = provider('cloud');
        const { h, events } = host([cloud.factory], { tier: 'structure', askBeforeSend: true });
        const pending = run(h, 'c1', 'where is login?');
        await new Promise((r) => setTimeout(r, 20));
        const preview = events.find((e) => e.type === 'preview') as Extract<AiHostEvent, { type: 'preview' }>;
        expect(preview.preview).toMatchObject({ provider: 'cloud', providerLabel: 'CLOUD', model: 'm', role: 'chat', redactions: [] });
        expect(preview.preview.messages.at(-1)!.content).toContain('where is login?');
        h.answerPreview(preview.preview.id, false);
        expect((await pending).at(-1)).toMatchObject({ type: 'error', code: 'policy', message: 'You declined to send this request' });
        expect(cloud.requests).toHaveLength(0);
    });

    it('dispatches RPC methods and keeps an audit trail', async () => {
        const local = provider('ollama', { local: true });
        const { h } = host([local.factory]);
        expect(await h.handle('state', {})).toMatchObject({ settings: { tier: 'local-only' } });
        expect(await h.handle('card', { key: 'mod:src/auth/tokens.ts' })).toMatchObject({ source: 'deterministic' });
        await run(h, 'c', 'q');
        expect(await h.handle('audit', {})).toEqual([expect.objectContaining({ provider: 'ollama', role: 'chat', remote: false, outcome: 'sent', inputTokens: 10 })]);
        await expect(h.handle('frobnicate', {})).rejects.toThrow(/Unknown AI method/);
    });
});

describe('local models', () => {
    function managed() {
        const installed = new Map([['gemma3:4b', 3_300_000_000]]);
        const p = provider('ollama', { local: true });
        const create = p.factory.create;
        p.factory.create = (key) => ({
            ...create(key),
            listModels: async () => [...installed.keys()].map((id) => ({ id, label: id, provider: 'ollama', supports: { tools: true }, locality: 'on-device' as const })),
            manage: {
                installed: async () => [...installed].map(([id, size]) => ({ id, size })),
                async pull(model, onProgress, signal) {
                    for (let i = 1; i <= 3; i++) {
                        if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
                        onProgress({ status: 'downloading', completed: i * 100, total: 300 });
                        await new Promise((r) => setTimeout(r, model === 'slow:1b' ? 300 : 210));
                    }
                    installed.set(model, 300);
                },
                remove: async (model) => void installed.delete(model),
            },
        });
        return p;
    }

    it('lists, downloads (with progress events) and removes models; the new model is offered at once', async () => {
        const { h, events } = host([managed().factory], { tier: 'local-only' });
        const before = await h.state();
        expect(before.providers[0]).toMatchObject({ id: 'ollama', managesModels: true });
        expect(await h.localModels('ollama')).toEqual([{ id: 'gemma3:4b', size: 3_300_000_000 }]);
        const after = await h.pullModel('ollama', ' qwen3:8b ');
        expect(after.providers[0]!.models.map((m) => m.id)).toEqual(['gemma3:4b', 'qwen3:8b']);
        const pulls = events.flatMap((e) => (e.type === 'pull' ? [e.progress] : []));
        expect(pulls[0]).toMatchObject({ provider: 'ollama', model: 'qwen3:8b', state: 'running' });
        expect(pulls.some((p) => p.total === 300 && (p.completed ?? 0) > 0)).toBe(true);
        expect(pulls.at(-1)).toMatchObject({ state: 'done' });
        await h.updateSettings({ defaults: { ollama: 'qwen3:8b' } });
        const removed = await h.deleteModel('ollama', 'qwen3:8b');
        expect(removed.providers[0]!.models.map((m) => m.id)).toEqual(['gemma3:4b']);
        expect(removed.settings.defaults.ollama).toBeUndefined(); // the default that pointed at it is gone
    });

    it('a download can be cancelled; odd names and unmanaged providers are refused', async () => {
        const { h, events } = host([managed().factory, provider('anthropic', { needsKey: true }).factory], { tier: 'local-only' });
        await h.state();
        const pending = h.pullModel('ollama', 'slow:1b');
        await new Promise((r) => setTimeout(r, 50));
        h.cancelPull('ollama', 'slow:1b');
        await pending;
        expect(events.flatMap((e) => (e.type === 'pull' ? [e.progress.state] : [])).at(-1)).toBe('cancelled');
        expect(await h.localModels('ollama')).toEqual([{ id: 'gemma3:4b', size: 3_300_000_000 }]);
        await expect(h.pullModel('ollama', 'rm -rf /')).rejects.toThrow(/isn't a model name/);
        await expect(h.localModels('anthropic')).rejects.toThrow(/doesn't manage/);
    });
});

