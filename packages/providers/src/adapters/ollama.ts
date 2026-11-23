/**
 * Ollama (local models). Uses the native API: /api/chat streams NDJSON,
 * /api/tags lists models, /api/show reports capabilities and context length.
 *
 * From a web page, Ollama only answers origins listed in OLLAMA_ORIGINS; a
 * blocked origin looks like a network failure to the page, so `detect()`
 * reports it as `unreachable` and the host explains the setup.
 */
import { ProviderError } from '../errors.js';
import { defaultFetch, joinUrl, ndjson, parseArgs, send, sendJson, type Endpoint, type FetchLike } from '../http.js';
import { guarded } from '../stream.js';
import type {
    AssistantTurn,
    ChatEvent,
    ChatMessage,
    ChatRequest,
    EmbedRequest,
    ModelInfo,
    ProviderAdapter,
    ProviderStatus,
    SignalLike,
    StopReason,
    ToolCall,
} from '../types.js';

export interface OllamaOptions {
    /** Default http://localhost:11434 */
    baseUrl?: string;
    /**
     * Context size to run models with (Ollama's `num_ctx`), capped at each
     * model's own maximum. Ollama's default is small; larger costs memory.
     * Default 8192.
     */
    numCtx?: number;
    fetch?: FetchLike;
}

interface OllamaShow {
    capabilities?: string[];
    model_info?: Record<string, unknown>;
}

interface OllamaChunk {
    message?: { content?: string; thinking?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> };
    done?: boolean;
    done_reason?: string;
    prompt_eval_count?: number;
    eval_count?: number;
    error?: string;
}

const ID = 'ollama';

export function ollama(options: OllamaOptions = {}): ProviderAdapter {
    const base = options.baseUrl ?? 'http://localhost:11434';
    const numCtx = options.numCtx ?? 8192;
    const endpoint: Endpoint = { provider: ID, fetch: options.fetch ?? defaultFetch(), secrets: [] };
    /** What /api/show told us, per model: capabilities and the context we'll run it with. */
    const known = new Map<string, { capabilities: Set<string>; contextWindow?: number }>();

    const url = (path: string) => joinUrl(base, path);
    const post = (body: unknown, signal?: SignalLike) => ({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    });

    async function show(model: string, signal?: SignalLike) {
        const cached = known.get(model);
        if (cached) return cached;
        const info = await sendJson<OllamaShow>(endpoint, url('/api/show'), post({ model }, signal));
        const lengthKey = Object.keys(info.model_info ?? {}).find((k) => k.endsWith('.context_length'));
        const max = lengthKey ? Number(info.model_info?.[lengthKey]) : undefined;
        const entry = {
            capabilities: new Set(info.capabilities ?? []),
            contextWindow: max && Number.isFinite(max) ? Math.min(max, numCtx) : numCtx,
        };
        known.set(model, entry);
        return entry;
    }

    return {
        id: ID,
        label: 'Ollama',
        kind: 'local',

        async detect(signal) {
            try {
                const v = await sendJson<{ version?: string }>(endpoint, url('/api/version'), { signal });
                return { state: 'ready', detail: v.version ? `Ollama ${v.version}` : undefined } satisfies ProviderStatus;
            } catch (err) {
                const e = err instanceof ProviderError ? err : undefined;
                if (e?.code === 'auth') return { state: 'unauthorized', detail: 'Ollama refused this origin (check OLLAMA_ORIGINS)' };
                return { state: 'unreachable', detail: `Ollama isn't answering at ${base}` };
            }
        },

        async listModels(signal) {
            const tags = await sendJson<{ models?: Array<{ name: string; model?: string }> }>(endpoint, url('/api/tags'), {
                signal,
            });
            const names = (tags.models ?? []).map((m) => m.model ?? m.name);
            const out: ModelInfo[] = [];
            // /api/show per model, a few at a time.
            for (let i = 0; i < names.length; i += 4) {
                const batch = names.slice(i, i + 4);
                const infos = await Promise.all(batch.map((n) => show(n, signal).catch(() => undefined)));
                batch.forEach((name, j) => {
                    const info = infos[j];
                    const caps = info?.capabilities;
                    out.push({
                        id: name,
                        label: name,
                        provider: ID,
                        contextWindow: info?.contextWindow,
                        supports: {
                            tools: caps ? caps.has('tools') : undefined,
                            vision: caps ? caps.has('vision') : undefined,
                            embeddings: caps ? caps.has('embedding') : undefined,
                            jsonSchema: caps ? caps.has('completion') : undefined,
                        },
                        locality: 'on-device',
                    });
                });
            }
            return out;
        },

        chat(request, signal) {
            return guarded(ID, signal, () => run(request, signal));
        },

        async embed(request: EmbedRequest, signal?: SignalLike) {
            const res = await sendJson<{ embeddings?: number[][] }>(
                endpoint,
                url('/api/embed'),
                post({ model: request.model, input: request.input }, signal),
            );
            if (!Array.isArray(res.embeddings) || res.embeddings.length !== request.input.length) {
                throw new ProviderError('invalid_response', ID, 'Ollama returned the wrong number of embeddings');
            }
            return res.embeddings;
        },
    };

    async function* run(request: ChatRequest, signal?: SignalLike): AsyncGenerator<ChatEvent> {
        const info = await show(request.model, signal).catch(() => undefined);
        const body: Record<string, unknown> = {
            model: request.model,
            messages: toOllamaMessages(request),
            stream: true,
            options: {
                num_ctx: info?.contextWindow ?? numCtx,
                ...(request.maxOutputTokens ? { num_predict: request.maxOutputTokens } : {}),
                ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            },
        };
        if (request.tools?.length && request.toolChoice !== 'none') {
            body.tools = request.tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.parameters },
            }));
        }
        if (request.json) body.format = request.json.schema ?? 'json';
        // Thinking models: answer directly (only sent where the model supports it; others reject the flag).
        if (info?.capabilities.has('thinking')) body.think = false;

        const res = await send(endpoint, url('/api/chat'), post(body, signal));
        if (!res.body) throw new ProviderError('invalid_response', ID, 'Ollama sent no response body');

        let content = '';
        const toolCalls: ToolCall[] = [];
        let stop: StopReason = 'other';
        for await (const raw of ndjson(ID, res.body, signal)) {
            const chunk = raw as OllamaChunk;
            if (chunk.error) throw new ProviderError('bad_request', ID, chunk.error);
            const delta = chunk.message?.content;
            if (delta) {
                content += delta;
                yield { type: 'text', delta };
            }
            for (const call of chunk.message?.tool_calls ?? []) {
                const name = call.function?.name;
                if (!name) continue;
                const tc: ToolCall = { id: `call_${toolCalls.length + 1}`, name, args: parseArgs(ID, call.function?.arguments) };
                toolCalls.push(tc);
                yield { type: 'tool_call', call: tc };
            }
            if (chunk.done) {
                yield {
                    type: 'usage',
                    usage: { inputTokens: chunk.prompt_eval_count ?? 0, outputTokens: chunk.eval_count ?? 0 },
                };
                stop = toolCalls.length ? 'tool_use' : chunk.done_reason === 'length' ? 'max_tokens' : 'end';
                break;
            }
        }
        const turn: AssistantTurn = { content, toolCalls };
        yield { type: 'done', stopReason: stop, turn };
    }
}

function toOllamaMessages(request: ChatRequest): unknown[] {
    const out: unknown[] = [];
    if (request.system) out.push({ role: 'system', content: request.system });
    for (const m of request.messages) out.push(toOllamaMessage(m));
    return out;
}

function toOllamaMessage(m: ChatMessage): unknown {
    switch (m.role) {
        case 'user':
            return { role: 'user', content: m.content };
        case 'assistant':
            return {
                role: 'assistant',
                content: m.content,
                ...(m.toolCalls?.length
                    ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args } })) }
                    : {}),
            };
        case 'tool':
            return { role: 'tool', tool_name: m.name, content: m.content };
    }
}
