/**
 * Anthropic (Claude) through the official SDK, behind the neutral interface.
 *
 * - Streams with the beta Messages endpoint so the server-side refusal fallback
 *   (`fallbacks: "default"`) can be requested: on a model without a fallback the
 *   request just runs on that model, so it's safe to always ask.
 * - The finished turn's content blocks (thinking blocks included) are kept as
 *   replay data and sent back unchanged, which tool loops on current models need.
 * - Model limits and capabilities come from the Models API, not a hard-coded list.
 * - Runs in browsers with the user's own key (the PWA calls Anthropic directly).
 */
import Anthropic from '@anthropic-ai/sdk';
import { ProviderError } from '../errors.js';
import type { FetchLike } from '../http.js';
import { redact } from '../http.js';
import type {
    ChatEvent,
    ChatMessage,
    ChatRequest,
    ModelInfo,
    ProviderAdapter,
    SignalLike,
    StopReason,
    ToolCall,
} from '../types.js';

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ContentBlock = Anthropic.Beta.Messages.BetaContentBlock;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;
type StreamParams = Anthropic.Beta.Messages.MessageCreateParamsStreaming;

export interface AnthropicOptions {
    apiKey?: string;
    /** For a gateway or proxy. Leave unset for api.anthropic.com. */
    baseUrl?: string;
    /** Ask for the server-side refusal fallback (beta). Default true; turn off for gateways that reject beta headers. */
    refusalFallback?: boolean;
    /** The SDK's own retries for transient failures. Default 2 (the SDK default). */
    maxRetries?: number;
    fetch?: FetchLike;
}

const ID = 'anthropic';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** Output cap when the caller sets none and the model's own limit is unknown. */
const DEFAULT_MAX_OUTPUT = 16_000;
/** Streaming has no HTTP-timeout concern, so allow long answers when the model does. */
const STREAMING_MAX_OUTPUT = 64_000;

export function anthropic(options: AnthropicOptions = {}): ProviderAdapter {
    const fallback = options.refusalFallback ?? true;
    const limits = new Map<string, number | undefined>();
    let client: Anthropic | undefined;

    const sdk = (): Anthropic => {
        if (!options.apiKey) throw new ProviderError('auth', ID, 'No API key for Anthropic');
        client ??= new Anthropic({
            apiKey: options.apiKey,
            baseURL: options.baseUrl,
            // The PWA sends the user's own key straight to Anthropic from their browser;
            // no CodeArchy server sees it. The SDK requires this flag to run in a page or worker.
            dangerouslyAllowBrowser: true,
            ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
            ...(options.fetch ? { fetch: options.fetch as unknown as typeof globalThis.fetch } : {}),
        });
        return client;
    };

    const mapError = (err: unknown, signal?: SignalLike): ProviderError => toError(err, signal, options.apiKey);

    async function maxOutput(model: string, signal?: SignalLike): Promise<number> {
        if (!limits.has(model)) {
            try {
                const info = await sdk().models.retrieve(model, {}, { signal: signal as never });
                limits.set(model, info.max_tokens ?? undefined);
            } catch {
                limits.set(model, undefined);
            }
        }
        const max = limits.get(model);
        return max ? Math.min(max, STREAMING_MAX_OUTPUT) : DEFAULT_MAX_OUTPUT;
    }

    return {
        id: ID,
        label: 'Anthropic',
        kind: 'api-key',
        retriesInternally: true,
        baseUrl: options.baseUrl ?? 'https://api.anthropic.com',

        async detect(signal) {
            if (!options.apiKey) return { state: 'needs-key' };
            try {
                await sdk().models.list({ limit: 1 }, { signal: signal as never });
                return { state: 'ready' };
            } catch (err) {
                const e = mapError(err, signal);
                if (e.code === 'auth') return { state: 'unauthorized', detail: 'Anthropic rejected the key' };
                if (e.code === 'unavailable' || e.code === 'cancelled') return { state: 'unreachable', detail: "Anthropic isn't answering" };
                return { state: 'error', detail: e.message };
            }
        },

        async listModels(signal) {
            const out: ModelInfo[] = [];
            try {
                for await (const m of sdk().models.list({ limit: 100 }, { signal: signal as never })) {
                    limits.set(m.id, m.max_tokens ?? undefined);
                    out.push({
                        id: m.id,
                        label: m.display_name,
                        provider: ID,
                        contextWindow: m.max_input_tokens ?? undefined,
                        maxOutput: m.max_tokens ?? undefined,
                        supports: {
                            tools: true,
                            jsonSchema: m.capabilities?.structured_outputs.supported,
                            vision: m.capabilities?.image_input.supported,
                            embeddings: false,
                        },
                        locality: 'cloud',
                    });
                }
            } catch (err) {
                throw mapError(err, signal);
            }
            return out;
        },

        async *chat(request, signal) {
            try {
                yield* run(request, signal);
            } catch (err) {
                yield { type: 'error', error: mapError(err, signal) };
            }
        },
    };

    async function* run(request: ChatRequest, signal?: SignalLike): AsyncGenerator<ChatEvent> {
        const params: StreamParams = {
            model: request.model,
            max_tokens: request.maxOutputTokens ?? (await maxOutput(request.model, signal)),
            messages: toMessages(request.messages),
            stream: true,
            // Cache the conversation so far: tool loops resend it every round.
            cache_control: { type: 'ephemeral' },
        };
        if (request.system) {
            params.system = [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }];
        }
        if (request.tools?.length) {
            params.tools = request.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters as Anthropic.Beta.Messages.BetaTool.InputSchema,
                // Stream large inputs as they're generated. The server no longer validates them,
                // so callers validate each call's args against the schema (they do anyway).
                eager_input_streaming: true,
            }));
            params.tool_choice = { type: request.toolChoice === 'none' ? 'none' : 'auto' };
        }
        if (request.json?.schema) {
            params.output_config = { format: { type: 'json_schema', schema: request.json.schema } };
        }
        if (fallback) {
            params.betas = [FALLBACK_BETA];
            params.fallbacks = 'default';
        }
        // Sampling parameters are not sent: the current API version rejects them on every model.

        const stream = sdk().beta.messages.stream(params, { signal: signal as never });
        for await (const event of stream) {
            if (event.type === 'content_block_start' && event.content_block.type === 'fallback') {
                yield { type: 'restart', reason: 'fallback' };
            } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                yield { type: 'text', delta: event.delta.text };
            }
        }
        const message = await stream.finalMessage();
        const stop = stopReason(message.stop_reason);

        // Only what follows the last fallback switch is the answer.
        const blocks = message.content;
        const lastSwitch = blocks.map((b) => b.type).lastIndexOf('fallback');
        const answer = blocks.slice(lastSwitch + 1);
        const content = answer.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');

        // Never run tools from a turn that was cut off or refused: the input may be truncated.
        const toolCalls: ToolCall[] =
            stop === 'max_tokens' || stop === 'refusal'
                ? []
                : answer.flatMap((b) => (b.type === 'tool_use' ? [toToolCall(b)] : []));
        for (const call of toolCalls) yield { type: 'tool_call', call };

        const u = message.usage;
        const cached = u.cache_read_input_tokens ?? 0;
        yield {
            type: 'usage',
            usage: {
                inputTokens: u.input_tokens + cached + (u.cache_creation_input_tokens ?? 0),
                outputTokens: u.output_tokens,
                cachedInputTokens: cached,
            },
        };
        yield {
            type: 'done',
            stopReason: stop,
            turn: { content, toolCalls, replay: { provider: ID, model: message.model, data: blocks } },
        };
    }
}

function toToolCall(block: Anthropic.Beta.Messages.BetaToolUseBlock): ToolCall {
    const input = block.input;
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        throw new ProviderError('invalid_response', ID, 'Claude sent tool input that is not a JSON object');
    }
    return { id: block.id, name: block.name, args: input as Record<string, unknown> };
}

function stopReason(reason: string | null): StopReason {
    switch (reason) {
        case 'end_turn':
        case 'stop_sequence':
            return 'end';
        case 'tool_use':
            return 'tool_use';
        case 'max_tokens':
        case 'model_context_window_exceeded':
            return 'max_tokens';
        case 'refusal':
            return 'refusal';
        default:
            return 'other';
    }
}

/** Neutral messages → Anthropic messages. Consecutive tool results share one user message. */
function toMessages(messages: ChatMessage[]): MessageParam[] {
    const out: MessageParam[] = [];
    let results: ToolResult[] | undefined;
    const flush = () => {
        if (results) out.push({ role: 'user', content: results });
        results = undefined;
    };
    for (const m of messages) {
        if (m.role === 'tool') {
            (results ??= []).push({
                type: 'tool_result',
                tool_use_id: m.toolCallId,
                content: m.content,
                ...(m.isError ? { is_error: true } : {}),
            });
            continue;
        }
        flush();
        if (m.role === 'user') {
            out.push({ role: 'user', content: m.content });
        } else if (m.replay?.provider === ID && Array.isArray(m.replay.data)) {
            // Sent back exactly as received (thinking blocks included).
            out.push({ role: 'assistant', content: m.replay.data as ContentBlock[] } as MessageParam);
        } else {
            const content: Anthropic.Beta.Messages.BetaContentBlockParam[] = [];
            if (m.content) content.push({ type: 'text', text: m.content });
            for (const c of m.toolCalls ?? []) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
            if (content.length) out.push({ role: 'assistant', content });
        }
    }
    flush();
    return out;
}

const CONTEXT_OVERFLOW = /prompt is too long|context window|too many tokens/i;

/** SDK errors → the neutral taxonomy, using the SDK's typed classes. */
function toError(err: unknown, signal: SignalLike | undefined, apiKey: string | undefined): ProviderError {
    if (err instanceof ProviderError) return err;
    const message = (e: unknown) => redact(e instanceof Error ? e.message : String(e), [apiKey]);
    if (signal?.aborted || err instanceof Anthropic.APIUserAbortError) {
        return new ProviderError('cancelled', ID, 'Cancelled', { cause: err });
    }
    if (err instanceof Anthropic.APIConnectionError) {
        return new ProviderError('unavailable', ID, `Couldn't reach Anthropic: ${message(err)}`, { cause: err });
    }
    if (err instanceof Anthropic.APIError) {
        const status = err.status;
        const opts = { status, cause: err, retryAfterMs: retryAfter(err) };
        if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
            return new ProviderError('auth', ID, message(err), opts);
        }
        if (err instanceof Anthropic.RateLimitError) return new ProviderError('rate_limit', ID, message(err), opts);
        if (err instanceof Anthropic.InternalServerError || err instanceof Anthropic.RequestTimeoutError) {
            return new ProviderError('unavailable', ID, message(err), opts); // includes 529 overloaded
        }
        if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.ContentTooLargeError) {
            const code = CONTEXT_OVERFLOW.test(err.message) ? 'context_overflow' : 'bad_request';
            return new ProviderError(code, ID, message(err), opts);
        }
        return new ProviderError('bad_request', ID, message(err), opts);
    }
    // Anything else from the SDK mid-stream: a tool input it couldn't parse, or a dropped connection.
    return new ProviderError('invalid_response', ID, message(err), { cause: err });
}

function retryAfter(err: InstanceType<typeof Anthropic.APIError>): number | undefined {
    const value = (err.headers as { get?(name: string): string | null } | undefined)?.get?.('retry-after');
    if (!value || !/^\d+(\.\d+)?$/.test(value)) return undefined;
    return Math.ceil(Number(value) * 1000);
}
