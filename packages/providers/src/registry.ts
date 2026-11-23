/**
 * The provider registry: the one place model requests go through.
 *
 *   resolve(role)  which provider and model serve a role (assigned, or picked
 *                  automatically with a reason the UI can show)
 *   chat / embed   policy check → secret redaction → budget → optional user
 *                  confirmation → the adapter → usage and audit
 *
 * Providers the privacy tier rules out are never contacted, not even by
 * refresh(): "local only" makes no network calls beyond this machine.
 */
import { MemoryAuditLog, type AuditEntry, type AuditLog, type Role } from './audit.js';
import { Budget, estimateTokens, MemoryUsageStore, type BudgetLimits, type UsageStore } from './budget.js';
import { ProviderError, type ProviderErrorCode } from './errors.js';
import { checkContent, checkProvider, isOnDevice, type ContentKind, type Decision, type PrivacyPolicy } from './privacy.js';
import { withResilience, type ResilienceOptions } from './resilience.js';
import { redactRequest, scanSecrets, type SecretFinding } from './scanner.js';
import type { ChatEvent, ChatRequest, ModelInfo, ProviderAdapter, ProviderStatus, SignalLike, Usage } from './types.js';

export interface ModelRef {
    provider: string;
    model: string;
}

export type RoleSetting = ModelRef | 'auto';

export interface RegistryConfig {
    policy: PrivacyPolicy;
    roles?: Partial<Record<Role, RoleSetting>>;
    /** The model the user chose for each provider; 'auto' prefers it. */
    defaults?: Record<string, string>;
    budgets?: Record<string, BudgetLimits>;
}

/** What the user is shown before a remote request when "always ask" is on. */
export interface RequestPreview {
    role: Role;
    provider: string;
    providerLabel: string;
    model: string;
    /** Exactly what will be sent (secrets already redacted). */
    request: ChatRequest;
    findings: SecretFinding[];
    estimatedInputTokens: number;
}

export interface RegistryDeps {
    audit?: AuditLog;
    usage?: UsageStore;
    /** Asked before each remote request when `policy.askBeforeSend` is on. Resolve true to send. */
    inspect?: (preview: RequestPreview, signal?: SignalLike) => Promise<boolean>;
    /** Limits and retries per provider. `false` to use adapters as given (tests). */
    resilience?: ResilienceOptions | false;
    now?: () => number;
}

export interface ProviderSnapshot {
    id: string;
    label: string;
    kind: ProviderAdapter['kind'];
    onDevice: boolean;
    allowed: Decision;
    /** Absent until refreshed, and always absent for a provider the policy rules out. */
    status?: ProviderStatus;
    models: ModelInfo[];
    /** Why listing models failed, if it did. */
    error?: string;
}

export type Resolution =
    | { ok: true; provider: string; model: string; info?: ModelInfo; why: string }
    | { ok: false; reason: string };

export interface SendOptions {
    /** What the request carries. Undeclared content is treated as code excerpts (the strictest). */
    contains?: ContentKind[];
    /** Graph node ids whose content is included, for the audit log. */
    nodes?: string[];
    /** Override the role's model for this request. */
    model?: ModelRef;
    signal?: SignalLike;
}

const ROLE_LABEL: Record<Role, string> = { summarizer: 'Summarizer', architect: 'Architect', chat: 'Chat', embedder: 'Embedder' };

export class ProviderRegistry {
    private readonly order: string[];
    private readonly adapters = new Map<string, ProviderAdapter>();
    private readonly listed = new Map<string, { status: ProviderStatus; models: ModelInfo[]; error?: string }>();
    private readonly audit: AuditLog;
    private readonly usage: UsageStore;
    private readonly now: () => number;
    private budget: Budget;

    constructor(
        adapters: ProviderAdapter[],
        private config: RegistryConfig,
        private readonly deps: RegistryDeps = {},
    ) {
        this.order = adapters.map((a) => a.id);
        for (const a of adapters) {
            if (this.adapters.has(a.id)) throw new Error(`Two providers share the id "${a.id}"`);
            this.adapters.set(a.id, deps.resilience === false ? a : withResilience(a, deps.resilience));
        }
        this.audit = deps.audit ?? new MemoryAuditLog();
        this.usage = deps.usage ?? new MemoryUsageStore();
        this.now = deps.now ?? Date.now;
        this.budget = new Budget(config.budgets ?? {}, this.usage, this.now);
    }

    /** Settings changed (tier, roles, defaults, budgets). Call refresh() if the tier changed. */
    configure(config: RegistryConfig): void {
        this.config = config;
        this.budget = new Budget(config.budgets ?? {}, this.usage, this.now);
        for (const id of this.order) {
            if (!this.allowed(id).ok) this.listed.delete(id);
        }
    }

    get policy(): PrivacyPolicy {
        return this.config.policy;
    }

    auditLog(): AuditLog {
        return this.audit;
    }

    providers(): ProviderSnapshot[] {
        return this.order.map((id) => {
            const a = this.adapters.get(id)!;
            const allowed = this.allowed(id);
            const listed = allowed.ok ? this.listed.get(id) : undefined;
            return {
                id,
                label: a.label,
                kind: a.kind,
                onDevice: isOnDevice(a),
                allowed,
                status: listed?.status,
                models: listed?.models ?? [],
                error: listed?.error,
            };
        });
    }

    /** Checks each allowed provider and lists its models. Ruled-out providers are skipped without a network call. */
    async refresh(signal?: SignalLike): Promise<ProviderSnapshot[]> {
        await Promise.all(
            this.order.map(async (id) => {
                if (!this.allowed(id).ok) {
                    this.listed.delete(id);
                    return;
                }
                const a = this.adapters.get(id)!;
                const status = await a.detect(signal);
                if (status.state !== 'ready') {
                    this.listed.set(id, { status, models: [] });
                    return;
                }
                try {
                    this.listed.set(id, { status, models: await a.listModels(signal) });
                } catch (err) {
                    this.listed.set(id, { status, models: [], error: err instanceof Error ? err.message : String(err) });
                }
            }),
        );
        return this.providers();
    }

    /** Which provider and model serve `role`, and why. */
    resolve(role: Role): Resolution {
        const setting = this.config.roles?.[role] ?? 'auto';
        if (setting !== 'auto') return this.explicit(setting, `Assigned to ${ROLE_LABEL[role]} in settings`);

        const snapshots = this.providers().filter((p) => p.allowed.ok && p.status?.state === 'ready');
        // The summarizer runs many calls: prefer this machine. Otherwise keep the user's provider order.
        const ranked = role === 'summarizer' ? [...snapshots.filter((p) => p.onDevice), ...snapshots.filter((p) => !p.onDevice)] : snapshots;
        for (const p of ranked) {
            const fitting = p.models.filter((m) => fits(role, m));
            if (!fitting.length) continue;
            const preferred = this.config.defaults?.[p.id];
            const pick = fitting.find((m) => m.id === preferred) ?? best(role, fitting);
            const reasons = [
                pick.id === preferred ? `your chosen model for ${p.label}` : `the best fit ${p.label} offers`,
                p.onDevice ? 'runs on this machine' : undefined,
            ].filter(Boolean);
            return { ok: true, provider: p.id, model: pick.id, info: pick, why: `Picked automatically: ${reasons.join(', ')}` };
        }
        const blocked = this.providers().filter((p) => !p.allowed.ok);
        return {
            ok: false,
            reason:
                blocked.length && !snapshots.length
                    ? `No provider can serve the ${ROLE_LABEL[role]} role under the current privacy tier`
                    : `No ready provider has a model for the ${ROLE_LABEL[role]} role`,
        };
    }

    /** One assistant turn for `role`. Never throws: problems arrive as an `error` event (code 'policy' when blocked). */
    chat(role: Role, request: Omit<ChatRequest, 'model'>, options: SendOptions = {}): AsyncIterable<ChatEvent> {
        return this.run(role, request, options);
    }

    /** Embeddings through the embedder role. Throws ProviderError. */
    async embed(input: string[], options: SendOptions = {}): Promise<number[][]> {
        const started = this.now();
        const target = this.target('embedder', options);
        if (!target.ok) throw this.block('embedder', target.entry, target.reason);
        const { adapter, provider, model, base } = target;
        if (!adapter.embed) throw this.block('embedder', base, `${adapter.label} doesn't offer embeddings`);
        const budget = await this.budget.status(provider);
        if (!budget.ok) throw this.block('embedder', base, budget.reason!);

        let texts = input;
        const redactions: Record<string, number> = {};
        if (base.remote) {
            texts = input.map((t) => {
                const r = scanSecrets(t);
                for (const f of r.findings) redactions[f.type] = (redactions[f.type] ?? 0) + f.count;
                return r.text;
            });
        }
        const inputTokens = texts.reduce((n, t) => n + estimateTokens(t), 0);
        try {
            const vectors = await adapter.embed({ model, input: texts }, options.signal);
            await this.budget.add(provider, inputTokens);
            await this.audit.record({ ...base, outcome: 'sent', inputTokens, redactions: nonEmpty(redactions), durationMs: this.now() - started });
            return vectors;
        } catch (err) {
            const e = err instanceof ProviderError ? err : new ProviderError('unavailable', provider, String(err));
            await this.audit.record({
                ...base,
                outcome: e.code === 'cancelled' ? 'cancelled' : 'error',
                errorCode: e.code,
                durationMs: this.now() - started,
            });
            throw e;
        }
    }

    // ── internals ──────────────────────────────────────────────────────────

    private allowed(id: string): Decision {
        return checkProvider(this.config.policy, this.adapters.get(id)!);
    }

    private explicit(ref: ModelRef, why: string): Resolution {
        const a = this.adapters.get(ref.provider);
        if (!a) return { ok: false, reason: `There's no provider "${ref.provider}"` };
        const allowed = this.allowed(ref.provider);
        if (!allowed.ok) return allowed;
        const info = this.listed.get(ref.provider)?.models.find((m) => m.id === ref.model);
        return { ok: true, provider: ref.provider, model: ref.model, info, why };
    }

    /** Resolves the role and checks the content against the tier; returns the audit base either way. */
    private target(role: Role, options: SendOptions) {
        const contains = options.contains ?? ['excerpts'];
        const resolution = options.model ? this.explicit(options.model, 'Chosen for this request') : this.resolve(role);
        const entry = (provider: string, model: string, remote: boolean): AuditEntry => ({
            at: this.now(),
            provider,
            model,
            role,
            remote,
            tier: this.config.policy.tier,
            contains: [...contains],
            outcome: 'sent',
            ...(options.nodes?.length ? { nodes: [...options.nodes] } : {}),
        });
        if (!resolution.ok) return { ok: false as const, reason: resolution.reason, entry: entry('none', 'none', false) };
        const adapter = this.adapters.get(resolution.provider)!;
        const remote = !isOnDevice(adapter);
        const base = entry(resolution.provider, resolution.model, remote);
        const decision = checkContent(this.config.policy, adapter, contains);
        if (!decision.ok) return { ok: false as const, reason: decision.reason, entry: base };
        return { ok: true as const, adapter, provider: resolution.provider, model: resolution.model, base };
    }

    private block(role: Role, entry: AuditEntry, reason: string): ProviderError {
        void this.audit.record({ ...entry, role, outcome: 'blocked', reason });
        return new ProviderError('policy', entry.provider, reason);
    }

    private async *run(role: Role, request: Omit<ChatRequest, 'model'>, options: SendOptions): AsyncGenerator<ChatEvent> {
        const started = this.now();
        const target = this.target(role, options);
        if (!target.ok) {
            yield { type: 'error', error: this.block(role, target.entry, target.reason) };
            return;
        }
        const { adapter, provider, model, base } = target;

        let outgoing: ChatRequest = { ...request, model };
        let findings: SecretFinding[] = [];
        if (base.remote) ({ request: outgoing, findings } = redactRequest(outgoing));

        const budget = await this.budget.status(provider);
        if (!budget.ok) {
            yield { type: 'error', error: this.block(role, base, budget.reason!) };
            return;
        }

        if (base.remote && this.config.policy.askBeforeSend) {
            if (!this.deps.inspect) {
                yield { type: 'error', error: this.block(role, base, 'Asking before sending is on, but this host has no way to ask') };
                return;
            }
            const preview: RequestPreview = {
                role,
                provider,
                providerLabel: adapter.label,
                model,
                request: outgoing,
                findings,
                estimatedInputTokens: estimateTokens(JSON.stringify([outgoing.system, outgoing.messages, outgoing.tools])),
            };
            let approved = false;
            try {
                approved = await this.deps.inspect(preview, options.signal);
            } catch {
                approved = false;
            }
            if (!approved) {
                yield { type: 'error', error: this.block(role, base, 'You declined to send this request') };
                return;
            }
        }

        let usage: Usage | undefined;
        let outcome: AuditEntry['outcome'] = 'cancelled';
        let errorCode: ProviderErrorCode | undefined;
        try {
            for await (const event of adapter.chat(outgoing, options.signal)) {
                if (event.type === 'usage') usage = event.usage;
                if (event.type === 'done') outcome = 'sent';
                if (event.type === 'error') {
                    errorCode = event.error.code;
                    outcome = errorCode === 'cancelled' ? 'cancelled' : 'error';
                }
                yield event;
            }
        } finally {
            if (usage) await this.budget.add(provider, usage.inputTokens + usage.outputTokens);
            const redactions: Record<string, number> = {};
            for (const f of findings) redactions[f.type] = f.count;
            await this.audit.record({
                ...base,
                outcome,
                ...(errorCode ? { errorCode } : {}),
                ...(usage
                    ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cachedInputTokens }
                    : {}),
                ...(nonEmpty(redactions) ? { redactions } : {}),
                durationMs: this.now() - started,
            });
        }
    }
}

function nonEmpty(record: Record<string, number>): Record<string, number> | undefined {
    return Object.keys(record).length ? record : undefined;
}

/** Can this model do the role at all? Unknown capabilities count as "maybe". */
function fits(role: Role, m: ModelInfo): boolean {
    if (role === 'embedder') return m.supports.embeddings === true;
    if (m.supports.embeddings === true && m.supports.tools !== true) return false; // an embedding-only model
    if (role === 'chat') return m.supports.tools !== false;
    return true;
}

/** Among fitting models: confirmed capabilities first, then the larger context window, then list order. */
function best(role: Role, models: ModelInfo[]): ModelInfo {
    const score = (m: ModelInfo) =>
        (role === 'chat' && m.supports.tools === true ? 2 : 0) + (role === 'summarizer' && m.supports.jsonSchema === true ? 1 : 0);
    return models.reduce((a, b) => {
        const d = score(b) - score(a);
        if (d !== 0) return d > 0 ? b : a;
        return (b.contextWindow ?? 0) > (a.contextWindow ?? 0) ? b : a;
    });
}
