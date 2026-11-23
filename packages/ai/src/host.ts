/**
 * AiHost: the host side of the AiClient contract (protocol), the same in every
 * host. VS Code wraps it in the extension host behind postMessage; the web app
 * wraps it in its engine worker. Hosts supply storage (settings, keys, usage,
 * cards), file access, the current index, and the providers they can offer.
 *
 * Defaults are private: the tier starts at "local only", so nothing leaves the
 * machine until the user chooses otherwise. Providers aren't even checked until
 * AI is used (settings or chat opened, a question asked, "Summarize with AI"):
 * showing an auto-built card makes no network request, so a web page doesn't
 * reach for localhost just because someone selected a node.
 */
import type { HierarchyIndex } from '@codearchy/core';
import type { AiAuditEntry, AiCard, AiHostEvent, AiProviderInfo, AiResolution, AiRole, AiSettings, AiState, ChatEvent as UiChatEvent, SendPreview } from '@codearchy/protocol';
import {
    apiKeyName,
    MemoryUsageStore,
    ProviderRegistry,
    type ChatMessage,
    type ProviderAdapter,
    type RequestPreview,
    type SecretStore,
    type UsageStore,
} from '@codearchy/providers';
import type { Card } from './card.js';
import { GroundedChat } from './chat.js';
import { NodeSearch } from './search.js';
import { MemoryCardStore, Summarizer, type CardStore } from './summarizer.js';

export interface ProviderFactory {
    id: string;
    label: string;
    /** Takes an API key (stored in the host's SecretStore). */
    acceptsKey: boolean;
    /** A one-time setup the UI can show while the provider isn't ready. */
    setup?: { title: string; steps: string[] };
    /** Builds the adapter (with the stored key, if any). */
    create(apiKey: string | undefined): ProviderAdapter;
}

export interface SettingsStore {
    load(): Promise<Partial<AiSettings> | undefined>;
    save(settings: AiSettings): Promise<void>;
}

export interface AiHostOptions {
    /** The current index (it changes as files change). */
    index(): HierarchyIndex | undefined;
    readFile(path: string): Promise<string | undefined>;
    providers: ProviderFactory[];
    secrets: SecretStore;
    settings: SettingsStore;
    usage?: UsageStore;
    cards?: CardStore;
    /** Unsolicited events for the UI: state changes, new cards, previews. */
    emit(event: AiHostEvent): void;
    /** AI calls one "Summarize with AI" may make (a container summarizes its subtree first). Default 40. */
    summarizeCallLimit?: number;
    /** Above this many files, chat search covers names and paths only. Default 3000. */
    cardSearchLimit?: number;
}

export const DEFAULT_AI_SETTINGS: AiSettings = { tier: 'local-only', askBeforeSend: false, roles: {}, defaults: {}, budgets: {} };

const ROLES: AiRole[] = ['chat', 'summarizer', 'architect', 'embedder'];

interface IndexState {
    index: HierarchyIndex;
    summarizer: Summarizer;
    deterministic: Summarizer;
    chat: GroundedChat;
}

export class AiHost {
    private settings: AiSettings = structuredClone(DEFAULT_AI_SETTINGS);
    private registry!: ProviderRegistry;
    private readonly keys = new Map<string, boolean>();
    private readonly cards: CardStore;
    private readonly usage: UsageStore;
    private readonly conversations = new Map<string, { history: ChatMessage[]; controller?: AbortController }>();
    private readonly previews = new Map<string, (send: boolean) => void>();
    private previewSeq = 0;
    private current?: IndexState;
    private ready?: Promise<void>;
    /** Providers are only checked once AI is used (never just to show an auto-built card). */
    private checked?: Promise<void>;

    constructor(private readonly options: AiHostOptions) {
        this.cards = options.cards ?? new MemoryCardStore();
        this.usage = options.usage ?? new MemoryUsageStore();
    }

    /** Loads settings and keys and checks providers (once; later calls wait for it). */
    init(): Promise<void> {
        this.ready ??= (async () => {
            this.settings = { ...structuredClone(DEFAULT_AI_SETTINGS), ...((await this.options.settings.load()) ?? {}) };
            await this.rebuild();
        })();
        return this.ready;
    }

    async state(): Promise<AiState> {
        await this.used();
        return this.snapshot();
    }

    async refresh(): Promise<AiState> {
        await this.init();
        this.checked = this.registry.refresh().then(() => undefined);
        await this.checked;
        return this.changed();
    }

    async updateSettings(patch: Partial<AiSettings>): Promise<AiState> {
        await this.init();
        this.settings = sanitize({ ...this.settings, ...patch });
        await this.options.settings.save(this.settings);
        await this.rebuild(); // the tier may rule providers in or out
        return this.changed();
    }

    async setKey(provider: string, key: string | null): Promise<AiState> {
        await this.init();
        const factory = this.options.providers.find((p) => p.id === provider);
        if (!factory?.acceptsKey) throw new Error(`"${provider}" doesn't take an API key`);
        const name = apiKeyName(provider);
        if (key && key.trim()) await this.options.secrets.set(name, key.trim());
        else await this.options.secrets.delete(name);
        await this.rebuild();
        return this.changed();
    }

    /** The newest card for a node; `generate` writes AI cards for it (and, for a container, its subtree first). */
    async card(key: string, options: { generate?: boolean } = {}): Promise<AiCard | undefined> {
        await this.init();
        const s = this.indexState();
        const node = s?.index.node(key);
        if (!s || !node || node.kind === 'symbol') return undefined;
        if (options.generate) {
            await this.used();
            await s.summarizer.crawl([key], {
                maxCalls: this.options.summarizeCallLimit ?? 40,
                onCard: (c) => this.options.emit({ type: 'card', card: toAiCard(c) }),
            });
        }
        const card = (await s.summarizer.latest(key)) ?? (await s.deterministic.card(key));
        if (options.generate && card.source !== 'ai') {
            // Why there's still no AI card (no model allowed, blocked, budget…).
            const fresh = await s.summarizer.card(key).catch(() => card);
            return toAiCard(fresh);
        }
        return toAiCard(card);
    }

    async ask(conversation: string, question: string, options: { selection?: string }, onEvent: (event: UiChatEvent) => void): Promise<void> {
        await this.used();
        const s = this.indexState();
        if (!s) return onEvent({ type: 'error', code: 'unavailable', message: 'The workspace is still being indexed' });
        const conv = this.conversations.get(conversation) ?? { history: [] };
        this.conversations.set(conversation, conv);
        conv.controller?.abort();
        const controller = new AbortController();
        conv.controller = controller;
        try {
            for await (const e of s.chat.ask(question, { history: conv.history, selection: options.selection, signal: controller.signal })) {
                if (e.type === 'error') onEvent({ type: 'error', code: e.error.code, message: e.error.message });
                else if (e.type === 'done') {
                    conv.history = e.history;
                    onEvent({
                        type: 'done',
                        answer: e.answer,
                        citations: e.citations,
                        invalidCitations: e.invalidCitations,
                        actions: e.actions,
                        mode: e.mode,
                        rounds: e.rounds,
                        usage: { inputTokens: e.usage.inputTokens, outputTokens: e.usage.outputTokens },
                        provider: e.provider,
                        model: e.model,
                    });
                } else onEvent(e);
            }
        } finally {
            if (conv.controller === controller) conv.controller = undefined;
        }
    }

    cancel(conversation: string): void {
        this.conversations.get(conversation)?.controller?.abort();
    }

    reset(conversation: string): void {
        this.cancel(conversation);
        this.conversations.delete(conversation);
    }

    answerPreview(id: string, send: boolean): void {
        this.previews.get(id)?.(send);
        this.previews.delete(id);
    }

    async audit(): Promise<AiAuditEntry[]> {
        await this.init();
        return (await this.registry.auditLog().entries()).map((e) => ({
            at: e.at,
            provider: e.provider,
            model: e.model,
            role: e.role,
            remote: e.remote,
            outcome: e.outcome,
            ...(e.reason ? { reason: e.reason } : {}),
            ...(e.inputTokens !== undefined ? { inputTokens: e.inputTokens, outputTokens: e.outputTokens } : {}),
        }));
    }

    /** One entry point for RPC transports: `method` names an AiClient method. */
    async handle(method: string, params: Record<string, unknown>): Promise<unknown> {
        switch (method) {
            case 'state':
                return this.state();
            case 'refresh':
                return this.refresh();
            case 'updateSettings':
                return this.updateSettings((params.patch ?? {}) as Partial<AiSettings>);
            case 'setKey':
                return this.setKey(String(params.provider), typeof params.key === 'string' ? params.key : null);
            case 'card':
                return this.card(String(params.key), { generate: params.generate === true });
            case 'cancel':
                return this.cancel(String(params.conversation));
            case 'reset':
                return this.reset(String(params.conversation));
            case 'answerPreview':
                return this.answerPreview(String(params.id), params.send === true);
            case 'audit':
                return this.audit();
            default:
                throw new Error(`Unknown AI method "${method}"`);
        }
    }

    // ── internals ──────────────────────────────────────────────────────────

    /** Settings and keys loaded, and providers checked (once). */
    private async used(): Promise<void> {
        await this.init();
        this.checked ??= this.registry.refresh().then(() => undefined);
        await this.checked;
    }

    private async rebuild(): Promise<void> {
        const adapters: ProviderAdapter[] = [];
        for (const f of this.options.providers) {
            const key = f.acceptsKey ? await this.options.secrets.get(apiKeyName(f.id)) : undefined;
            this.keys.set(f.id, !!key);
            adapters.push(f.create(key));
        }
        this.registry = new ProviderRegistry(
            adapters,
            { policy: { tier: this.settings.tier, askBeforeSend: this.settings.askBeforeSend }, roles: this.settings.roles, defaults: this.settings.defaults, budgets: this.settings.budgets },
            { usage: this.usage, inspect: (p, signal) => this.inspect(p, signal) },
        );
        this.current = undefined; // summarizer and chat hold the registry
        // Re-check only if providers were checked before (settings or keys changed while in use).
        if (this.checked) {
            this.checked = this.registry.refresh().then(() => undefined);
            await this.checked;
        }
    }

    private indexState(): IndexState | undefined {
        const index = this.options.index();
        if (!index) return undefined;
        if (this.current?.index === index) return this.current;
        const readFile = this.options.readFile;
        const summarizer = new Summarizer({ index, readFile, registry: this.registry, store: this.cards });
        const deterministic = new Summarizer({ index, readFile });
        const cardFor = async (k: string): Promise<Card | undefined> => (await summarizer.latest(k)) ?? (await deterministic.card(k));
        const modules = index.hierarchy.nodes.filter((n) => n.kind === 'module').length;
        const chat = new GroundedChat({
            index,
            readFile,
            registry: this.registry,
            cards: cardFor,
            // Card text helps search; above the limit, names and paths keep it fast to build.
            ...(modules <= (this.options.cardSearchLimit ?? 3000) ? {} : { search: new NodeSearch(index) }),
        });
        this.current = { index, summarizer, deterministic, chat };
        return this.current;
    }

    private inspect(p: RequestPreview, signal?: { aborted: boolean; addEventListener(t: 'abort', l: () => void): void }): Promise<boolean> {
        const id = `p${++this.previewSeq}`;
        const preview: SendPreview = {
            id,
            role: p.role,
            provider: p.provider,
            providerLabel: p.providerLabel,
            model: p.model,
            ...(p.request.system ? { system: p.request.system } : {}),
            messages: p.request.messages.map((m) => ({ role: m.role, content: m.content })),
            redactions: p.findings,
            estimatedInputTokens: p.estimatedInputTokens,
        };
        return new Promise<boolean>((resolve) => {
            this.previews.set(id, resolve);
            signal?.addEventListener('abort', () => this.answerPreview(id, false));
            this.options.emit({ type: 'preview', preview });
        });
    }

    private changed(): AiState {
        const state = this.snapshot();
        this.options.emit({ type: 'state', state });
        return state;
    }

    private snapshot(): AiState {
        const providers: AiProviderInfo[] = this.registry.providers().map((p) => {
            const f = this.options.providers.find((x) => x.id === p.id)!;
            return {
                id: p.id,
                label: p.label,
                kind: p.kind,
                onDevice: p.onDevice,
                allowed: p.allowed.ok,
                ...(p.allowed.ok ? {} : { blockedReason: p.allowed.reason }),
                ...(p.status ? { state: p.status.state } : {}),
                ...(p.status?.detail || p.error ? { detail: p.error ?? p.status?.detail } : {}),
                acceptsKey: f.acceptsKey,
                hasKey: this.keys.get(p.id) ?? false,
                models: p.models
                    .filter((m) => m.supports.embeddings !== true || m.supports.tools === true)
                    .map((m) => ({ id: m.id, label: m.label, ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}), ...(m.supports.tools !== undefined ? { tools: m.supports.tools } : {}) })),
                ...(f.setup ? { setup: f.setup } : {}),
            };
        });
        const resolved = Object.fromEntries(
            ROLES.map((role): [AiRole, AiResolution] => {
                const r = this.registry.resolve(role);
                return [role, r.ok ? { ok: true, provider: r.provider, model: r.model, why: r.why } : { ok: false, reason: r.reason }];
            }),
        ) as Record<AiRole, AiResolution>;
        return { settings: structuredClone(this.settings), providers, resolved };
    }
}

function toAiCard(c: Card): AiCard {
    return {
        key: c.key,
        title: c.title,
        purpose: c.purpose,
        responsibilities: c.responsibilities,
        keyNodes: c.keyNodes,
        risks: c.risks,
        confidence: c.confidence,
        source: c.source,
        ...(c.provider ? { provider: c.provider, model: c.model } : {}),
        ...(c.note ? { note: c.note } : {}),
        createdAt: c.createdAt,
    };
}

/** Settings arrive from the UI: keep only known values. */
function sanitize(s: AiSettings): AiSettings {
    const tier = s.tier === 'structure' || s.tier === 'excerpts' ? s.tier : 'local-only';
    const roles: AiSettings['roles'] = {};
    for (const role of ROLES) {
        const r = s.roles?.[role];
        if (r === 'auto' || (r && typeof r.provider === 'string' && typeof r.model === 'string')) roles[role] = r;
    }
    const budgets: AiSettings['budgets'] = {};
    for (const [id, b] of Object.entries(s.budgets ?? {})) {
        const day = Number(b?.tokensPerDay);
        const month = Number(b?.tokensPerMonth);
        budgets[id] = {
            ...(Number.isFinite(day) && day >= 0 && b?.tokensPerDay !== undefined ? { tokensPerDay: day } : {}),
            ...(Number.isFinite(month) && month >= 0 && b?.tokensPerMonth !== undefined ? { tokensPerMonth: month } : {}),
        };
    }
    const defaults: Record<string, string> = {};
    for (const [id, m] of Object.entries(s.defaults ?? {})) if (typeof m === 'string' && m) defaults[id] = m;
    return { tier, askBeforeSend: s.askBeforeSend === true, roles, defaults, budgets };
}
