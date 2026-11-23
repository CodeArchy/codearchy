/**
 * Google Gemini (AI Studio / Generative Language API) with an API key.
 * Streams `streamGenerateContent?alt=sse`. The model's own parts are replayed on
 * the next turn: Gemini attaches thought signatures to function-call parts and
 * rejects a follow-up that drops them.
 */
import { ProviderError } from '../errors.js';
import { defaultFetch, joinUrl, parseArgs, parseJson, send, sendJson, sse, type Endpoint, type FetchLike } from '../http.js';
import { guarded } from '../stream.js';
import type { ChatEvent, ChatMessage, ChatRequest, ModelInfo, ProviderAdapter, SignalLike, StopReason, ToolCall } from '../types.js';

export interface GeminiOptions {
    apiKey?: string;
    /** Default https://generativelanguage.googleapis.com/v1beta */
    baseUrl?: string;
    fetch?: FetchLike;
}

type Part = {
    text?: string;
    thought?: boolean;
    thoughtSignature?: string;
    functionCall?: { id?: string; name: string; args?: unknown };
    functionResponse?: { id?: string; name: string; response: unknown };
};
interface Content {
    role: 'user' | 'model';
    parts: Part[];
}
interface Chunk {
    candidates?: Array<{ content?: { parts?: Part[] }; finishReason?: string }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number };
    promptFeedback?: { blockReason?: string };
    error?: { message?: string; status?: string };
}

const ID = 'gemini';
const REFUSALS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);

export function gemini(options: GeminiOptions = {}): ProviderAdapter {
    const base = options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    const endpoint: Endpoint = { provider: ID, fetch: options.fetch ?? defaultFetch(), secrets: [options.apiKey] };
    const headers = (): Record<string, string> => ({
        'content-type': 'application/json',
        ...(options.apiKey ? { 'x-goog-api-key': options.apiKey } : {}),
    });

    async function listPage(pageToken: string | undefined, signal?: SignalLike) {
        const query = `models?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
        return sendJson<{
            models?: Array<{
                name: string;
                displayName?: string;
                inputTokenLimit?: number;
                outputTokenLimit?: number;
                supportedGenerationMethods?: string[];
            }>;
            nextPageToken?: string;
        }>(endpoint, joinUrl(base, query), { headers: headers(), signal });
    }

    return {
        id: ID,
        label: 'Google Gemini',
        kind: 'api-key',

        async detect(signal) {
            if (!options.apiKey) return { state: 'needs-key' };
            try {
                await listPage(undefined, signal);
                return { state: 'ready' };
            } catch (err) {
                const e = err instanceof ProviderError ? err : undefined;
                if (e?.code === 'auth') return { state: 'unauthorized', detail: 'Gemini rejected the key' };
                if (e?.code === 'unavailable') return { state: 'unreachable', detail: "Gemini isn't answering" };
                return { state: 'error', detail: e?.message };
            }
        },

        async listModels(signal) {
            const out: ModelInfo[] = [];
            let token: string | undefined;
            do {
                const page = await listPage(token, signal);
                for (const m of page.models ?? []) {
                    const methods = m.supportedGenerationMethods ?? [];
                    const chat = methods.includes('generateContent');
                    const embeds = methods.includes('embedContent');
                    if (!chat && !embeds) continue;
                    out.push({
                        id: m.name.replace(/^models\//, ''),
                        label: m.displayName ?? m.name,
                        provider: ID,
                        contextWindow: m.inputTokenLimit,
                        maxOutput: m.outputTokenLimit,
                        supports: { embeddings: embeds, tools: chat ? undefined : false },
                        locality: 'cloud',
                    });
                }
                token = page.nextPageToken;
            } while (token);
            return out;
        },

        chat(request, signal) {
            return guarded(ID, signal, () => run(request, signal));
        },
    };

    async function* run(request: ChatRequest, signal?: SignalLike): AsyncGenerator<ChatEvent> {
        if (!options.apiKey) throw new ProviderError('auth', ID, 'No API key for Gemini');
        const body: Record<string, unknown> = { contents: toContents(request.messages) };
        if (request.system) body.systemInstruction = { parts: [{ text: request.system }] };
        if (request.tools?.length) {
            body.tools = [
                {
                    functionDeclarations: request.tools.map((t) => ({
                        name: t.name,
                        description: t.description,
                        parametersJsonSchema: t.parameters,
                    })),
                },
            ];
            body.toolConfig = { functionCallingConfig: { mode: request.toolChoice === 'none' ? 'NONE' : 'AUTO' } };
        }
        const generation: Record<string, unknown> = {};
        if (request.maxOutputTokens) generation.maxOutputTokens = request.maxOutputTokens;
        if (request.temperature !== undefined) generation.temperature = request.temperature;
        if (request.json) {
            generation.responseMimeType = 'application/json';
            if (request.json.schema) generation.responseJsonSchema = request.json.schema;
        }
        if (Object.keys(generation).length) body.generationConfig = generation;

        const model = encodeURIComponent(request.model.replace(/^models\//, ''));
        const res = await send(endpoint, joinUrl(base, `models/${model}:streamGenerateContent?alt=sse`), {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify(body),
            signal,
        });
        if (!res.body) throw new ProviderError('invalid_response', ID, 'Gemini sent no response body');

        let content = '';
        const parts: Part[] = [];
        const toolCalls: ToolCall[] = [];
        let finish: string | undefined;
        let blocked = false;
        let usage: Chunk['usageMetadata'];
        for await (const event of sse(res.body, signal)) {
            const chunk = parseJson(ID, event.data) as Chunk;
            if (chunk.error) throw new ProviderError('unavailable', ID, chunk.error.message ?? 'Stream error');
            if (chunk.promptFeedback?.blockReason) blocked = true;
            if (chunk.usageMetadata) usage = chunk.usageMetadata;
            const candidate = chunk.candidates?.[0];
            if (candidate?.finishReason) finish = candidate.finishReason;
            for (const part of candidate?.content?.parts ?? []) {
                parts.push(part);
                if (part.thought) continue; // thought summaries are not answer text
                if (part.text) {
                    content += part.text;
                    yield { type: 'text', delta: part.text };
                }
                if (part.functionCall?.name) {
                    const call: ToolCall = {
                        id: part.functionCall.id ?? `call_${toolCalls.length + 1}`,
                        name: part.functionCall.name,
                        args: parseArgs(ID, part.functionCall.args ?? {}),
                    };
                    toolCalls.push(call);
                    yield { type: 'tool_call', call };
                }
            }
        }
        if (usage) {
            yield {
                type: 'usage',
                usage: {
                    inputTokens: usage.promptTokenCount ?? 0,
                    outputTokens: usage.candidatesTokenCount ?? 0,
                    cachedInputTokens: usage.cachedContentTokenCount,
                },
            };
        }
        let stop: StopReason;
        if (blocked || (finish && REFUSALS.has(finish))) stop = 'refusal';
        else if (toolCalls.length) stop = 'tool_use';
        else if (finish === 'MAX_TOKENS') stop = 'max_tokens';
        else if (!finish || finish === 'STOP') stop = 'end';
        else stop = 'other';
        yield {
            type: 'done',
            stopReason: stop,
            turn: { content, toolCalls, replay: { provider: ID, model: request.model, data: parts } },
        };
    }
}

/** Gemini wants alternating user/model contents; tool results travel as user function responses. */
function toContents(messages: ChatMessage[]): Content[] {
    const out: Content[] = [];
    /** Call ids Gemini issued itself (ids we made up for id-less calls must not be sent back). */
    const issued = new Set<string>();
    const push = (role: Content['role'], parts: Part[]) => {
        const last = out[out.length - 1];
        if (last && last.role === role) last.parts.push(...parts);
        else out.push({ role, parts });
    };
    for (const m of messages) {
        if (m.role === 'user') push('user', [{ text: m.content }]);
        else if (m.role === 'tool') {
            push('user', [
                {
                    functionResponse: {
                        ...(issued.has(m.toolCallId) ? { id: m.toolCallId } : {}),
                        name: m.name,
                        response: m.isError ? { error: m.content } : { content: m.content },
                    },
                },
            ]);
        } else if (m.replay?.provider === ID && Array.isArray(m.replay.data)) {
            const parts = m.replay.data as Part[];
            for (const p of parts) if (p.functionCall?.id) issued.add(p.functionCall.id);
            push('model', parts);
        } else {
            const parts: Part[] = [];
            if (m.content) parts.push({ text: m.content });
            for (const c of m.toolCalls ?? []) parts.push({ functionCall: { name: c.name, args: c.args } });
            push('model', parts.length ? parts : [{ text: '' }]);
        }
    }
    return out;
}
