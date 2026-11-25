/**
 * VS Code's Language Model API (`vscode.lm`): the models the user's GitHub
 * Copilot plan includes (and any another extension contributes), with VS Code
 * handling sign-in, consent and quotas. This package never imports `vscode`:
 * the extension passes the API in, and older VS Code versions without
 * `vscode.lm` simply report the provider as unavailable.
 *
 * The API has no system role (the system prompt goes first as a user
 * message), reports no token usage (estimated here), and has no JSON mode
 * (callers' schema validation and repair cover it).
 */
import { estimateTokens } from '../budget.js';
import { ProviderError } from '../errors.js';
import { guarded } from '../stream.js';
import type { ChatEvent, ChatMessage, ChatRequest, ModelInfo, ProviderAdapter, SignalLike, ToolCall } from '../types.js';

// ── The slice of the vscode module this adapter uses (structural, so any VS Code ≥ 1.95 fits) ──

export interface LmChatModel {
    readonly id: string;
    readonly name: string;
    readonly vendor: string;
    readonly family: string;
    readonly maxInputTokens: number;
    sendRequest(messages: unknown[], options?: { justification?: string; tools?: unknown[]; toolMode?: number }, token?: unknown): PromiseLike<{ stream: AsyncIterable<unknown> }>;
}

export interface VscodeLmApi {
    lm?: { selectChatModels(selector?: Record<string, string>): PromiseLike<LmChatModel[]> };
    LanguageModelChatMessage: { User(content: string | unknown[]): unknown; Assistant(content: string | unknown[]): unknown };
    LanguageModelTextPart: new (value: string) => { value: string };
    LanguageModelToolCallPart: new (callId: string, name: string, input: object) => { callId: string; name: string; input: object };
    LanguageModelToolResultPart: new (callId: string, content: unknown[]) => unknown;
    LanguageModelChatToolMode?: { Auto: number };
    CancellationTokenSource: new () => { token: unknown; cancel(): void; dispose(): void };
    LanguageModelError?: new (...args: never[]) => Error & { code: string };
}

export interface VscodeLmOptions {
    /** Shown in VS Code's consent prompt. */
    justification?: string;
}

const ID = 'vscode-lm';
/** VS Code lists some models only its own features may use (e.g. Copilot's dictation clean-up); asking one fails with this. */
const CORE_ONLY = /only available to VS Code core/i;

export function vscodeLm(api: VscodeLmApi, options: VscodeLmOptions = {}): ProviderAdapter {
    const justification = options.justification ?? 'CodeArchy uses this model to explain your codebase and answer questions about it.';
    /** Models VS Code refused to let an extension use (learned on first use: the API doesn't say so up front). */
    const coreOnly = new Set<string>();
    const models = async (): Promise<LmChatModel[]> => {
        if (!api.lm) return [];
        return (await api.lm.selectChatModels({})).filter((m) => !coreOnly.has(m.id));
    };
    /** What to use instead of a model VS Code keeps for itself: the next best (the registry's order: larger context first). */
    const alternative = async (): Promise<LmChatModel | undefined> => (await models()).reduce<LmChatModel | undefined>((a, b) => (!a || (b.maxInputTokens || 0) > (a.maxInputTokens || 0) ? b : a), undefined);

    return {
        id: ID,
        label: 'GitHub Copilot (VS Code)',
        kind: 'subscription',
        retriesInternally: true, // consent, quota and sign-in problems aren't worth retrying

        async detect() {
            if (!api.lm) return { state: 'unreachable', detail: 'Needs VS Code 1.95 or later' };
            try {
                const list = await models();
                return list.length
                    ? { state: 'ready', detail: `${list.length} model${list.length === 1 ? '' : 's'} from ${[...new Set(list.map((m) => m.vendor))].join(', ')}` }
                    : { state: 'unreachable', detail: 'No language models: sign in to GitHub Copilot in VS Code' };
            } catch (err) {
                return { state: 'error', detail: err instanceof Error ? err.message : String(err) };
            }
        },

        async listModels() {
            return (await models()).map(
                (m): ModelInfo => ({
                    id: m.id,
                    label: `${m.name}${m.vendor !== 'copilot' ? ` (${m.vendor})` : ''}`,
                    provider: ID,
                    contextWindow: m.maxInputTokens || undefined,
                    supports: { embeddings: false },
                    locality: 'cloud',
                }),
            );
        },

        chat(request, signal) {
            return guarded(ID, signal, () => run(request, signal));
        },
    };

    async function* run(request: ChatRequest, signal?: SignalLike): AsyncGenerator<ChatEvent> {
        if (!api.lm) throw new ProviderError('unavailable', ID, 'This VS Code has no Language Model API (needs 1.95 or later)');
        const asked = coreOnly.has(request.model) ? await alternative() : (await api.lm.selectChatModels({ id: request.model }))[0];
        if (!asked) throw new ProviderError('bad_request', ID, `VS Code has no model "${request.model}" (is Copilot signed in?)`);
        let model: LmChatModel = asked;

        const messages = toMessages(api, request);
        const cts = new api.CancellationTokenSource();
        const onAbort = () => cts.cancel();
        signal?.addEventListener('abort', onAbort, { once: true });
        let content = '';
        const toolCalls: ToolCall[] = [];
        try {
            const tools = request.tools?.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters }));
            let response: { stream: AsyncIterable<unknown> } | undefined;
            const options = { justification, ...(tools?.length ? { tools, toolMode: api.LanguageModelChatToolMode?.Auto ?? 1 } : {}) };
            while (!response) {
                try {
                    response = await model.sendRequest(messages, options, cts.token);
                } catch (err) {
                    // A model only VS Code itself may use: never offer it again, and answer with the next best now.
                    if (signal?.aborted || !CORE_ONLY.test(err instanceof Error ? err.message : String(err))) throw toError(api, err, signal);
                    coreOnly.add(model.id);
                    const next: LmChatModel | undefined = await alternative();
                    if (!next) throw toError(api, err, signal);
                    model = next;
                }
            }
            try {
                for await (const part of response.stream) {
                    if (part instanceof api.LanguageModelTextPart) {
                        content += part.value;
                        yield { type: 'text', delta: part.value };
                    } else if (part instanceof api.LanguageModelToolCallPart) {
                        const call: ToolCall = { id: part.callId, name: part.name, args: (part.input ?? {}) as Record<string, unknown> };
                        toolCalls.push(call);
                        yield { type: 'tool_call', call };
                    }
                }
            } catch (err) {
                throw toError(api, err, signal);
            }
        } finally {
            signal?.removeEventListener('abort', onAbort);
            cts.dispose();
        }
        // No usage from VS Code: estimate it, so budgets and the audit log have numbers.
        const input = [request.system ?? '', ...request.messages.map((m) => m.content)].join('\n');
        yield { type: 'usage', usage: { inputTokens: estimateTokens(input), outputTokens: estimateTokens(content) } };
        yield { type: 'done', stopReason: toolCalls.length ? 'tool_use' : 'end', turn: { content, toolCalls } };
    }
}

function toMessages(api: VscodeLmApi, request: ChatRequest): unknown[] {
    const M = api.LanguageModelChatMessage;
    const out: unknown[] = [];
    // No system role: the instructions go first, as the user's own preface.
    if (request.system) out.push(M.User(request.system));
    let results: unknown[] | undefined;
    const flush = () => {
        if (results) out.push(M.User(results));
        results = undefined;
    };
    for (const m of request.messages as ChatMessage[]) {
        if (m.role === 'tool') {
            (results ??= []).push(new api.LanguageModelToolResultPart(m.toolCallId, [new api.LanguageModelTextPart(m.isError ? `Error: ${m.content}` : m.content)]));
            continue;
        }
        flush();
        if (m.role === 'user') out.push(M.User(m.content));
        else {
            const parts: unknown[] = [];
            if (m.content) parts.push(new api.LanguageModelTextPart(m.content));
            for (const c of m.toolCalls ?? []) parts.push(new api.LanguageModelToolCallPart(c.id, c.name, c.args));
            if (parts.length) out.push(M.Assistant(parts));
        }
    }
    flush();
    return out;
}

function toError(api: VscodeLmApi, err: unknown, signal?: SignalLike): ProviderError {
    if (err instanceof ProviderError) return err;
    const message = err instanceof Error ? err.message : String(err);
    if (signal?.aborted || (err instanceof Error && err.name === 'Canceled')) return new ProviderError('cancelled', ID, 'Cancelled', { cause: err });
    const code = api.LanguageModelError && err instanceof api.LanguageModelError ? err.code : undefined;
    if (code === 'NoPermissions') return new ProviderError('auth', ID, 'CodeArchy may not use this model: allow it when VS Code asks', { cause: err });
    if (code === 'Blocked') return new ProviderError('quota', ID, `The model refused the request: ${message}`, { cause: err });
    if (code === 'NotFound') return new ProviderError('bad_request', ID, `The model is no longer available: ${message}`, { cause: err });
    return new ProviderError('unavailable', ID, message, { cause: err });
}
