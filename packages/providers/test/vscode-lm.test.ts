import { describe, expect, it } from 'vitest';
import { collect, vscodeLm, type LmChatModel, type VscodeLmApi } from '../src/index.js';

/** A stand-in for the vscode module's Language Model API. */
function fakeVscode(models: Array<Partial<LmChatModel> & { stream?: unknown[]; fail?: Error }>) {
    class TextPart {
        constructor(public value: string) {}
    }
    class ToolCallPart {
        constructor(
            public callId: string,
            public name: string,
            public input: object,
        ) {}
    }
    class ToolResultPart {
        constructor(
            public callId: string,
            public content: unknown[],
        ) {}
    }
    class LmError extends Error {
        constructor(public code: string) {
            super(code);
        }
    }
    const sent: Array<{ model: string; messages: unknown[]; options: unknown }> = [];
    let cancelled = 0;
    const list: LmChatModel[] = models.map((m) => ({
        id: m.id ?? 'gpt-x',
        name: m.name ?? 'GPT X',
        vendor: m.vendor ?? 'copilot',
        family: m.family ?? 'gpt',
        maxInputTokens: m.maxInputTokens ?? 128000,
        async sendRequest(messages, options) {
            sent.push({ model: m.id ?? 'gpt-x', messages, options });
            if (m.fail) throw m.fail;
            return {
                stream: (async function* () {
                    for (const p of m.stream ?? []) yield p;
                })(),
            };
        },
    }));
    const api: VscodeLmApi = {
        lm: { selectChatModels: async (sel) => list.filter((m) => !sel?.id || m.id === sel.id) },
        LanguageModelChatMessage: { User: (content) => ({ role: 'user', content }), Assistant: (content) => ({ role: 'assistant', content }) },
        LanguageModelTextPart: TextPart,
        LanguageModelToolCallPart: ToolCallPart,
        LanguageModelToolResultPart: ToolResultPart,
        LanguageModelChatToolMode: { Auto: 1 },
        CancellationTokenSource: class {
            token = {};
            cancel() {
                cancelled++;
            }
            dispose() {}
        },
        LanguageModelError: LmError as never,
    };
    return { api, sent, TextPart, ToolCallPart, LmError, cancelled: () => cancelled };
}

describe('vscode-lm', () => {
    it('reports VS Code without the API, and Copilot signed out', async () => {
        const { api } = fakeVscode([]);
        expect(await vscodeLm({ ...api, lm: undefined }).detect()).toEqual({ state: 'unreachable', detail: 'Needs VS Code 1.95 or later' });
        expect((await vscodeLm(api).detect()).detail).toMatch(/sign in to GitHub Copilot/);
    });

    it('lists the plan’s models with their context windows', async () => {
        const { api } = fakeVscode([{ id: 'claude-x', name: 'Claude X', vendor: 'copilot', maxInputTokens: 200000 }, { id: 'local', name: 'Local', vendor: 'acme' }]);
        const adapter = vscodeLm(api);
        expect(await adapter.detect()).toEqual({ state: 'ready', detail: '2 models from copilot, acme' });
        expect((await adapter.listModels()).map((m) => [m.id, m.label, m.contextWindow])).toEqual([
            ['claude-x', 'Claude X', 200000],
            ['local', 'Local (acme)', 128000],
        ]);
    });

    it('streams text and tool calls, sending the system prompt first and tool results as one user turn', async () => {
        const scripted = fakeVscode([]);
        // Parts must be the fake API's own classes (the adapter checks with instanceof).
        const reply = [new scripted.TextPart('Looking.'), new scripted.ToolCallPart('c1', 'search', { query: 'auth' })];
        const model = fakeVscode([{ id: 'gpt-x', stream: reply }]);
        model.api.LanguageModelTextPart = scripted.api.LanguageModelTextPart;
        model.api.LanguageModelToolCallPart = scripted.api.LanguageModelToolCallPart;
        const events = await collect(
            vscodeLm(model.api).chat({
                model: 'gpt-x',
                system: 'Rules.',
                messages: [
                    { role: 'user', content: 'q' },
                    { role: 'assistant', content: '', toolCalls: [{ id: 'c0', name: 'search', args: { query: 'x' } }] },
                    { role: 'tool', toolCallId: 'c0', name: 'search', content: 'r1' },
                    { role: 'tool', toolCallId: 'c0b', name: 'search', content: 'bad', isError: true },
                ],
                tools: [{ name: 'search', description: 'Search', parameters: { type: 'object' } }],
            }),
        );
        expect(events.filter((e) => e.type !== 'usage')).toEqual([
            { type: 'text', delta: 'Looking.' },
            { type: 'tool_call', call: { id: 'c1', name: 'search', args: { query: 'auth' } } },
            { type: 'done', stopReason: 'tool_use', turn: { content: 'Looking.', toolCalls: [{ id: 'c1', name: 'search', args: { query: 'auth' } }] } },
        ]);
        expect(events.find((e) => e.type === 'usage')).toMatchObject({ usage: { inputTokens: expect.any(Number), outputTokens: 2 } });
        const req = model.sent[0]!;
        expect(req.options).toMatchObject({ justification: expect.stringMatching(/CodeArchy/), toolMode: 1, tools: [{ name: 'search', inputSchema: { type: 'object' } }] });
        const messages = req.messages as Array<{ role: string; content: unknown }>;
        expect(messages.map((m) => m.role)).toEqual(['user', 'user', 'assistant', 'user']);
        expect(messages[0]!.content).toBe('Rules.');
        const results = messages[3]!.content as Array<{ callId: string; content: Array<{ value: string }> }>;
        expect(results.map((r) => [r.callId, r.content[0]!.value])).toEqual([
            ['c0', 'r1'],
            ['c0b', 'Error: bad'],
        ]);
    });

    it('maps VS Code errors (consent, quota, missing model) and cancellation', async () => {
        for (const [code, expected] of [
            ['NoPermissions', 'auth'],
            ['Blocked', 'quota'],
            ['NotFound', 'bad_request'],
        ] as const) {
            const f = fakeVscode([{ id: 'm' }]);
            const failing = fakeVscode([{ id: 'm', fail: new f.LmError(code) }]);
            failing.api.LanguageModelError = f.api.LanguageModelError; // the same class the error came from
            const [event] = await collect(vscodeLm(failing.api).chat({ model: 'm', messages: [] }));
            expect(event).toMatchObject({ type: 'error', error: { code: expected } });
        }
        const none = fakeVscode([]);
        const [missing] = await collect(vscodeLm(none.api).chat({ model: 'gone', messages: [] }));
        expect(missing).toMatchObject({ type: 'error', error: { code: 'bad_request', message: expect.stringMatching(/no model "gone"/) } });

        const slow = fakeVscode([{ id: 'm', fail: Object.assign(new Error('Canceled'), { name: 'Canceled' }) }]);
        const controller = new AbortController();
        controller.abort();
        const [cancelled] = await collect(vscodeLm(slow.api).chat({ model: 'm', messages: [] }, controller.signal));
        expect(cancelled).toMatchObject({ type: 'error', error: { code: 'cancelled' } });
    });

    it('a model only VS Code itself may use is never offered again, and the request is answered by the next best model', async () => {
        const { api, sent } = fakeVscode([
            { id: 'copilot-dictation-cleanup-luna', maxInputTokens: 1_000_000, fail: new Error('Model copilot-dictation-cleanup-luna is only available to VS Code core.') },
            { id: 'gpt-4.1', maxInputTokens: 128_000, stream: [] },
            { id: 'claude-sonnet', maxInputTokens: 200_000, stream: [] },
        ]);
        const lm = vscodeLm(api);
        expect((await lm.listModels()).map((m) => m.id)).toContain('copilot-dictation-cleanup-luna');
        const events = await collect(lm.chat({ model: 'copilot-dictation-cleanup-luna', messages: [{ role: 'user', content: 'Hi' }] }));
        expect(events.at(-1)?.type).toBe('done');
        expect(sent.map((s) => s.model)).toEqual(['copilot-dictation-cleanup-luna', 'claude-sonnet']);
        expect((await lm.listModels()).map((m) => m.id)).toEqual(['gpt-4.1', 'claude-sonnet']);
        // Asked for it again (a cached choice): straight to the alternative.
        await collect(lm.chat({ model: 'copilot-dictation-cleanup-luna', messages: [{ role: 'user', content: 'Hi' }] }));
        expect(sent.map((s) => s.model)).toEqual(['copilot-dictation-cleanup-luna', 'claude-sonnet', 'claude-sonnet']);
    });
});
