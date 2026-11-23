/**
 * @codearchy/providers: one streaming chat interface over local and cloud
 * models. Isomorphic: adapters use `fetch` (or the vendor SDK built on it), so
 * the same code runs in Node, VS Code, browsers and workers.
 */
export type {
    AssistantTurn,
    ChatEvent,
    ChatMessage,
    ChatRequest,
    EmbedRequest,
    JsonSchema,
    ModelInfo,
    ProviderAdapter,
    ProviderKind,
    ProviderState,
    ProviderStatus,
    ReplayData,
    SignalLike,
    StopReason,
    ToolCall,
    ToolSpec,
    Usage,
} from './types.js';
export { ProviderError, type ProviderErrorCode } from './errors.js';
export type { FetchLike, ResponseLike, RequestInitLike, ReadableStreamLike } from './http.js';
export { collect } from './stream.js';
export { withResilience, type ResilienceOptions } from './resilience.js';

export { ollama, type OllamaOptions } from './adapters/ollama.js';
export {
    openAICompatible,
    openai,
    openrouter,
    groq,
    mistral,
    lmStudio,
    type OpenAICompatibleOptions,
} from './adapters/openai-compatible.js';
export { anthropic, type AnthropicOptions } from './adapters/anthropic.js';
export { gemini, type GeminiOptions } from './adapters/gemini.js';
