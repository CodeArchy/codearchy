import { describe, expect, it } from 'vitest';
import { collect, ollama } from '../src/index.js';
import { mockFetch, split } from './helpers.js';

const BASE = 'http://localhost:11434';
const show = (url: string) =>
    url === `${BASE}/api/show`
        ? {
              json: {
                  capabilities: ['completion', 'tools', 'thinking'],
                  model_info: { 'qwen3.context_length': 40960, 'general.architecture': 'qwen3' },
              },
          }
        : undefined;
const ndjson = (...objs: unknown[]) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n';

describe('ollama', () => {
    it('detects a running server, and reports an unreachable one', async () => {
        const up = mockFetch((url) => (url.endsWith('/api/version') ? { json: { version: '0.40.1' } } : undefined));
        expect(await ollama({ fetch: up.fetch }).detect()).toEqual({ state: 'ready', detail: 'Ollama 0.40.1' });
        const down = mockFetch();
        expect((await ollama({ fetch: down.fetch }).detect()).state).toBe('unreachable');
    });

    it('lists models with capabilities and the context it will run them with', async () => {
        const { fetch } = mockFetch(
            (url) => (url.endsWith('/api/tags') ? { json: { models: [{ name: 'qwen3:8b', model: 'qwen3:8b' }] } } : undefined),
            show,
        );
        const [model] = await ollama({ fetch, numCtx: 16384 }).listModels();
        expect(model).toMatchObject({
            id: 'qwen3:8b',
            contextWindow: 16384,
            supports: { tools: true, vision: false },
            locality: 'on-device',
        });
    });

    it('streams text and usage, sending num_ctx, think:false, the system prompt and tools', async () => {
        const body = ndjson(
            { message: { role: 'assistant', content: 'Hel' }, done: false },
            { message: { role: 'assistant', content: 'lo' }, done: false },
            { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 2 },
        );
        const { fetch, requests } = mockFetch(show, (url) => (url.endsWith('/api/chat') ? { chunks: split(body, 5) } : undefined));
        const events = await collect(
            ollama({ fetch }).chat({
                model: 'qwen3:8b',
                system: 'Be brief.',
                messages: [{ role: 'user', content: 'hi' }],
                tools: [{ name: 'search', description: 'Search', parameters: { type: 'object', properties: {} } }],
                temperature: 0.2,
            }),
        );
        expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('Hello');
        expect(events.at(-2)).toEqual({ type: 'usage', usage: { inputTokens: 12, outputTokens: 2 } });
        expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end', turn: { content: 'Hello', toolCalls: [] } });
        const sent = requests.find((r) => r.url.endsWith('/api/chat'))!.body as Record<string, unknown>;
        expect(sent).toMatchObject({
            model: 'qwen3:8b',
            stream: true,
            think: false,
            options: { num_ctx: 8192, temperature: 0.2 },
            messages: [
                { role: 'system', content: 'Be brief.' },
                { role: 'user', content: 'hi' },
            ],
            tools: [{ type: 'function', function: { name: 'search' } }],
        });
    });

    it('returns tool calls and sends tool results back in Ollama form', async () => {
        const body = ndjson(
            { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'search', arguments: { q: 'auth' } } }] }, done: false },
            { message: { content: '' }, done: true, done_reason: 'stop' },
        );
        const { fetch, requests } = mockFetch(show, (url) => (url.endsWith('/api/chat') ? { chunks: [body] } : undefined));
        const adapter = ollama({ fetch });
        const events = await collect(adapter.chat({ model: 'qwen3:8b', messages: [{ role: 'user', content: 'find auth' }] }));
        const done = events.at(-1);
        expect(done).toMatchObject({ type: 'done', stopReason: 'tool_use' });
        const call = (done as { turn: { toolCalls: Array<{ id: string }> } }).turn.toolCalls[0]!;
        expect(call).toEqual({ id: 'call_1', name: 'search', args: { q: 'auth' } });

        await collect(
            adapter.chat({
                model: 'qwen3:8b',
                messages: [
                    { role: 'user', content: 'find auth' },
                    { role: 'assistant', content: '', toolCalls: [call as never] },
                    { role: 'tool', toolCallId: call.id, name: 'search', content: 'src/auth.ts' },
                ],
            }),
        );
        expect((requests.at(-1)!.body as { messages: unknown[] }).messages.slice(1)).toEqual([
            { role: 'assistant', content: '', tool_calls: [{ function: { name: 'search', arguments: { q: 'auth' } } }] },
            { role: 'tool', tool_name: 'search', content: 'src/auth.ts' },
        ]);
    });

    it('surfaces HTTP and in-stream errors as an error event', async () => {
        const missing = mockFetch(show, (url) =>
            url.endsWith('/api/chat') ? { status: 404, json: { error: 'model "nope" not found' } } : undefined,
        );
        const [e1] = await collect(ollama({ fetch: missing.fetch }).chat({ model: 'nope', messages: [] }));
        expect(e1).toMatchObject({ type: 'error', error: { code: 'bad_request', message: 'model "nope" not found' } });

        const broken = mockFetch(show, (url) =>
            url.endsWith('/api/chat') ? { chunks: [ndjson({ message: { content: 'x' } }, { error: 'out of memory' })] } : undefined,
        );
        const events = await collect(ollama({ fetch: broken.fetch }).chat({ model: 'qwen3:8b', messages: [] }));
        expect(events.at(-1)).toMatchObject({ type: 'error', error: { message: 'out of memory' } });
    });

    it('reports cancellation', async () => {
        const controller = new AbortController();
        controller.abort();
        const { fetch } = mockFetch(show);
        const [event] = await collect(ollama({ fetch }).chat({ model: 'qwen3:8b', messages: [] }, controller.signal));
        expect(event).toMatchObject({ type: 'error', error: { code: 'cancelled' } });
    });

    it('manages models: what is installed (with sizes), a download with progress across layers, a removal', async () => {
        const tags = { models: [{ name: 'gemma3:4b', model: 'gemma3:4b', size: 3_338_801_804, modified_at: '2026-11-01T10:00:00Z', details: { family: 'gemma3', parameter_size: '4.3B', quantization_level: 'Q4_K_M' } }] };
        const pull = ndjson(
            { status: 'pulling manifest' },
            { status: 'downloading', digest: 'sha256:a', total: 100, completed: 40 },
            { status: 'downloading', digest: 'sha256:b', total: 300, completed: 0 },
            { status: 'downloading', digest: 'sha256:b', total: 300, completed: 300 },
            { status: 'downloading', digest: 'sha256:a', total: 100, completed: 100 },
            { status: 'success' },
        );
        const { fetch, requests } = mockFetch(
            (url) => (url.endsWith('/api/tags') ? { json: tags } : undefined),
            (url) => (url.endsWith('/api/pull') ? { chunks: split(pull, 7) } : undefined),
            (url) => (url.endsWith('/api/delete') ? { json: {} } : undefined),
        );
        const manage = ollama({ fetch }).manage!;
        expect(await manage.installed()).toEqual([{ id: 'gemma3:4b', size: 3_338_801_804, family: 'gemma3', parameterSize: '4.3B', quantization: 'Q4_K_M', modifiedAt: '2026-11-01T10:00:00Z' }]);
        const seen: string[] = [];
        await manage.pull('qwen3:8b', (p) => seen.push(`${p.status}${p.total ? ` ${p.completed}/${p.total}` : ''}`));
        expect(seen).toEqual(['pulling manifest', 'downloading 40/100', 'downloading 40/400', 'downloading 340/400', 'downloading 400/400', 'success 400/400']);
        expect(requests.find((r) => r.url.endsWith('/api/pull'))!.body).toEqual({ model: 'qwen3:8b', stream: true });
        await manage.remove('gemma3:4b');
        const del = requests.find((r) => r.url.endsWith('/api/delete'))!;
        expect(del.method).toBe('DELETE');
        expect(del.body).toEqual({ model: 'gemma3:4b' });
    });

    it('a failed download reports Ollama\'s reason', async () => {
        const { fetch } = mockFetch((url) => (url.endsWith('/api/pull') ? { chunks: [ndjson({ status: 'pulling manifest' }, { error: 'pull model manifest: file does not exist' })] } : undefined));
        await expect(ollama({ fetch }).manage!.pull('nope:1b', () => undefined)).rejects.toThrow(/file does not exist/);
    });
});

