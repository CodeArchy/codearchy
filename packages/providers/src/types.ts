/**
 * The provider-neutral surface. Every adapter turns its vendor's API into
 * these types, so the router, summarizer and chat never see a vendor format.
 */
import type { ProviderError } from './errors.js';

/** Where a provider runs and how it's paid for. */
export type ProviderKind = 'local' | 'api-key' | 'subscription';

/**
 * The part of AbortSignal the adapters use. A real AbortSignal (browser, Node,
 * worker) satisfies it.
 */
export interface SignalLike {
    readonly aborted: boolean;
    readonly reason?: unknown;
    addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
    removeEventListener(type: 'abort', listener: () => void): void;
}

/** JSON Schema for tool parameters or structured output. Passed through untouched. */
export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
    name: string;
    description: string;
    /** A JSON Schema object (`type: 'object'`) for the arguments. */
    parameters: JsonSchema;
}

export interface ToolCall {
    id: string;
    name: string;
    /** Parsed arguments. The caller validates them against the tool's schema before running it. */
    args: Record<string, unknown>;
}

/**
 * The provider's own record of an assistant turn, replayed verbatim on the next
 * request to the same provider. Some providers require it: Anthropic's thinking
 * blocks and Gemini's thought signatures must come back unchanged for tool use to
 * keep working. Opaque to everything except the adapter that produced it.
 */
export interface ReplayData {
    provider: string;
    model: string;
    data: unknown;
}

export type ChatMessage =
    | { role: 'user'; content: string }
    | { role: 'assistant'; content: string; toolCalls?: ToolCall[]; replay?: ReplayData }
    | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean };

export interface ChatRequest {
    model: string;
    /** Stable instructions. Adapters that support prompt caching cache it. */
    system?: string;
    messages: ChatMessage[];
    tools?: ToolSpec[];
    /**
     * 'auto' (the default) lets the model decide; 'none' forbids tool calls.
     * There is deliberately no "force a tool": several current models reject it.
     * Steer from the prompt instead.
     */
    toolChoice?: 'auto' | 'none';
    /** Upper bound on output tokens. Adapters pick a sensible default when it's absent. */
    maxOutputTokens?: number;
    /** Sampling temperature. Ignored by providers whose API no longer accepts it. */
    temperature?: number;
    /** Ask for JSON output, optionally matching a schema. */
    json?: { schema?: JsonSchema; name?: string };
}

export type StopReason =
    | 'end' // finished normally
    | 'tool_use' // wants tool results
    | 'max_tokens' // hit the output limit (the text is truncated)
    | 'refusal' // the model or a safety filter declined
    | 'other';

export interface Usage {
    inputTokens: number;
    outputTokens: number;
    /** Input tokens served from the provider's prompt cache, where it reports them. */
    cachedInputTokens?: number;
}

/** The finished assistant turn, ready to append to `messages` for the next request. */
export interface AssistantTurn {
    content: string;
    toolCalls: ToolCall[];
    replay?: ReplayData;
}

export type ChatEvent =
    | { type: 'text'; delta: string }
    /**
     * Discard the text streamed so far: another model took over this turn (a
     * provider-side refusal fallback) and its answer follows. `done.turn` holds
     * only the final answer.
     */
    | { type: 'restart'; reason: 'fallback' }
    | { type: 'tool_call'; call: ToolCall }
    | { type: 'usage'; usage: Usage }
    | { type: 'done'; stopReason: StopReason; turn: AssistantTurn }
    | { type: 'error'; error: ProviderError };

export interface ModelInfo {
    id: string;
    label: string;
    provider: string;
    /** Context window in tokens, when the provider reports it (no hard-coded guesses). */
    contextWindow?: number;
    /** Output limit in tokens, when known. */
    maxOutput?: number;
    /** `undefined` means "unknown: try it". */
    supports: { tools?: boolean; jsonSchema?: boolean; vision?: boolean; embeddings?: boolean };
    locality: 'on-device' | 'cloud';
}

export type ProviderState =
    | 'ready'
    | 'needs-key' // no credential configured
    | 'unauthorized' // the credential was rejected
    | 'unreachable' // offline, wrong URL, or (in a browser) blocked by CORS
    | 'error';

export interface ProviderStatus {
    state: ProviderState;
    /** A short human-readable explanation. Never contains a credential. */
    detail?: string;
}

export interface EmbedRequest {
    model: string;
    input: string[];
}

export interface ProviderAdapter {
    /** Stable id, e.g. 'ollama', 'anthropic', 'openai', 'openrouter'. */
    readonly id: string;
    readonly label: string;
    readonly kind: ProviderKind;
    /** True when the adapter already retries transient failures (so wrappers shouldn't). */
    readonly retriesInternally?: boolean;
    /** Is the provider usable right now? Never throws. */
    detect(signal?: SignalLike): Promise<ProviderStatus>;
    /** Models discovered at runtime. Throws ProviderError. */
    listModels(signal?: SignalLike): Promise<ModelInfo[]>;
    /**
     * Streams one assistant turn. Never throws: failures arrive as a final
     * `error` event. A successful stream ends with exactly one `done` event.
     */
    chat(request: ChatRequest, signal?: SignalLike): AsyncIterable<ChatEvent>;
    /** Embeddings, for adapters that offer them. Throws ProviderError. */
    embed?(request: EmbedRequest, signal?: SignalLike): Promise<number[][]>;
}
