/**
 * How a UI talks to the AI side of an engine: provider settings and keys,
 * summary cards, grounded chat, and the "ask before sending" preview. Types
 * only; each host implements AiClient over its own transport (postMessage to
 * the VS Code extension host, a Web Worker in the browser).
 *
 * API keys only ever travel UI → host (setKey); no method returns one.
 */

export type PrivacyTier = 'local-only' | 'structure' | 'excerpts';
export type AiRole = 'summarizer' | 'architect' | 'chat' | 'embedder';
export type AiModelRef = { provider: string; model: string };

export interface AiSettings {
    tier: PrivacyTier;
    /** Show every remote request before it's sent. */
    askBeforeSend: boolean;
    /** Unset or 'auto': picked automatically. */
    roles: Partial<Record<AiRole, AiModelRef | 'auto'>>;
    /** The model chosen for each provider. */
    defaults: Record<string, string>;
    budgets: Record<string, { tokensPerDay?: number; tokensPerMonth?: number }>;
}

export interface AiModelInfo {
    id: string;
    label: string;
    contextWindow?: number;
    /** Undefined: unknown. */
    tools?: boolean;
}

export interface AiProviderInfo {
    id: string;
    label: string;
    kind: 'local' | 'api-key' | 'subscription';
    /** Runs on this machine (nothing leaves it). */
    onDevice: boolean;
    /** Allowed by the privacy tier. */
    allowed: boolean;
    blockedReason?: string;
    state?: 'ready' | 'needs-key' | 'unauthorized' | 'unreachable' | 'error';
    detail?: string;
    /** Takes an API key (and whether one is stored). Never the key itself. */
    acceptsKey: boolean;
    hasKey: boolean;
    models: AiModelInfo[];
    /** A one-time setup step the host can explain (e.g. allowing this page's origin in Ollama). */
    setup?: { title: string; steps: string[] };
}

export type AiResolution = { ok: true; provider: string; model: string; why: string } | { ok: false; reason: string };

export interface AiState {
    settings: AiSettings;
    providers: AiProviderInfo[];
    resolved: Record<AiRole, AiResolution>;
}

export interface AiCard {
    key: string;
    title: string;
    purpose: string;
    responsibilities: string[];
    keyNodes: string[];
    risks: string[];
    confidence: number;
    source: 'ai' | 'deterministic';
    provider?: string;
    model?: string;
    note?: string;
    createdAt: number;
}

export type ChatCitation =
    | { type: 'node'; key: string; label: string }
    | { type: 'file'; path: string; label: string; startLine?: number; endLine?: number };

export interface CanvasAction {
    action: 'focus' | 'highlight';
    keys: string[];
}

export type ChatEvent =
    | { type: 'status'; text: string }
    | { type: 'text'; delta: string }
    | { type: 'restart' }
    | { type: 'action'; action: CanvasAction }
    | {
          type: 'done';
          answer: string;
          citations: ChatCitation[];
          invalidCitations: number;
          actions: CanvasAction[];
          mode: 'tools' | 'rag';
          rounds: number;
          usage: { inputTokens: number; outputTokens: number };
          provider: string;
          model: string;
      }
    | { type: 'error'; code: string; message: string };

/** What's about to be sent, for "ask before sending". */
export interface SendPreview {
    id: string;
    role: AiRole;
    provider: string;
    providerLabel: string;
    model: string;
    system?: string;
    messages: Array<{ role: string; content: string }>;
    /** Secrets already redacted from the above, by kind. */
    redactions: Array<{ type: string; count: number }>;
    estimatedInputTokens: number;
}

export interface AiAuditEntry {
    at: number;
    provider: string;
    model: string;
    role: AiRole;
    remote: boolean;
    outcome: 'sent' | 'blocked' | 'error' | 'cancelled';
    reason?: string;
    inputTokens?: number;
    outputTokens?: number;
}

/** Unsolicited messages from the host's AI side. */
export type AiHostEvent =
    | { type: 'state'; state: AiState }
    | { type: 'card'; card: AiCard }
    | { type: 'preview'; preview: SendPreview };

export interface AiClient {
    state(): Promise<AiState>;
    /** Re-check providers and list their models. */
    refresh(): Promise<AiState>;
    updateSettings(patch: Partial<AiSettings>): Promise<AiState>;
    /** Store (or, with null, forget) a provider's API key. */
    setKey(provider: string, key: string | null): Promise<AiState>;
    /** The newest card for a node; `generate` asks for an AI card now (it may take a while). */
    card(key: string, options?: { generate?: boolean }): Promise<AiCard | undefined>;
    /** Asks in a conversation (the host keeps its history); events stream to `onEvent` until `done` or `error`. */
    ask(conversation: string, question: string, options: { selection?: string }, onEvent: (event: ChatEvent) => void): Promise<void>;
    cancel(conversation: string): void;
    /** Forget a conversation's history. */
    reset(conversation: string): void;
    /** Answer a `preview` event. */
    answerPreview(id: string, send: boolean): void;
    subscribe(listener: (event: AiHostEvent) => void): () => void;
    audit?(): Promise<AiAuditEntry[]>;
}
