/**
 * Grounded chat: questions about the codebase, answered from the index with
 * citations.
 *
 *   tools mode  the chat model looks things up itself (search, get_node,
 *               neighbors, explain_edge, read_code, show_in_map), at most
 *               `maxRounds` rounds, with a status line for each lookup
 *   RAG mode    for models without tool calling: the best search hits and
 *               their cards are packed into the prompt
 *
 * The system prompt holds only stable text (rules, the system card and the
 * top-level parts), so providers with prompt caching reuse it; the selection
 * and the question go in the user turn. Code is only ever read when the
 * privacy tier lets excerpts reach the chat model, and once it has been read,
 * later requests declare it. The answer's links are checked against the index
 * before it's handed over.
 */
import type { HierarchyIndex } from '@codearchy/core';
import { ProviderError, type AssistantTurn, type ChatMessage, type ContentKind, type ProviderRegistry, type SignalLike, type Usage } from '@codearchy/providers';
import type { Card } from './card.js';
import { checkCitations, type Citation } from './citations.js';
import { signature, symbolDoc } from './docs.js';
import { ROLE_LABEL } from './facts.js';
import { NodeSearch } from './search.js';
import { runTool, TOOL_SPECS, ToolArgumentError, toolStatus, type CanvasAction, type ToolContext } from './tools.js';

export interface GroundedChatOptions {
    index: HierarchyIndex;
    readFile: (path: string) => Promise<string | undefined>;
    registry: ProviderRegistry;
    /** The newest card for a node (e.g. `summarizer.latest`). Without it, answers rest on names and structure. */
    cards?: (key: string) => Promise<Card | undefined>;
    /** A prebuilt search (e.g. one that includes card text). */
    search?: NodeSearch;
    /** Tool rounds before the model must answer. Default 8. */
    maxRounds?: number;
}

export interface AskOptions {
    /** The conversation so far (from the previous `done` event's `history`). */
    history?: ChatMessage[];
    /** The node selected in the map ("Ask about this"). */
    selection?: string;
    signal?: SignalLike;
}

export type ChatStreamEvent =
    | { type: 'status'; text: string }
    | { type: 'text'; delta: string }
    /** Discard text streamed so far in this round (a provider fallback took over). */
    | { type: 'restart' }
    | { type: 'action'; action: CanvasAction }
    | {
          type: 'done';
          /** The final answer, with links the index doesn't know turned into plain text. */
          answer: string;
          citations: Citation[];
          invalidCitations: number;
          /** Inline-code names the check turned into links. */
          autoLinked: number;
          actions: CanvasAction[];
          /** Pass back as `history` to continue the conversation. */
          history: ChatMessage[];
          mode: 'tools' | 'rag';
          rounds: number;
          usage: Usage;
          provider: string;
          model: string;
      }
    | { type: 'error'; error: ProviderError };

const RULES = `Rules:
- Answer only from the context and tool results. If you can't find something, say so plainly; never guess file names, functions or behaviour.
- Cite what you rely on with markdown links, using keys and paths exactly as given:
  parts of the map: [Name](node:<key>)      lines of code: [file.ts:42](file:<path>#L42) or #L10-L20
- Lead with the answer, then the evidence. Keep it short; use a list when comparing several parts.`;

const TOOLS_HELP = `Look things up with the tools before answering: start from the possibly relevant parts listed with the question (or search), then get_node, neighbors or explain_edge on their keys. Never say you can't find something until you've searched for it. Call show_in_map when a view of the map would help the user see your answer.`;
const READ_HELP = ` read_code shows source lines when the summaries don't settle a detail; read only what you need.`;

export class GroundedChat {
    private readonly search: NodeSearch;
    private readonly maxRounds: number;
    private readonly cardFor: (key: string) => Promise<Card | undefined>;

    constructor(private readonly options: GroundedChatOptions) {
        this.search = options.search ?? new NodeSearch(options.index);
        this.maxRounds = Math.max(1, options.maxRounds ?? 8);
        // Cards are optional context: a missing or failing lookup (or a symbol, which has none) is just "no card".
        const lookup = options.cards;
        this.cardFor = async (key) => {
            if (!lookup || options.index.node(key)?.kind === 'symbol') return undefined;
            try {
                return await lookup(key);
            } catch {
                return undefined;
            }
        };
    }

    async *ask(question: string, options: AskOptions = {}): AsyncGenerator<ChatStreamEvent> {
        const { registry, index } = this.options;
        const target = registry.resolve('chat');
        if (!target.ok) {
            yield { type: 'error', error: new ProviderError('policy', 'none', target.reason) };
            return;
        }
        const snapshot = registry.providers().find((p) => p.id === target.provider);
        const allowCode = !!snapshot?.onDevice || registry.policy.tier === 'excerpts';
        const mode: 'tools' | 'rag' = target.info?.supports.tools === false ? 'rag' : 'tools';
        const tools = mode === 'tools' ? Object.values(TOOL_SPECS).filter((t) => t.name !== 'read_code' || allowCode) : undefined;

        const system = await this.systemPrompt(mode, allowCode);
        const messages: ChatMessage[] = [...(options.history ?? []), { role: 'user', content: await this.userTurn(question, options.selection, mode) }];
        const ctx: ToolContext = {
            index,
            search: this.search,
            readFile: this.options.readFile,
            cardFor: this.cardFor,
            linesRead: 0,
            touched: new Set(options.selection && index.node(options.selection) ? [options.selection] : []),
            actions: [],
        };
        const usage: Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
        let codeRead = false;
        let answer = '';

        for (let round = 0; round <= this.maxRounds; round++) {
            const last = round === this.maxRounds;
            if (last && tools) messages.push({ role: 'user', content: 'Answer now from what you have found; no more lookups.' });
            const contains: ContentKind[] = codeRead ? ['structure', 'excerpts'] : ['structure'];
            let turn: AssistantTurn | undefined;
            for await (const event of registry.chat(
                'chat',
                { system, messages, ...(tools ? { tools, toolChoice: last ? 'none' : 'auto' } : {}), maxOutputTokens: 4000 },
                { contains, nodes: [...ctx.touched], signal: options.signal },
            )) {
                if (event.type === 'text') yield { type: 'text', delta: event.delta };
                else if (event.type === 'restart') yield { type: 'restart' };
                else if (event.type === 'usage') {
                    usage.inputTokens += event.usage.inputTokens;
                    usage.outputTokens += event.usage.outputTokens;
                    usage.cachedInputTokens = (usage.cachedInputTokens ?? 0) + (event.usage.cachedInputTokens ?? 0);
                } else if (event.type === 'error') {
                    yield { type: 'error', error: event.error };
                    return;
                } else if (event.type === 'done') turn = event.turn;
            }
            if (!turn) {
                yield { type: 'error', error: new ProviderError('invalid_response', target.provider, 'The model stopped without finishing') };
                return;
            }
            messages.push({ role: 'assistant', content: turn.content, toolCalls: turn.toolCalls, ...(turn.replay ? { replay: turn.replay } : {}) });
            answer = turn.content;
            if (!turn.toolCalls.length || last) {
                const checked = checkCitations(answer, index);
                yield {
                    type: 'done',
                    answer: checked.answer,
                    citations: checked.citations,
                    invalidCitations: checked.invalid,
                    autoLinked: checked.autoLinked,
                    actions: ctx.actions,
                    history: messages,
                    mode,
                    rounds: round + 1,
                    usage,
                    provider: target.provider,
                    model: target.model,
                };
                return;
            }

            for (const call of turn.toolCalls) {
                yield { type: 'status', text: toolStatus(call.name, call.args, index) };
                const before = ctx.actions.length;
                let content: string;
                let isError = false;
                try {
                    content = await runTool(call.name, call.args, ctx, allowCode);
                    if (call.name === 'read_code') codeRead = true;
                } catch (err) {
                    isError = true;
                    content = JSON.stringify({ error: err instanceof ToolArgumentError ? err.message : 'The tool failed' });
                }
                messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content, ...(isError ? { isError: true } : {}) });
                for (const action of ctx.actions.slice(before)) yield { type: 'action', action };
            }
        }
    }

    /** Stable text: rules, plus the system card and the top-level parts. */
    private async systemPrompt(mode: 'tools' | 'rag', allowCode: boolean): Promise<string> {
        const { index } = this.options;
        const root = index.hierarchy.nodes[0]!;
        const rootCard = await this.cardFor(root.key);
        const top = index.childrenOf(0).map((i) => index.hierarchy.nodes[i]!);
        const lines = [
            `You answer questions about the codebase "${root.name}" for an engineer, using CodeArchy's map of it: a hierarchy of system › packages › components › files › symbols, with dependencies between them.`,
            '',
            RULES,
            ...(mode === 'tools' ? ['', TOOLS_HELP + (allowCode ? READ_HELP : ' Source code is not available to you under the current privacy settings; work from names, signatures, docs and summaries.')] : []),
            '',
            `The system (node:${root.key}): ${rootCard ? `${rootCard.title}. ${rootCard.purpose}` : `${root.modules} files.`}`,
            'Top-level parts:',
        ];
        for (const n of top.slice(0, 40)) {
            const card = await this.cardFor(n.key);
            const role = n.role ? `, ${ROLE_LABEL[n.role.role]}` : '';
            lines.push(`- ${n.name} (${n.kind}, ${n.modules} files${role}) key ${n.key}${card ? `: ${card.purpose}` : ''}`);
        }
        if (top.length > 40) lines.push(`- …and ${top.length - 40} more`);
        return lines.join('\n');
    }

    /** The question, with the map selection and (in RAG mode) the retrieved context. */
    private async userTurn(question: string, selection: string | undefined, mode: 'tools' | 'rag'): Promise<string> {
        const { index } = this.options;
        const parts: string[] = [];
        const selected = selection ? index.node(selection) : undefined;
        if (selected) {
            const card = await this.cardFor(selected.key);
            parts.push(`Selected in the map: ${selected.name} (${selected.kind}, key ${selected.key}${selected.path ? `, ${selected.path}` : ''})${card ? ` — ${card.purpose}` : ''}`);
        }
        // Both modes start from a search of the question: RAG answers from it, and in tools mode it gives
        // the model somewhere to start (smaller models otherwise tend to answer without looking).
        {
            const hits = this.search.search(question, { limit: mode === 'rag' ? 8 : 5 });
            if (hits.length) {
                parts.push(mode === 'rag' ? 'Context from the map:' : 'Possibly relevant parts (from a search of the question):');
                const files = new Map<string, Promise<string[] | undefined>>();
                const linesOf = (path: string) => {
                    if (!files.has(path)) files.set(path, this.options.readFile(path).then((t) => t?.split('\n'), () => undefined));
                    return files.get(path)!;
                };
                for (const h of hits) {
                    if (h.kind === 'symbol') {
                        // A symbol: where it lives, its declaration and its doc (names and signatures only).
                        const n = index.node(h.key)!;
                        const lines = await linesOf(n.path);
                        const sig = lines && n.startLine !== undefined ? signature(lines, n.startLine, n.endLine ?? n.startLine) : undefined;
                        const doc = lines && n.startLine !== undefined ? symbolDoc(lines, n.startLine) : undefined;
                        parts.push(
                            [
                                `- ${h.name} (${n.symbolKind ?? 'symbol'} in file key mod:${n.path}, line ${(n.startLine ?? 0) + 1}) key ${h.key}`,
                                sig ? `  declared as: ${sig}` : undefined,
                                doc ? `  doc: ${doc}` : undefined,
                            ]
                                .filter(Boolean)
                                .join('\n'),
                        );
                        continue;
                    }
                    const card = await this.cardFor(h.key);
                    const details = index.describe(h.key);
                    const deps = details?.dependsOn.slice(0, 4).map((l) => l.name).join(', ');
                    const users = details?.usedBy.slice(0, 4).map((l) => l.name).join(', ');
                    const symbols = h.kind === 'module' ? details?.symbols.filter((s) => s.depth === 0).slice(0, 8).map((s) => s.name).join(', ') : undefined;
                    parts.push(
                        [
                            `- ${h.name} (${h.kind}) key ${h.key}${h.path ? ` path ${h.path}` : ''}`,
                            card ? `  summary: ${card.purpose}` : undefined,
                            symbols ? `  declares: ${symbols}` : undefined,
                            deps ? `  depends on: ${deps}` : undefined,
                            users ? `  used by: ${users}` : undefined,
                        ]
                            .filter(Boolean)
                            .join('\n'),
                    );
                }
            } else if (mode === 'rag') {
                parts.push('Context from the map: nothing matched the question.');
            }
        }
        parts.push(`Question: ${question}`);
        return parts.join('\n\n');
    }
}
