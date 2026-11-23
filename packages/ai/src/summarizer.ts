/**
 * Bottom-up summarization of the hierarchy:
 *
 *   symbols     no AI (name, signature, doc)
 *   module      Summarizer role: one file's facts
 *   component   Summarizer role: child cards + the dependencies between them
 *   package     Architect role: the same, one level up
 *   system      Architect role
 *
 * Each prompt is bounded by fan-out, never by repository size. Cards are
 * cached by a hash of exactly what the model is shown, so an edit
 * re-summarizes only the path from the changed file to the root.
 *
 * AI upgrades cards and never blocks on them: when no model is available, a
 * request is blocked (privacy tier, budget) or the reply is unusable, the
 * node gets its deterministic card instead.
 */
import { contentHash, type HierarchyIndex } from '@codearchy/core';
import type { HierarchyNode } from '@codearchy/protocol';
import { estimateRun, estimateTokens, type ChatEvent, type ChatMessage, type ProviderRegistry, type RunEstimate, type SignalLike } from '@codearchy/providers';
import { CARD_SCHEMA, CardFormatError, extractJson, validate, type Card, type CardDraft } from './card.js';
import { containerFacts, manifestDescription, moduleFacts, readmeSummary, type Prepared } from './facts.js';
import { maxOutput, promptVersion, renderFacts, systemPrompt } from './prompts.js';

/** Where cards are kept between sessions (host-provided; memory by default). */
export interface CardStore {
    /** The card for exactly these inputs, if one was made before. */
    get(inputHash: string): Promise<Card | undefined>;
    /** The newest card for a node, whatever its inputs (for showing something while a fresh one is made). */
    latest(key: string): Promise<Card | undefined>;
    put(card: Card): Promise<void>;
}

export class MemoryCardStore implements CardStore {
    private readonly byHash = new Map<string, Card>();
    private readonly byKey = new Map<string, Card>();
    async get(inputHash: string) {
        return this.byHash.get(inputHash);
    }
    async latest(key: string) {
        return this.byKey.get(key);
    }
    async put(card: Card) {
        this.byHash.set(card.inputHash, card);
        this.byKey.set(card.key, card);
    }
}

export interface SummarizerOptions {
    index: HierarchyIndex;
    /** Reads a workspace file; resolves undefined when it doesn't exist. */
    readFile: (path: string) => Promise<string | undefined>;
    /** Without a registry, every card is deterministic. */
    registry?: ProviderRegistry;
    store?: CardStore;
    /**
     * AI calls in flight at once. Default 4. A token budget is checked before
     * each call, so calls already in flight can take usage a little past it.
     */
    concurrency?: number;
    now?: () => number;
}

export interface CrawlOptions {
    signal?: SignalLike;
    /** Stop making AI calls after this many (the rest get deterministic cards). */
    maxCalls?: number;
    /** Called as each card is ready (children before parents). */
    onCard?: (card: Card) => void;
}

export interface CrawlResult {
    cards: number;
    aiCards: number;
    calls: number;
    /** Set when the crawl stopped calling the model early: a budget, the privacy tier, maxCalls, or cancellation. */
    stopped?: string;
}

/** Per-run state: shared limits for one crawl or one card() call. */
interface Run {
    signal?: SignalLike;
    maxCalls: number;
    calls: number;
    stopped?: string;
    onCard?: (card: Card) => void;
}

const CONTAINER_DOCS = ['README.md', 'README', 'readme.md', 'Readme.md'];
const MANIFESTS = ['package.json', 'composer.json', 'pyproject.toml', 'Cargo.toml'];

export class Summarizer {
    private readonly index: HierarchyIndex;
    private readonly store: CardStore;
    private readonly now: () => number;
    private readonly inflight = new Map<string, Promise<{ card: Card; final: boolean }>>();
    private readonly gate: Gate;

    constructor(private readonly options: SummarizerOptions) {
        this.index = options.index;
        this.store = options.store ?? new MemoryCardStore();
        this.now = options.now ?? Date.now;
        this.gate = new Gate(Math.max(1, options.concurrency ?? 4));
    }

    /** The card for one node (modules and up), summarizing its subtree first as needed. */
    async card(key: string, options: { signal?: SignalLike } = {}): Promise<Card> {
        return (await this.cardIn(key, { signal: options.signal, maxCalls: Infinity, calls: 0 })).card;
    }

    /** Summarizes the given nodes (and their subtrees), most important first. */
    async crawl(keys: string[], options: CrawlOptions = {}): Promise<CrawlResult> {
        const run: Run = { signal: options.signal, maxCalls: options.maxCalls ?? Infinity, calls: 0, onCard: options.onCard };
        let cards = 0;
        let aiCards = 0;
        const seen = new Set<string>();
        const count = (card: Card) => {
            if (seen.has(card.key)) return;
            seen.add(card.key);
            cards++;
            if (card.source === 'ai') aiCards++;
            options.onCard?.(card);
        };
        run.onCard = count;
        for (const key of keys) {
            if (options.signal?.aborted) {
                run.stopped ??= 'Cancelled';
                break;
            }
            await this.cardIn(key, run);
        }
        return { cards, aiCards, calls: run.calls, ...(run.stopped ? { stopped: run.stopped } : {}) };
    }

    /** The newest stored card for a node, without making one. */
    latest(key: string): Promise<Card | undefined> {
        return this.store.latest(key);
    }

    /** Roughly what summarizing a subtree would take: nodes without an AI card, as calls and tokens. */
    async estimate(key: string): Promise<RunEstimate & { nodes: number; uncached: number }> {
        const i = this.index.indexOf(key);
        if (i === undefined) throw new Error(`Unknown node ${key}`);
        const nodes = this.index.hierarchy.nodes;
        const root = nodes[i]!;
        const calls: Array<{ input: number; maxOutput: number }> = [];
        let total = 0;
        for (let j = root.tin; j <= root.tout; j++) {
            const n = nodes[j]!;
            if (n.kind === 'symbol') continue;
            total++;
            const latest = await this.store.latest(n.key);
            if (latest?.source === 'ai') continue;
            if (n.kind === 'module') {
                const symbols = Math.min(30, n.tout - n.tin);
                calls.push({ input: 350 + 35 * symbols, maxOutput: 500 });
            } else {
                const children = Math.min(30, this.index.childrenOf(j).length);
                calls.push({ input: 450 + 70 * children, maxOutput: 700 });
            }
        }
        return { ...estimateRun(calls), nodes: total, uncached: calls.length };
    }

    // ── internals ──────────────────────────────────────────────────────────

    /** Memoised per node; a result that wasn't final (a fallback after a failure or a limit) can be retried later. */
    private cardIn(key: string, run: Run): Promise<{ card: Card; final: boolean }> {
        const existing = this.inflight.get(key);
        if (existing) return existing.then((r) => (run.onCard?.(r.card), r));
        const promise = this.build(key, run);
        this.inflight.set(key, promise);
        void promise.then(
            (r) => {
                if (!r.final) this.inflight.delete(key);
            },
            () => this.inflight.delete(key),
        );
        return promise.then((r) => (run.onCard?.(r.card), r));
    }

    private async build(key: string, run: Run): Promise<{ card: Card; final: boolean }> {
        const i = this.index.indexOf(key);
        if (i === undefined) throw new Error(`Unknown node ${key}`);
        const node = this.index.hierarchy.nodes[i]!;
        if (node.kind === 'symbol') throw new Error('Symbols have no cards: their name, signature and doc are shown as they are');

        let prepared: Prepared;
        let childrenFinal = true;
        if (node.kind === 'module') {
            prepared = moduleFacts(this.index, i, await this.read(node.path));
        } else {
            const kids = this.index.childrenOf(i).map((c) => this.index.hierarchy.nodes[c]!);
            const results = await Promise.all(kids.map((k) => this.cardIn(k.key, run)));
            childrenFinal = results.every((r) => r.final);
            const cards = new Map(results.map((r) => [r.card.key, r.card]));
            prepared = containerFacts(this.index, i, cards, await this.containerDoc(node));
        }

        const role = node.kind === 'module' || node.kind === 'component' ? 'summarizer' : 'architect';
        const target = this.options.registry?.resolve(role);
        const version = promptVersion(prepared.facts);
        const modelTag = target?.ok ? `${target.provider}/${target.model}` : 'none';
        const inputHash = contentHash(JSON.stringify({ v: version, model: modelTag, facts: prepared.facts }));

        const cached = await this.store.get(inputHash);
        if (cached) return { card: cached, final: childrenFinal };

        const deterministic = (note?: string): Card =>
            this.makeCard(node, prepared.deterministic, { source: 'deterministic', version, inputHash, note });

        if (!target?.ok) {
            // No AI configured (or none allowed): the deterministic card is the answer for these inputs.
            const card = deterministic(target ? target.reason : undefined);
            await this.store.put(card);
            return { card, final: childrenFinal };
        }
        if (run.stopped || run.calls >= run.maxCalls || run.signal?.aborted) {
            if (run.calls >= run.maxCalls) run.stopped ??= `Stopped after ${run.maxCalls} AI calls`;
            if (run.signal?.aborted) run.stopped ??= 'Cancelled';
            return { card: deterministic(run.stopped), final: false };
        }

        const outcome = await this.gate.run(() => this.generate(prepared, role, key, run));
        if (!outcome.ok) {
            if (outcome.blocked) run.stopped ??= outcome.reason;
            return { card: deterministic(outcome.reason), final: false };
        }
        const card = this.makeCard(node, outcome.draft, {
            source: 'ai',
            version,
            inputHash,
            provider: target.provider,
            model: target.model,
        });
        await this.store.put(card);
        return { card, final: childrenFinal };
    }

    /** One AI card: a request, and one repair attempt if the reply doesn't fit the schema. */
    private async generate(
        prepared: Prepared,
        role: 'summarizer' | 'architect',
        key: string,
        run: Run,
    ): Promise<{ ok: true; draft: CardDraft } | { ok: false; reason: string; blocked?: boolean }> {
        const registry = this.options.registry!;
        const messages: ChatMessage[] = [{ role: 'user', content: renderFacts(prepared.facts) }];
        for (let attempt = 0; attempt < 2; attempt++) {
            if (run.calls >= run.maxCalls) return { ok: false, reason: `Stopped after ${run.maxCalls} AI calls`, blocked: true };
            run.calls++;
            let text = '';
            let done: Extract<ChatEvent, { type: 'done' }> | undefined;
            for await (const event of registry.chat(
                role,
                {
                    system: systemPrompt(prepared.facts),
                    messages,
                    json: { schema: CARD_SCHEMA, name: 'card' },
                    maxOutputTokens: maxOutput(prepared.facts),
                    temperature: 0.2,
                },
                { contains: ['structure'], nodes: [key], signal: run.signal },
            )) {
                if (event.type === 'text') text += event.delta;
                else if (event.type === 'restart') text = '';
                else if (event.type === 'done') done = event;
                else if (event.type === 'error') {
                    const blocked = event.error.code === 'policy' || event.error.code === 'quota' || event.error.code === 'auth' || event.error.code === 'cancelled';
                    return { ok: false, reason: event.error.message, blocked };
                }
            }
            if (!done) return { ok: false, reason: 'The model stopped without finishing' };
            if (done.stopReason === 'refusal') return { ok: false, reason: 'The model declined to summarize this part' };
            const reply = done.turn.content || text;
            try {
                const { draft } = validate(extractJson(reply), prepared.refs, prepared.labels);
                return { ok: true, draft };
            } catch (err) {
                if (!(err instanceof CardFormatError) || attempt === 1) {
                    return { ok: false, reason: `The model's reply couldn't be used (${err instanceof Error ? err.message : String(err)})` };
                }
                messages.push(
                    { role: 'assistant', content: reply, toolCalls: [], ...(done.turn.replay ? { replay: done.turn.replay } : {}) },
                    { role: 'user', content: `That reply wasn't usable: ${err.message}. Reply with only the JSON object, matching the schema.` },
                );
            }
        }
        return { ok: false, reason: "The model's reply couldn't be used" };
    }

    private makeCard(
        node: HierarchyNode,
        draft: CardDraft,
        meta: { source: Card['source']; version: string; inputHash: string; provider?: string; model?: string; note?: string },
    ): Card {
        const content = { title: draft.title, purpose: draft.purpose, responsibilities: draft.responsibilities, keyNodes: draft.keyNodes, risks: draft.risks };
        return {
            key: node.key,
            kind: node.kind,
            ...content,
            confidence: Math.round(draft.confidence * 100) / 100,
            source: meta.source,
            ...(meta.provider ? { provider: meta.provider, model: meta.model } : {}),
            promptVersion: meta.version,
            inputHash: meta.inputHash,
            hash: contentHash(JSON.stringify(content)),
            createdAt: this.now(),
            ...(meta.note ? { note: meta.note } : {}),
        };
    }

    private async read(path: string): Promise<string | undefined> {
        try {
            return await this.options.readFile(path);
        } catch {
            return undefined;
        }
    }

    /** A README's first paragraph, else (for packages and the system) the manifest's description. */
    private async containerDoc(node: HierarchyNode): Promise<string | undefined> {
        if (node.virtual) return undefined; // a clustered group has no folder of its own
        const at = (file: string) => (node.path ? `${node.path}/${file}` : file);
        for (const f of CONTAINER_DOCS) {
            const text = await this.read(at(f));
            const summary = text ? readmeSummary(text) : undefined;
            if (summary) return summary;
        }
        if (node.kind === 'package' || node.kind === 'system') {
            for (const f of MANIFESTS) {
                const text = await this.read(at(f));
                const d = text ? manifestDescription(f, text) : undefined;
                if (d) return d;
            }
        }
        return undefined;
    }
}

/** A tiny semaphore for AI calls. */
class Gate {
    private active = 0;
    private readonly waiting: Array<() => void> = [];
    constructor(private readonly limit: number) {}

    async run<T>(task: () => Promise<T>): Promise<T> {
        if (this.active >= this.limit) await new Promise<void>((r) => this.waiting.push(r));
        else this.active++;
        try {
            return await task();
        } finally {
            const next = this.waiting.shift();
            if (next) next();
            else this.active--;
        }
    }
}

/** Rough size of a prompt, for callers that want to show it. */
export function promptTokens(prepared: Prepared): number {
    return estimateTokens(systemPrompt(prepared.facts) + renderFacts(prepared.facts));
}
