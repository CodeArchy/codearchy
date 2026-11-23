import { describe, expect, it } from 'vitest';
import { collect, lmStudio, mistral, openai, openrouter } from '../src/index.js';
import { mockFetch, split, sseOf } from './helpers.js';

const KEY = 'sk-test-abcdef123456';
const delta = (d: unknown, finish: string | null = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

describe('openai-compatible', () => {
    it('streams text and usage with the right headers and fields (OpenAI preset)', async () => {
        const stream = sseOf(
            [
                delta({ role: 'assistant', content: 'Hi' }),
                delta({ content: ' there' }),
                delta({}, 'stop'),
                { choices: [], usage: { prompt_tokens: 9, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } },
            ],
            true,
        );
        const { fetch, requests } = mockFetch((url) => (url.endsWith('/chat/completions') ? { chunks: split(stream, 7) } : undefined));
        const events = await collect(
            openai({ apiKey: KEY, fetch }).chat({
                model: 'gpt-x',
                system: 'S',
                messages: [{ role: 'user', content: 'hello' }],
                maxOutputTokens: 100,
            }),
        );
        expect(events).toEqual([
            { type: 'text', delta: 'Hi' },
            { type: 'text', delta: ' there' },
            { type: 'usage', usage: { inputTokens: 9, outputTokens: 2, cachedInputTokens: 4 } },
            { type: 'done', stopReason: 'end', turn: { content: 'Hi there', toolCalls: [] } },
        ]);
        const req = requests[0]!;
        expect(req.url).toBe('https://api.openai.com/v1/chat/completions');
        expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
        expect(req.body).toEqual({
            model: 'gpt-x',
            stream: true,
            stream_options: { include_usage: true },
            max_completion_tokens: 100,
            messages: [
                { role: 'system', content: 'S' },
                { role: 'user', content: 'hello' },
            ],
        });
    });

    it('assembles tool calls from fragments and round-trips them', async () => {
        const stream = sseOf(
            [
                delta({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'search', arguments: '{"q":' } }] }),
                delta({ tool_calls: [{ index: 0, function: { arguments: '"auth"}' } }] }),
                delta({ tool_calls: [{ index: 1, id: 'call_b', function: { name: 'get_node', arguments: '{"id":"pkg:api"}' } }] }),
                delta({}, 'tool_calls'),
            ],
            true,
        );
        const { fetch, requests } = mockFetch((url) => (url.endsWith('/chat/completions') ? { chunks: [stream] } : undefined));
        const adapter = openrouter({ apiKey: KEY, fetch });
        const events = await collect(
            adapter.chat({
                model: 'm',
                messages: [{ role: 'user', content: 'q' }],
                tools: [{ name: 'search', description: 'd', parameters: { type: 'object' } }],
            }),
        );
        const done = events.at(-1) as { stopReason: string; turn: { toolCalls: unknown[] } };
        expect(done.stopReason).toBe('tool_use');
        expect(done.turn.toolCalls).toEqual([
            { id: 'call_a', name: 'search', args: { q: 'auth' } },
            { id: 'call_b', name: 'get_node', args: { id: 'pkg:api' } },
        ]);
        expect(requests[0]!.body).toMatchObject({ tool_choice: 'auto', tools: [{ type: 'function', function: { name: 'search' } }] });

        await collect(
            adapter.chat({
                model: 'm',
                messages: [
                    { role: 'assistant', content: '', toolCalls: done.turn.toolCalls as never },
                    { role: 'tool', toolCallId: 'call_a', name: 'search', content: 'r1' },
                ],
            }),
        );
        expect((requests[1]!.body as { messages: unknown[] }).messages).toEqual([
            {
                role: 'assistant',
                content: null,
                tool_calls: [
                    { id: 'call_a', type: 'function', function: { name: 'search', arguments: '{"q":"auth"}' } },
                    { id: 'call_b', type: 'function', function: { name: 'get_node', arguments: '{"id":"pkg:api"}' } },
                ],
            },
            { role: 'tool', tool_call_id: 'call_a', content: 'r1' },
        ]);
    });

    it('drops tool calls from a turn cut off at the token limit', async () => {
        const stream = sseOf(
            [delta({ tool_calls: [{ index: 0, id: 'c', function: { name: 'search', arguments: '{"q":"au' } }] }), delta({}, 'length')],
            true,
        );
        const { fetch } = mockFetch(() => ({ chunks: [stream] }));
        const events = await collect(openai({ apiKey: KEY, fetch }).chat({ model: 'm', messages: [] }));
        expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'max_tokens', turn: { toolCalls: [] } });
    });

    it('maps errors and keeps the key out of messages', async () => {
        const cases: Array<[number, unknown, Record<string, string>, string]> = [
            [401, { error: { message: `Incorrect API key provided: ${KEY}` } }, {}, 'auth'],
            [429, { error: { message: 'Rate limit' } }, { 'retry-after': '2' }, 'rate_limit'],
            [429, { error: { code: 'insufficient_quota', message: 'quota' } }, {}, 'quota'],
            [400, { error: { code: 'context_length_exceeded', message: 'too long' } }, {}, 'context_overflow'],
            [502, { error: { message: 'bad gateway' } }, {}, 'unavailable'],
        ];
        for (const [status, json, headers, code] of cases) {
            const { fetch } = mockFetch(() => ({ status, json, headers }));
            const [event] = await collect(openai({ apiKey: KEY, fetch }).chat({ model: 'm', messages: [] }));
            expect(event).toMatchObject({ type: 'error', error: { code, status } });
            expect((event as { error: Error }).error.message).not.toContain(KEY);
            if (status === 429 && code === 'rate_limit') expect((event as { error: { retryAfterMs: number } }).error.retryAfterMs).toBe(2000);
        }
    });

    it('needs a key for hosted services but not for local servers', async () => {
        const { fetch } = mockFetch((url) => (url.endsWith('/models') ? { json: { data: [{ id: 'local-model' }] } } : undefined));
        expect(await openai({ fetch }).detect()).toEqual({ state: 'needs-key' });
        expect(await lmStudio({ fetch }).detect()).toEqual({ state: 'ready', detail: '1 models' });
        const [event] = await collect(openai({ fetch }).chat({ model: 'm', messages: [] }));
        expect(event).toMatchObject({ type: 'error', error: { code: 'auth' } });
    });

    it('reads context windows and tool support from the models list where the service reports them', async () => {
        const { fetch } = mockFetch(() => ({
            json: {
                data: [
                    {
                        id: 'vendor/model',
                        name: 'Vendor Model',
                        context_length: 200000,
                        top_provider: { max_completion_tokens: 8192 },
                        supported_parameters: ['tools', 'response_format'],
                        architecture: { input_modalities: ['text', 'image'] },
                    },
                ],
            },
        }));
        expect(await openrouter({ apiKey: KEY, fetch }).listModels()).toEqual([
            {
                id: 'vendor/model',
                label: 'Vendor Model',
                provider: 'openrouter',
                contextWindow: 200000,
                maxOutput: 8192,
                supports: { tools: true, jsonSchema: true, vision: true },
                locality: 'cloud',
            },
        ]);
    });

    it('asks for JSON output in the OpenAI form, and leaves stream_options out for Mistral', async () => {
        const { fetch, requests } = mockFetch(() => ({ chunks: [sseOf([delta({ content: '{}' }, 'stop')], true)] }));
        await collect(
            mistral({ apiKey: KEY, fetch }).chat({ model: 'm', messages: [], json: { schema: { type: 'object' }, name: 'card' } }),
        );
        expect(requests[0]!.url).toBe('https://api.mistral.ai/v1/chat/completions');
        expect(requests[0]!.body).toMatchObject({
            response_format: { type: 'json_schema', json_schema: { name: 'card', schema: { type: 'object' } } },
        });
        expect(requests[0]!.body).not.toHaveProperty('stream_options');
    });
});
