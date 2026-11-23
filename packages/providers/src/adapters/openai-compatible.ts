/**
 * The OpenAI Chat Completions wire format, which OpenAI, OpenRouter, Groq,
 * Mistral, LM Studio, llama.cpp, vLLM and most gateways speak. Presets fill in
 * each service's base URL and the quirks that differ between them.
 */
import { ProviderError } from '../errors.js';
import { defaultFetch, joinUrl, parseArgs, parseJson, send, sendJson, sse, type Endpoint, type FetchLike } from '../http.js';
import { guarded } from '../stream.js';
import type {
    ChatEvent,
    ChatMessage,
    ChatRequest,
    EmbedRequest,
    ModelInfo,
    ProviderAdapter,
    ProviderKind,
    SignalLike,
    StopReason,
    ToolCall,
} from '../types.js';

export interface OpenAICompatibleOptions {
    /** Adapter id, e.g. 'openai', 'openrouter', 'lmstudio', or a custom name. */
    id: string;
    label: string;
    baseUrl: string;
    apiKey?: string;
    /** 'api-key' for hosted services, 'local' for servers on this machine. */
    kind?: ProviderKind;
    /** Needs a key to work at all (hosted services do; local servers usually don't). */
    requiresKey?: boolean;
    /** OpenAI's current models take `max_completion_tokens`; most compatible servers take `max_tokens`. */
    maxTokensField?: 'max_tokens' | 'max_completion_tokens';
    /** Ask for a final usage chunk (`stream_options.include_usage`). Default true. */
    streamUsage?: boolean;
    /** Extra request headers (e.g. OpenRouter's attribution headers). */
    headers?: Record<string, string>;
    fetch?: FetchLike;
}

interface ModelEntry {
    id: string;
    name?: string;
    context_length?: number; // OpenRouter
    context_window?: number; // Groq
    max_context_length?: number; // Mistral
    top_provider?: { max_completion_tokens?: number | null }; // OpenRouter
    supported_parameters?: string[]; // OpenRouter
    capabilities?: { function_calling?: boolean; vision?: boolean }; // Mistral
    architecture?: { input_modalities?: string[] }; // OpenRouter
}

interface Chunk {
    choices?: Array<{
        delta?: {
            content?: string | null;
            tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
        };
        finish_reason?: string | null;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
    error?: { message?: string; code?: string | number };
}

export function openAICompatible(options: OpenAICompatibleOptions): ProviderAdapter {
    const id = options.id;
    const endpoint: Endpoint = { provider: id, fetch: options.fetch ?? defaultFetch(), secrets: [options.apiKey] };
    const kind = options.kind ?? 'api-key';
    const requiresKey = options.requiresKey ?? kind === 'api-key';
    const maxTokensField = options.maxTokensField ?? 'max_tokens';
    const streamUsage = options.streamUsage ?? true;

    const headers = (): Record<string, string> => ({
        'content-type': 'application/json',
        ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
        ...options.headers,
    });
    const url = (path: string) => joinUrl(options.baseUrl, path);

    async function models(signal?: SignalLike): Promise<ModelEntry[]> {
        const res = await sendJson<{ data?: ModelEntry[] }>(endpoint, url('/models'), { headers: headers(), signal });
        return res.data ?? [];
    }

    return {
        id,
        label: options.label,
        kind,

        async detect(signal) {
            if (requiresKey && !options.apiKey) return { state: 'needs-key' };
            try {
                const list = await models(signal);
                return { state: 'ready', detail: `${list.length} models` };
            } catch (err) {
                const e = err instanceof ProviderError ? err : undefined;
                if (e?.code === 'auth') return { state: 'unauthorized', detail: `${options.label} rejected the key` };
                if (e?.code === 'unavailable' || e?.code === 'cancelled') {
                    return { state: 'unreachable', detail: `${options.label} isn't answering at ${options.baseUrl}` };
                }
                return { state: 'error', detail: e?.message };
            }
        },

        async listModels(signal) {
            return (await models(signal)).map((m): ModelInfo => {
                const params = m.supported_parameters;
                return {
                    id: m.id,
                    label: m.name ?? m.id,
                    provider: id,
                    contextWindow: m.context_length ?? m.context_window ?? m.max_context_length,
                    maxOutput: m.top_provider?.max_completion_tokens ?? undefined,
                    supports: {
                        tools: params ? params.includes('tools') : m.capabilities?.function_calling,
                        jsonSchema: params ? params.includes('structured_outputs') || params.includes('response_format') : undefined,
                        vision: m.architecture?.input_modalities
                            ? m.architecture.input_modalities.includes('image')
                            : m.capabilities?.vision,
                    },
                    locality: kind === 'local' ? 'on-device' : 'cloud',
                };
            });
        },

        chat(request, signal) {
            return guarded(id, signal, () => run(request, signal));
        },

        async embed(request: EmbedRequest, signal?: SignalLike) {
            const res = await sendJson<{ data?: Array<{ index: number; embedding: number[] }> }>(endpoint, url('/embeddings'), {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify({ model: request.model, input: request.input }),
                signal,
            });
            const data = [...(res.data ?? [])].sort((a, b) => a.index - b.index);
            if (data.length !== request.input.length) {
                throw new ProviderError('invalid_response', id, `${options.label} returned the wrong number of embeddings`);
            }
            return data.map((d) => d.embedding);
        },
    };

    async function* run(request: ChatRequest, signal?: SignalLike): AsyncGenerator<ChatEvent> {
        if (requiresKey && !options.apiKey) throw new ProviderError('auth', id, `No API key for ${options.label}`);
        const body: Record<string, unknown> = {
            model: request.model,
            messages: toMessages(request),
            stream: true,
        };
        if (streamUsage) body.stream_options = { include_usage: true };
        if (request.maxOutputTokens) body[maxTokensField] = request.maxOutputTokens;
        if (request.temperature !== undefined) body.temperature = request.temperature;
        if (request.tools?.length) {
            body.tools = request.tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.parameters },
            }));
            body.tool_choice = request.toolChoice ?? 'auto';
        }
        if (request.json) {
            body.response_format = request.json.schema
                ? { type: 'json_schema', json_schema: { name: request.json.name ?? 'output', schema: request.json.schema } }
                : { type: 'json_object' };
        }

        const res = await send(endpoint, url('/chat/completions'), {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify(body),
            signal,
        });
        if (!res.body) throw new ProviderError('invalid_response', id, `${options.label} sent no response body`);

        let content = '';
        let finish: string | undefined;
        const partial = new Map<number, { id?: string; name?: string; args: string }>();
        for await (const event of sse(res.body, signal)) {
            if (event.data === '[DONE]') break;
            const chunk = parseJson(id, event.data) as Chunk;
            if (chunk.error) throw new ProviderError('unavailable', id, chunk.error.message ?? 'Stream error');
            for (const choice of chunk.choices ?? []) {
                const delta = choice.delta;
                if (delta?.content) {
                    content += delta.content;
                    yield { type: 'text', delta: delta.content };
                }
                for (const tc of delta?.tool_calls ?? []) {
                    const index = tc.index ?? 0;
                    const slot = partial.get(index) ?? { args: '' };
                    if (tc.id) slot.id = tc.id;
                    if (tc.function?.name) slot.name = (slot.name ?? '') + tc.function.name;
                    if (tc.function?.arguments) slot.args += tc.function.arguments;
                    partial.set(index, slot);
                }
                if (choice.finish_reason) finish = choice.finish_reason;
            }
            if (chunk.usage) {
                yield {
                    type: 'usage',
                    usage: {
                        inputTokens: chunk.usage.prompt_tokens ?? 0,
                        outputTokens: chunk.usage.completion_tokens ?? 0,
                        cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens,
                    },
                };
            }
        }

        const toolCalls: ToolCall[] = [];
        // A cut-off stream (finish_reason 'length') can leave arguments truncated: don't hand those out as calls.
        if (finish !== 'length') {
            for (const [index, slot] of [...partial.entries()].sort((a, b) => a[0] - b[0])) {
                if (!slot.name) continue;
                const call: ToolCall = { id: slot.id ?? `call_${index + 1}`, name: slot.name, args: parseArgs(id, slot.args) };
                toolCalls.push(call);
                yield { type: 'tool_call', call };
            }
        }
        yield { type: 'done', stopReason: stopReason(finish, toolCalls.length > 0), turn: { content, toolCalls } };
    }
}

function stopReason(finish: string | undefined, hasTools: boolean): StopReason {
    if (hasTools) return 'tool_use';
    switch (finish) {
        case 'stop':
            return 'end';
        case 'length':
            return 'max_tokens';
        case 'content_filter':
            return 'refusal';
        case 'tool_calls':
            return 'tool_use';
        default:
            return finish ? 'other' : 'end';
    }
}

function toMessages(request: ChatRequest): unknown[] {
    const out: unknown[] = [];
    if (request.system) out.push({ role: 'system', content: request.system });
    for (const m of request.messages) out.push(toMessage(m));
    return out;
}

function toMessage(m: ChatMessage): unknown {
    switch (m.role) {
        case 'user':
            return { role: 'user', content: m.content };
        case 'assistant':
            return m.toolCalls?.length
                ? {
                      role: 'assistant',
                      content: m.content || null,
                      tool_calls: m.toolCalls.map((c) => ({
                          id: c.id,
                          type: 'function',
                          function: { name: c.name, arguments: JSON.stringify(c.args) },
                      })),
                  }
                : { role: 'assistant', content: m.content };
        case 'tool':
            return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
}

// ── Presets ───────────────────────────────────────────────────────────────

type PresetOptions = { apiKey?: string; fetch?: FetchLike; baseUrl?: string };

export const openai = (o: PresetOptions) =>
    openAICompatible({
        ...o,
        id: 'openai',
        label: 'OpenAI',
        baseUrl: o.baseUrl ?? 'https://api.openai.com/v1',
        maxTokensField: 'max_completion_tokens',
    });

export const openrouter = (o: PresetOptions) =>
    openAICompatible({ ...o, id: 'openrouter', label: 'OpenRouter', baseUrl: o.baseUrl ?? 'https://openrouter.ai/api/v1' });

export const groq = (o: PresetOptions) =>
    openAICompatible({ ...o, id: 'groq', label: 'Groq', baseUrl: o.baseUrl ?? 'https://api.groq.com/openai/v1' });

/** Mistral reports usage on the last chunk by itself and doesn't document `stream_options`. */
export const mistral = (o: PresetOptions) =>
    openAICompatible({
        ...o,
        id: 'mistral',
        label: 'Mistral',
        baseUrl: o.baseUrl ?? 'https://api.mistral.ai/v1',
        streamUsage: false,
    });

/** LM Studio's local server (the same shape fits llama.cpp's server on its own port). */
export const lmStudio = (o: Omit<PresetOptions, 'apiKey'> = {}) =>
    openAICompatible({
        id: 'lmstudio',
        label: 'LM Studio',
        baseUrl: o.baseUrl ?? 'http://localhost:1234/v1',
        kind: 'local',
        fetch: o.fetch,
    });
