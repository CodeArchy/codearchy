import { describe, expect, it } from 'vitest';
import { anthropic, collect, type ChatEvent } from '../src/index.js';
import { mockFetch, sseOf, split, type Route } from './helpers.js';

const KEY = 'sk-ant-test-0123456789';
const MODEL = 'claude-opus-5-5';

const start = (usage = { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 4, cache_creation_input_tokens: 1 }) => ({
    event: 'message_start',
    data: {
        type: 'message_start',
        message: { id: 'msg_1', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage },
    },
});
const blockStart = (index: number, content_block: unknown) => ({
    event: 'content_block_start',
    data: { type: 'content_block_start', index, content_block },
});
const blockDelta = (index: number, delta: unknown) => ({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta } });
const blockStop = (index: number) => ({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
const end = (stop_reason: string, output_tokens = 5) => [
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
];

/** Answers the Models API (for the output limit) and streams `events` for /v1/messages. */
function api(events: unknown[], maxTokens = 128000): Route[] {
    return [
        (url, req) =>
            req.method === 'GET' && url.includes('/v1/models/')
                ? { json: { id: MODEL, type: 'model', display_name: 'Claude Opus 5.5', max_tokens: maxTokens, max_input_tokens: 1000000 } }
                : undefined,
        (url) => (url.includes('/v1/messages') ? { chunks: split(sseOf(events), 6) } : undefined),
    ];
}

const textOf = (events: ChatEvent[]) =>
    events.flatMap((e) => (e.type === 'text' ? [e.delta] : e.type === 'restart' ? ['|restart|'] : [])).join('');

describe('anthropic', () => {
    it('streams text, caches the system prompt, opts into the refusal fallback and sends no sampling parameters', async () => {
        const { fetch, requests } = mockFetch(
            ...api([start(), blockStart(0, { type: 'text', text: '' }), blockDelta(0, { type: 'text_delta', text: 'Hello' }), blockDelta(0, { type: 'text_delta', text: ' world' }), blockStop(0), ...end('end_turn')]),
        );
        const events = await collect(
            anthropic({ apiKey: KEY, fetch, maxRetries: 0 }).chat({
                model: MODEL,
                system: 'You map code.',
                messages: [{ role: 'user', content: 'hi' }],
                temperature: 0.3,
            }),
        );
        expect(textOf(events)).toBe('Hello world');
        expect(events.at(-2)).toEqual({ type: 'usage', usage: { inputTokens: 15, outputTokens: 5, cachedInputTokens: 4 } });
        expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end', turn: { content: 'Hello world', toolCalls: [] } });

        const req = requests.find((r) => r.url.includes('/v1/messages'))!;
        expect(req.headers.authorization ?? req.headers['x-api-key']).toContain(KEY);
        expect(req.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
        expect(req.body).toMatchObject({
            model: MODEL,
            max_tokens: 64000, // the model allows 128k; streaming default caps at 64k
            stream: true,
            fallbacks: 'default',
            cache_control: { type: 'ephemeral' },
            system: [{ type: 'text', text: 'You map code.', cache_control: { type: 'ephemeral' } }],
            messages: [{ role: 'user', content: 'hi' }],
        });
        expect(req.body).not.toHaveProperty('temperature');
        expect(req.body).not.toHaveProperty('betas');
    });

    it('streams tool input, returns the call, and replays the whole turn (thinking included) next time', async () => {
        const { fetch, requests } = mockFetch(
            ...api([
                start(),
                blockStart(0, { type: 'thinking', thinking: '', signature: '' }),
                blockDelta(0, { type: 'signature_delta', signature: 'sig-abc' }),
                blockStop(0),
                blockStart(1, { type: 'tool_use', id: 'toolu_1', name: 'search', input: {} }),
                blockDelta(1, { type: 'input_json_delta', partial_json: '{"q":' }),
                blockDelta(1, { type: 'input_json_delta', partial_json: '"auth"}' }),
                blockStop(1),
                ...end('tool_use'),
            ]),
        );
        const adapter = anthropic({ apiKey: KEY, fetch, maxRetries: 0 });
        const events = await collect(
            adapter.chat({
                model: MODEL,
                messages: [{ role: 'user', content: 'find auth' }],
                tools: [{ name: 'search', description: 'Search the map', parameters: { type: 'object', properties: { q: { type: 'string' } } } }],
                maxOutputTokens: 2000,
            }),
        );
        expect(events.filter((e) => e.type === 'tool_call')).toEqual([
            { type: 'tool_call', call: { id: 'toolu_1', name: 'search', args: { q: 'auth' } } },
        ]);
        const done = events.at(-1) as Extract<ChatEvent, { type: 'done' }>;
        expect(done.stopReason).toBe('tool_use');
        expect(done.turn.replay?.provider).toBe('anthropic');

        const first = requests.find((r) => r.url.includes('/v1/messages'))!.body as Record<string, unknown>;
        expect(first).toMatchObject({
            max_tokens: 2000,
            tool_choice: { type: 'auto' },
            tools: [{ name: 'search', eager_input_streaming: true, input_schema: { type: 'object' } }],
        });

        await collect(
            adapter.chat({
                model: MODEL,
                maxOutputTokens: 2000,
                messages: [
                    { role: 'user', content: 'find auth' },
                    { role: 'assistant', content: done.turn.content, toolCalls: done.turn.toolCalls, replay: done.turn.replay },
                    { role: 'tool', toolCallId: 'toolu_1', name: 'search', content: 'src/auth.ts' },
                    { role: 'tool', toolCallId: 'toolu_2', name: 'search', content: 'nothing', isError: true },
                ],
            }),
        );
        const second = requests.filter((r) => r.url.includes('/v1/messages')).at(-1)!.body as { messages: unknown[] };
        expect(second.messages).toEqual([
            { role: 'user', content: 'find auth' },
            {
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: '', signature: 'sig-abc' },
                    { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'auth' } },
                ],
            },
            {
                role: 'user',
                content: [
                    { type: 'tool_result', tool_use_id: 'toolu_1', content: 'src/auth.ts' },
                    { type: 'tool_result', tool_use_id: 'toolu_2', content: 'nothing', is_error: true },
                ],
            },
        ]);
    });

    it('signals a restart when the fallback model takes over, and keeps only its answer', async () => {
        const { fetch } = mockFetch(
            ...api([
                start(),
                blockStart(0, { type: 'text', text: '' }),
                blockDelta(0, { type: 'text_delta', text: 'Partial' }),
                blockStop(0),
                blockStart(1, {
                    type: 'fallback',
                    from: { model: MODEL },
                    to: { model: 'claude-opus-5' },
                    trigger: { type: 'refusal', category: null },
                }),
                blockStop(1),
                blockStart(2, { type: 'text', text: '' }),
                blockDelta(2, { type: 'text_delta', text: 'Full answer' }),
                blockStop(2),
                ...end('end_turn'),
            ]),
        );
        const events = await collect(anthropic({ apiKey: KEY, fetch, maxRetries: 0 }).chat({ model: MODEL, messages: [{ role: 'user', content: 'q' }] }));
        expect(textOf(events)).toBe('Partial|restart|Full answer');
        expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end', turn: { content: 'Full answer' } });
    });

    it('runs no tools from a refused or truncated turn', async () => {
        for (const reason of ['refusal', 'max_tokens']) {
            const { fetch } = mockFetch(
                ...api([
                    start(),
                    blockStart(0, { type: 'tool_use', id: 'toolu_1', name: 'search', input: {} }),
                    blockDelta(0, { type: 'input_json_delta', partial_json: '{"q":"a"}' }),
                    blockStop(0),
                    ...end(reason),
                ]),
            );
            const events = await collect(anthropic({ apiKey: KEY, fetch, maxRetries: 0 }).chat({ model: MODEL, messages: [], maxOutputTokens: 10 }));
            expect(events.some((e) => e.type === 'tool_call')).toBe(false);
            expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: reason, turn: { toolCalls: [] } });
        }
    });

    it('maps API errors through the SDK classes, without the key', async () => {
        const cases: Array<[number, unknown, Record<string, string>, string]> = [
            [401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, {}, 'auth'],
            [429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, { 'retry-after': '3' }, 'rate_limit'],
            [529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, {}, 'unavailable'],
            [400, { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 1200000 tokens > 1000000 maximum' } }, {}, 'context_overflow'],
            [404, { type: 'error', error: { type: 'not_found_error', message: 'model: nope' } }, {}, 'bad_request'],
        ];
        for (const [status, json, headers, code] of cases) {
            const { fetch } = mockFetch(() => ({ status, json, headers }));
            const [event] = await collect(
                anthropic({ apiKey: KEY, fetch, maxRetries: 0 }).chat({ model: MODEL, messages: [], maxOutputTokens: 10 }),
            );
            expect(event).toMatchObject({ type: 'error', error: { code, status } });
            expect((event as { error: Error }).error.message).not.toContain(KEY);
            if (code === 'rate_limit') expect((event as { error: { retryAfterMs: number } }).error.retryAfterMs).toBe(3000);
        }
    });

    it('lists models with limits and capabilities from the Models API', async () => {
        const caps = { structured_outputs: { supported: true }, image_input: { supported: true } };
        const { fetch } = mockFetch((url) =>
            url.includes('/v1/models')
                ? {
                      json: {
                          data: [{ id: MODEL, type: 'model', display_name: 'Claude Opus 5.5', max_input_tokens: 1000000, max_tokens: 128000, capabilities: caps }],
                          has_more: false,
                          first_id: MODEL,
                          last_id: MODEL,
                      },
                  }
                : undefined,
        );
        const adapter = anthropic({ apiKey: KEY, fetch, maxRetries: 0 });
        expect(await adapter.listModels()).toEqual([
            {
                id: MODEL,
                label: 'Claude Opus 5.5',
                provider: 'anthropic',
                contextWindow: 1000000,
                maxOutput: 128000,
                supports: { tools: true, jsonSchema: true, vision: true, embeddings: false },
                locality: 'cloud',
            },
        ]);
        expect(await adapter.detect()).toEqual({ state: 'ready' });
        expect(await anthropic({ fetch }).detect()).toEqual({ state: 'needs-key' });
    });

    it('asks for structured output with a JSON schema', async () => {
        const { fetch, requests } = mockFetch(...api([start(), blockStart(0, { type: 'text', text: '' }), blockDelta(0, { type: 'text_delta', text: '{}' }), blockStop(0), ...end('end_turn')]));
        await collect(
            anthropic({ apiKey: KEY, fetch, maxRetries: 0 }).chat({
                model: MODEL,
                messages: [{ role: 'user', content: 'card' }],
                json: { schema: { type: 'object', properties: {}, additionalProperties: false } },
            }),
        );
        expect(requests.find((r) => r.url.includes('/v1/messages'))!.body).toMatchObject({
            output_config: { format: { type: 'json_schema', schema: { type: 'object' } } },
        });
    });
});
