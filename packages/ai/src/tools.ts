/**
 * The tools grounded chat gives the model (the same set the MCP server will
 * expose). Each validates its arguments, returns compact JSON, and caps what
 * it returns, so one call can't flood the context.
 */
import type { HierarchyIndex } from '@codearchy/core';
import type { EntryPointKind, Flow, FlowSummary, HierarchyKind } from '@codearchy/protocol';
import type { ToolSpec } from '@codearchy/providers';
import type { Card } from './card.js';
import { signature, symbolDoc } from './docs.js';
import type { NodeSearch } from './search.js';

export const READ_CODE_MAX_LINES = 120;
/** Across one conversation, so a model can't page through the codebase. */
export const READ_CODE_BUDGET = 600;

export type CanvasAction = { action: 'focus' | 'highlight'; keys: string[] };

/** Entrypoints and their traces (core's FlowIndex, or a host's equivalent). */
export interface FlowSource {
    list(): FlowSummary[];
    trace(id: string): Flow | undefined;
}

const FLOW_KINDS: EntryPointKind[] = ['http', 'ui', 'cli', 'event', 'job', 'main'];
const FLOW_LIST_LIMIT = 20;
const FLOW_STEP_LIMIT = 40;

export interface ToolContext {
    index: HierarchyIndex;
    search: NodeSearch;
    readFile: (path: string) => Promise<string | undefined>;
    cardFor: (key: string) => Promise<Card | undefined>;
    /** Lines of code read so far in this conversation. */
    linesRead: number;
    /** Node keys the answer has touched (for the audit log). */
    touched: Set<string>;
    actions: CanvasAction[];
    /** Entrypoints and flows; without it, find_flows isn't offered. */
    flows?: FlowSource;
}

export class ToolArgumentError extends Error {}

const KINDS: HierarchyKind[] = ['package', 'component', 'module', 'symbol'];

export const TOOL_SPECS: Record<string, ToolSpec> = {
    search: {
        name: 'search',
        description: 'Find parts of the codebase by name, path or summary. Returns node keys to pass to the other tools.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Words to look for, e.g. "auth session"' },
                kind: { type: 'string', enum: KINDS, description: 'Only this kind of node' },
            },
            required: ['query'],
        },
    },
    get_node: {
        name: 'get_node',
        description: "One node's summary card, children, symbols (for a file) and strongest dependencies either way.",
        parameters: { type: 'object', properties: { key: { type: 'string', description: 'A node key from another tool' } }, required: ['key'] },
    },
    neighbors: {
        name: 'neighbors',
        description: 'What a node depends on ("out") or what depends on it ("in"), with weights. depth 2 follows one more step.',
        parameters: {
            type: 'object',
            properties: {
                key: { type: 'string' },
                direction: { type: 'string', enum: ['in', 'out', 'both'] },
                depth: { type: 'integer', minimum: 1, maximum: 2 },
            },
            required: ['key'],
        },
    },
    explain_edge: {
        name: 'explain_edge',
        description: 'The file-level dependencies and import sites behind a dependency from one node to another.',
        parameters: { type: 'object', properties: { source: { type: 'string' }, target: { type: 'string' } }, required: ['source', 'target'] },
    },
    read_code: {
        name: 'read_code',
        description: `Read lines of an indexed source file (1-based, at most ${READ_CODE_MAX_LINES} lines per call). Use it to confirm details the summaries don't settle.`,
        parameters: {
            type: 'object',
            properties: { path: { type: 'string' }, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 } },
            required: ['path', 'startLine', 'endLine'],
        },
    },
    find_flows: {
        name: 'find_flows',
        description:
            'Entrypoints (HTTP routes, CLI commands, jobs and listeners, UI routes, main) and what each does. Without id: the entrypoints matching query or kind. With id: that flow traced: the calls in order (each with the step that called it), the parts it passes through, and what it reaches (databases, HTTP APIs, queues). Use it for "what happens when…" questions.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Words in the route, command or file, e.g. "login" or "POST orders"' },
                kind: { type: 'string', enum: FLOW_KINDS },
                id: { type: 'string', description: 'A flow id from a previous find_flows call: trace it' },
            },
        },
    },
    show_in_map: {
        name: 'show_in_map',
        description: 'Offer the user a button that shows these nodes on the map ("focus" one area, or "highlight" several).',
        parameters: {
            type: 'object',
            properties: { keys: { type: 'array', items: { type: 'string' } }, mode: { type: 'string', enum: ['focus', 'highlight'] } },
            required: ['keys'],
        },
    },
};

const str = (args: Record<string, unknown>, name: string, required = true): string | undefined => {
    const v = args[name];
    if (v === undefined && !required) return undefined;
    if (typeof v !== 'string' || !v.trim()) throw new ToolArgumentError(`"${name}" must be a non-empty string`);
    return v.trim();
};
const int = (args: Record<string, unknown>, name: string, fallback?: number): number => {
    const v = args[name];
    if (v === undefined && fallback !== undefined) return fallback;
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isInteger(n)) throw new ToolArgumentError(`"${name}" must be a whole number`);
    return n;
};

/** A short human-readable line for the UI while the tool runs. */
export function toolStatus(name: string, args: Record<string, unknown>, index: HierarchyIndex): string {
    const nodeName = (k: unknown) => (typeof k === 'string' ? index.node(k)?.name ?? k : '?');
    switch (name) {
        case 'search':
            return `Searching for "${String(args.query ?? '')}"…`;
        case 'get_node':
            return `Looking at ${nodeName(args.key)}…`;
        case 'neighbors':
            return `Following the dependencies of ${nodeName(args.key)}…`;
        case 'explain_edge':
            return `Checking how ${nodeName(args.source)} uses ${nodeName(args.target)}…`;
        case 'read_code':
            return `Reading ${String(args.path ?? '')}:${String(args.startLine ?? '')}–${String(args.endLine ?? '')}…`;
        case 'find_flows':
            return typeof args.id === 'string' ? `Tracing ${args.id.split('#').pop()?.replace(/^\w+:/, '') ?? 'the flow'}…` : `Looking for entrypoints${typeof args.query === 'string' && args.query.trim() ? ` matching "${args.query.trim()}"` : ''}…`;
        case 'show_in_map':
            return 'Preparing a view of the map…';
        default:
            return `Running ${name}…`;
    }
}

/** Runs one tool call; returns its JSON result. Throws ToolArgumentError for bad arguments or unknown nodes. */
export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext, allowCode: boolean): Promise<string> {
    const { index } = ctx;
    const node = (key: string) => {
        const n = index.node(key);
        if (!n) throw new ToolArgumentError(`No node "${key}". Use search to find keys.`);
        ctx.touched.add(key);
        return n;
    };
    const brief = (key: string) => {
        const n = index.node(key)!;
        return { key, kind: n.kind, name: n.name, ...(n.path ? { path: n.path } : {}) };
    };

    switch (name) {
        case 'search': {
            const kind = str(args, 'kind', false) as HierarchyKind | undefined;
            if (kind && !KINDS.includes(kind)) throw new ToolArgumentError(`"kind" must be one of ${KINDS.join(', ')}`);
            const hits = ctx.search.search(str(args, 'query')!, { kinds: kind ? [kind] : undefined, limit: 10 });
            const results = await Promise.all(
                hits.map(async (h) => {
                    const card = await ctx.cardFor(h.key);
                    return { ...brief(h.key), ...(card ? { summary: card.purpose } : {}) };
                }),
            );
            return JSON.stringify({ results });
        }
        case 'get_node': {
            const key = str(args, 'key')!;
            const n = node(key);
            const details = index.describe(key)!;
            const card = await ctx.cardFor(key);
            const out: Record<string, unknown> = {
                ...brief(key),
                modules: n.modules,
                ...(n.role ? { role: n.role.role } : {}),
                ...(card ? { card: { title: card.title, purpose: card.purpose, responsibilities: card.responsibilities, risks: card.risks, source: card.source } } : {}),
                breadcrumb: details.breadcrumb.map((b) => b.name).join(' › '),
            };
            if (n.kind === 'module') {
                const text = await ctx.readFile(n.path).catch(() => undefined);
                const lines = text?.split('\n');
                out.symbols = details.symbols.slice(0, 40).map((s) => ({
                    key: s.key,
                    name: s.name,
                    kind: s.kind,
                    line: s.startLine + 1,
                    ...(s.exported ? { exported: true } : {}),
                    ...(lines ? { signature: signature(lines, s.startLine, s.endLine), doc: symbolDoc(lines, s.startLine) } : {}),
                }));
                if (details.testedBy?.length) out.testedBy = details.testedBy.slice(0, 10);
                if (details.cycleWith?.length) out.cycleWith = details.cycleWith.slice(0, 10);
            } else {
                out.children = details.children.slice(0, 40).map((c) => ({ key: c.key, kind: c.kind, name: c.name, modules: c.modules }));
            }
            out.dependsOn = details.dependsOn.slice(0, 10).map((l) => ({ key: l.key, name: l.name, weight: l.weight }));
            out.usedBy = details.usedBy.slice(0, 10).map((l) => ({ key: l.key, name: l.name, weight: l.weight }));
            return JSON.stringify(out);
        }
        case 'neighbors': {
            const key = str(args, 'key')!;
            node(key);
            const direction = (str(args, 'direction', false) ?? 'both') as 'in' | 'out' | 'both';
            if (!['in', 'out', 'both'].includes(direction)) throw new ToolArgumentError('"direction" must be in, out or both');
            const depth = Math.min(2, Math.max(1, int(args, 'depth', 1)));
            const step = (k: string) => {
                const d = index.describe(k);
                return {
                    out: direction === 'in' ? [] : (d?.dependsOn ?? []).slice(0, 12),
                    in: direction === 'out' ? [] : (d?.usedBy ?? []).slice(0, 12),
                };
            };
            const first = step(key);
            const result: Record<string, unknown> = {
                ...brief(key),
                ...(direction !== 'in' ? { dependsOn: first.out.map((l) => ({ key: l.key, name: l.name, weight: l.weight })) } : {}),
                ...(direction !== 'out' ? { usedBy: first.in.map((l) => ({ key: l.key, name: l.name, weight: l.weight })) } : {}),
            };
            if (depth === 2) {
                const next: Record<string, unknown> = {};
                for (const l of [...first.out, ...first.in].slice(0, 8)) {
                    const s = step(l.key);
                    next[l.key] = { dependsOn: s.out.slice(0, 6).map((x) => x.key), usedBy: s.in.slice(0, 6).map((x) => x.key) };
                }
                result.secondStep = next;
            }
            return JSON.stringify(result);
        }
        case 'explain_edge': {
            const source = str(args, 'source')!;
            const target = str(args, 'target')!;
            node(source);
            node(target);
            const e = index.explainEdge(source, target, 15);
            if (!e || !e.total) return JSON.stringify({ source, target, dependencies: [], note: 'No dependency between them' });
            return JSON.stringify({
                source,
                target,
                total: e.total,
                dependencies: e.dependencies.map((d) => ({
                    from: d.from,
                    to: d.to,
                    weight: d.weight,
                    ...(d.implicit ? { implicit: true } : {}),
                    sites: d.evidence.slice(0, 3).map((x) => (x.line !== undefined ? `${x.source} (line ${x.line + 1})` : x.source)),
                })),
            });
        }
        case 'read_code': {
            if (!allowCode) throw new ToolArgumentError('Reading code is not allowed under the current privacy tier');
            const path = str(args, 'path')!;
            const mod = index.node(`mod:${path}`);
            if (!mod) throw new ToolArgumentError(`"${path}" is not an indexed source file`);
            ctx.touched.add(mod.key);
            let start = Math.max(1, int(args, 'startLine'));
            let end = Math.max(start, int(args, 'endLine'));
            end = Math.min(end, start + READ_CODE_MAX_LINES - 1);
            const remaining = READ_CODE_BUDGET - ctx.linesRead;
            if (remaining <= 0) throw new ToolArgumentError('The code-reading budget for this conversation is used up; answer from what you have');
            end = Math.min(end, start + remaining - 1);
            const text = await ctx.readFile(path).catch(() => undefined);
            if (text === undefined) throw new ToolArgumentError(`Couldn't read "${path}"`);
            const lines = text.split('\n');
            if (start > lines.length) throw new ToolArgumentError(`"${path}" has ${lines.length} lines`);
            end = Math.min(end, lines.length);
            start = Math.min(start, end);
            ctx.linesRead += end - start + 1;
            const body = lines
                .slice(start - 1, end)
                .map((l, i) => `${start + i}: ${l}`)
                .join('\n');
            return JSON.stringify({ path, startLine: start, endLine: end, totalLines: lines.length, code: body });
        }
        case 'find_flows': {
            const flows = ctx.flows;
            if (!flows) throw new ToolArgumentError('Flows are not available for this workspace');
            const id = str(args, 'id', false);
            if (id) {
                const f = flows.trace(id);
                if (!f) throw new ToolArgumentError(`No flow "${id}". Call find_flows without id to list them.`);
                const steps = f.steps.slice(0, FLOW_STEP_LIMIT);
                for (const s of steps) {
                    ctx.touched.add(index.node(s.key) ? s.key : `mod:${s.file}`);
                }
                const laneName = new Map(f.lanes.map((l) => [l.key, l.name]));
                return JSON.stringify({
                    id: f.id,
                    kind: f.kind,
                    label: f.label,
                    framework: f.framework,
                    declaredAt: `${f.file}:${f.line + 1}`,
                    steps: steps.map((s, i) => ({
                        step: i,
                        name: s.name,
                        key: index.node(s.key) ? s.key : `mod:${s.file}`,
                        at: `${s.file}:${s.line + 1}`,
                        part: laneName.get(s.lane) ?? s.lane,
                        ...(s.parent !== undefined ? { calledBy: s.parent } : {}),
                        ...(s.callSite ? { callLine: s.callSite.line + 1 } : {}),
                        ...(s.resolution === 'name' ? { matchedByNameOnly: true } : {}),
                        ...(s.crossCutting ? { sharedHelper: true } : {}),
                    })),
                    parts: f.lanes.map((l) => ({ key: l.key, name: l.name })),
                    reaches: f.sinks.map((s) => ({ kind: s.kind, library: s.name, step: s.step })),
                    ...(f.approximate ? { approximate: 'some calls were matched by name only' } : {}),
                    ...(f.truncated || f.steps.length > steps.length ? { truncated: 'deeper calls were cut off' } : {}),
                });
            }
            const kind = str(args, 'kind', false) as EntryPointKind | undefined;
            if (kind && !FLOW_KINDS.includes(kind)) throw new ToolArgumentError(`"kind" must be one of ${FLOW_KINDS.join(', ')}`);
            const words = (str(args, 'query', false) ?? '').toLowerCase().split(/\s+/).filter(Boolean);
            const all = flows.list();
            const matching = all.filter((f) => (!kind || f.kind === kind) && words.every((w) => `${f.label} ${f.framework} ${f.file}`.toLowerCase().includes(w)));
            return JSON.stringify({
                total: all.length,
                matching: matching.length,
                results: matching.slice(0, FLOW_LIST_LIMIT).map((f) => ({ id: f.id, kind: f.kind, label: f.label, framework: f.framework, at: `${f.file}:${f.line + 1}` })),
                ...(matching.length > FLOW_LIST_LIMIT ? { note: `Showing ${FLOW_LIST_LIMIT}; narrow the query to see others` } : {}),
                ...(all.length === 0 ? { note: 'No entrypoints were found in this workspace' } : {}),
            });
        }
        case 'show_in_map': {
            const raw = args.keys;
            if (!Array.isArray(raw)) throw new ToolArgumentError('"keys" must be an array of node keys');
            const keys = raw.filter((k): k is string => typeof k === 'string' && !!index.node(k)).slice(0, 20);
            if (!keys.length) throw new ToolArgumentError('None of those keys exist. Use search to find keys.');
            const mode = str(args, 'mode', false) === 'highlight' ? 'highlight' : 'focus';
            ctx.actions.push({ action: mode, keys });
            for (const k of keys) ctx.touched.add(k);
            return JSON.stringify({ shown: keys.length, note: 'The user now has a button for this view' });
        }
        default:
            throw new ToolArgumentError(`Unknown tool "${name}"`);
    }
}
