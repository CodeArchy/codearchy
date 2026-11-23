/**
 * A scripted AiClient for the playground (`?ai=demo`): no model, no network.
 * It answers from the real engine (search and describe), so the chat, card,
 * settings and preview UI can be seen and smoke-tested in every browser.
 */
import type { AiCard, AiClient, AiHostEvent, AiProviderInfo, AiSettings, AiState, ChatEvent, EngineClient } from '@codearchy/protocol';

export function demoAi(engine: EngineClient): AiClient {
    const listeners = new Set<(e: AiHostEvent) => void>();
    const emit = (e: AiHostEvent) => listeners.forEach((l) => l(e));
    const settings: AiSettings = { tier: 'structure', askBeforeSend: false, roles: {}, defaults: {}, budgets: {} };
    let cloudKey = false;
    const aiCards = new Map<string, AiCard>();
    const pending = new Map<string, (send: boolean) => void>();
    const cancelled = new Set<string>();
    let previews = 0;

    const providers = (): AiProviderInfo[] => [
        {
            id: 'demo',
            label: 'Demo model',
            kind: 'local',
            onDevice: true,
            allowed: true,
            state: 'ready',
            acceptsKey: false,
            hasKey: false,
            models: [{ id: 'scripted', label: 'scripted', tools: true }],
        },
        {
            id: 'cloud',
            label: 'Cloud (demo)',
            kind: 'api-key',
            onDevice: false,
            allowed: settings.tier !== 'local-only',
            ...(settings.tier === 'local-only' ? { blockedReason: 'Not on this machine, and the privacy tier is local only' } : {}),
            state: cloudKey ? 'ready' : 'needs-key',
            acceptsKey: true,
            hasKey: cloudKey,
            models: cloudKey ? [{ id: 'large', label: 'large', tools: true, contextWindow: 200000 }] : [],
        },
    ];
    const state = (): AiState => ({
        settings: structuredClone(settings),
        providers: providers(),
        resolved: {
            chat: { ok: true, provider: 'demo', model: 'scripted', why: 'Picked automatically: runs on this machine' },
            summarizer: { ok: true, provider: 'demo', model: 'scripted', why: 'Picked automatically: runs on this machine' },
            architect: { ok: true, provider: 'demo', model: 'scripted', why: 'Picked automatically: runs on this machine' },
            embedder: { ok: false, reason: 'No ready provider has a model for the Embedder role' },
        },
    });
    const changed = () => {
        const s = state();
        emit({ type: 'state', state: s });
        return s;
    };

    const baseCard = async (key: string): Promise<AiCard | undefined> => {
        const d = await engine.describe(key);
        if (!d) return undefined;
        const kids = d.children.slice(0, 3);
        return {
            key,
            title: d.name,
            purpose: d.kind === 'module' ? `A ${d.language ?? ''} file declaring ${d.symbols.length} symbols.`.replace('  ', ' ') : `${d.modules} files in ${d.children.length} parts.`,
            responsibilities: kids.map((k) => k.name),
            keyNodes: kids.map((k) => k.key),
            risks: d.cycleWith?.length ? ['Part of a dependency cycle'] : [],
            confidence: 0.2,
            source: 'deterministic',
            createdAt: Date.now(),
        };
    };

    return {
        state: async () => state(),
        refresh: async () => changed(),
        async updateSettings(patch) {
            Object.assign(settings, structuredClone(patch));
            return changed();
        },
        async setKey(provider, key) {
            if (provider === 'cloud') cloudKey = !!key;
            return changed();
        },
        async card(key, options) {
            if (aiCards.has(key)) return aiCards.get(key);
            const base = await baseCard(key);
            if (!base || !options?.generate) return base;
            await new Promise((r) => setTimeout(r, 150));
            const card: AiCard = { ...base, title: `${base.title} (summarized)`, purpose: `The demo model's summary of ${base.title}: ${base.purpose}`, source: 'ai', provider: 'demo', model: 'scripted', confidence: 0.7 };
            aiCards.set(key, card);
            emit({ type: 'card', card });
            return card;
        },
        async ask(conversation, question, options, onEvent: (e: ChatEvent) => void) {
            cancelled.delete(conversation);
            if (settings.askBeforeSend) {
                const id = `p${++previews}`;
                const send = await new Promise<boolean>((resolve) => {
                    pending.set(id, resolve);
                    emit({
                        type: 'preview',
                        preview: { id, role: 'chat', provider: 'demo', providerLabel: 'Demo model', model: 'scripted', messages: [{ role: 'user', content: question }], redactions: [], estimatedInputTokens: Math.ceil(question.length / 4) },
                    });
                });
                if (!send) return onEvent({ type: 'error', code: 'policy', message: 'You declined to send this request' });
            }
            onEvent({ type: 'status', text: `Searching for "${question}"…` });
            await new Promise((r) => setTimeout(r, 80));
            const words = question.split(/\W+/).filter((w) => w.length > 3);
            let hit: { key: string; name: string } | undefined;
            for (const w of words) {
                hit = (await engine.search?.(w))?.[0];
                if (hit) break;
            }
            const about = options.selection ? await engine.describe(options.selection) : undefined;
            const target = about ? { key: about.key, name: about.name } : hit;
            if (cancelled.has(conversation)) return onEvent({ type: 'error', code: 'cancelled', message: 'Stopped' });
            if (!target) {
                const answer = "I couldn't find anything matching that in the map.";
                onEvent({ type: 'text', delta: answer });
                return onEvent({ type: 'done', answer, citations: [], invalidCitations: 0, actions: [], mode: 'tools', rounds: 1, usage: { inputTokens: 40, outputTokens: 12 }, provider: 'demo', model: 'scripted' });
            }
            onEvent({ type: 'status', text: `Looking at ${target.name}…` });
            const answer = `The best match is [${target.name}](node:${target.key}).\n\n- It's in the map, and **Show me** opens it.\n- This is the demo model: it only searches.`;
            for (const chunk of answer.match(/.{1,24}/gs) ?? []) onEvent({ type: 'text', delta: chunk });
            const action = { action: 'focus' as const, keys: [target.key] };
            onEvent({ type: 'action', action });
            onEvent({
                type: 'done',
                answer,
                citations: [{ type: 'node', key: target.key, label: target.name }],
                invalidCitations: 0,
                actions: [action],
                mode: 'tools',
                rounds: 2,
                usage: { inputTokens: 120, outputTokens: 40 },
                provider: 'demo',
                model: 'scripted',
            });
        },
        cancel: (conversation) => void cancelled.add(conversation),
        reset: () => undefined,
        answerPreview(id, send) {
            pending.get(id)?.(send);
            pending.delete(id);
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}
