/**
 * Token budgets per provider (daily and monthly hard caps), and estimates for
 * the "before a large run" prompt.
 *
 * Prices are never built in: they change. Callers pass the user's own figures
 * when they want a cost; otherwise estimates are in tokens.
 */

export interface BudgetLimits {
    tokensPerDay?: number;
    tokensPerMonth?: number;
}

/** Where usage counters live (host-provided; memory by default). */
export interface UsageStore {
    get(key: string): Promise<number | undefined>;
    set(key: string, value: number): Promise<void>;
}

export class MemoryUsageStore implements UsageStore {
    private readonly values = new Map<string, number>();
    async get(key: string) {
        return this.values.get(key);
    }
    async set(key: string, value: number) {
        this.values.set(key, value);
    }
}

export interface BudgetStatus {
    ok: boolean;
    reason?: string;
    usedToday: number;
    usedThisMonth: number;
    limits: BudgetLimits;
}

export class Budget {
    constructor(
        private readonly limits: Readonly<Record<string, BudgetLimits>>,
        private readonly store: UsageStore = new MemoryUsageStore(),
        private readonly now: () => number = Date.now,
    ) {}

    private keys(provider: string) {
        const iso = new Date(this.now()).toISOString(); // UTC, so a day is the same everywhere
        return { day: `usage:${provider}:day:${iso.slice(0, 10)}`, month: `usage:${provider}:month:${iso.slice(0, 7)}` };
    }

    async status(provider: string): Promise<BudgetStatus> {
        const limits = this.limits[provider] ?? {};
        const k = this.keys(provider);
        const usedToday = (await this.store.get(k.day)) ?? 0;
        const usedThisMonth = (await this.store.get(k.month)) ?? 0;
        let reason: string | undefined;
        if (limits.tokensPerDay !== undefined && usedToday >= limits.tokensPerDay) {
            reason = `The daily budget for ${provider} (${limits.tokensPerDay.toLocaleString('en')} tokens) is used up`;
        } else if (limits.tokensPerMonth !== undefined && usedThisMonth >= limits.tokensPerMonth) {
            reason = `The monthly budget for ${provider} (${limits.tokensPerMonth.toLocaleString('en')} tokens) is used up`;
        }
        return { ok: !reason, reason, usedToday, usedThisMonth, limits };
    }

    async add(provider: string, tokens: number): Promise<void> {
        if (!(tokens > 0)) return;
        const k = this.keys(provider);
        await this.store.set(k.day, ((await this.store.get(k.day)) ?? 0) + tokens);
        await this.store.set(k.month, ((await this.store.get(k.month)) ?? 0) + tokens);
    }
}

/**
 * A rough token count: about four characters per token for English and code.
 * Good enough for budgets and "≈" estimates; not for billing.
 */
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

export interface Price {
    /** Currency units per million input tokens. */
    inputPer1M: number;
    /** Currency units per million output tokens. */
    outputPer1M: number;
}

export interface RunEstimate {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    /** Only when a price was given. */
    cost?: number;
}

/** Estimates a batch of calls (e.g. a summarization run) from prompt sizes and output caps. */
export function estimateRun(calls: ReadonlyArray<{ input: string | number; maxOutput: number }>, price?: Price): RunEstimate {
    let inputTokens = 0;
    let outputTokens = 0;
    for (const c of calls) {
        inputTokens += typeof c.input === 'number' ? c.input : estimateTokens(c.input);
        outputTokens += c.maxOutput;
    }
    const estimate: RunEstimate = { calls: calls.length, inputTokens, outputTokens };
    if (price) estimate.cost = (inputTokens / 1e6) * price.inputPer1M + (outputTokens / 1e6) * price.outputPer1M;
    return estimate;
}
