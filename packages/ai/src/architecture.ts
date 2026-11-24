/**
 * The system architecture, designed by the architect model (v1's System view,
 * grounded). The model is given the building blocks the engine found (the
 * main parts and the components inside them, with roles, sizes and paths),
 * the dependencies between them, how the system is entered and the external
 * systems it reaches. It answers with a high-level design: subsystems,
 * services and layers named the way an architect would (not by folder), what
 * each is responsible for, which building blocks it consists of, the systems
 * around it, the relationships, and the overall pattern.
 *
 * Grounded: a design node consists of real building blocks (anything else is
 * dropped), code the model leaves out is kept as its own part, and the
 * dependencies the code really has are drawn even if the model forgot them.
 */
import { architectureCandidates, buildArchitecture, type ArchitectureCandidate, type ArchitectureFlows, type HierarchyIndex } from '@codearchy/core';
import { ARCH_LAYERS, type ArchEdge, type ArchLayer, type ArchNode, type Architecture, type ComponentRole } from '@codearchy/protocol';
import type { ChatEvent, ChatMessage, JsonSchema, ProviderRegistry, SignalLike } from '@codearchy/providers';
import { CardFormatError, extractJson } from './card.js';

const NODE_TYPES = ['subsystem', 'layer', 'service', 'external', 'actor'] as const;
const EDGE_TYPES = ['dependency', 'data-flow', 'api-call', 'event'] as const;
const EDGE_KIND: Record<(typeof EDGE_TYPES)[number], ArchEdge['kind']> = { dependency: 'depends', 'data-flow': 'data', 'api-call': 'request', event: 'event' };
const LAYER_OF_ROLE: Record<ComponentRole, ArchLayer> = { ui: 'interface', api: 'interface', domain: 'domain', data: 'data', infra: 'infrastructure', config: 'shared', util: 'shared', test: 'shared' };

export const ARCHITECTURE_SCHEMA: JsonSchema = {
    type: 'object',
    properties: {
        pattern: { type: 'string', description: 'The architectural pattern (e.g. "Layered monolith", "Microservices", "Hexagonal", "Event-driven", "MVC").' },
        summary: { type: 'string', description: 'One paragraph for a new engineer: what the system does and how its subsystems fit together.' },
        nodes: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'A short unique id, e.g. "orders-service".' },
                    label: { type: 'string', description: 'An architect-level name (e.g. "Order Service", "API Gateway", "Persistence Layer"), not a folder name.' },
                    description: { type: 'string', description: 'One sentence: what it is responsible for.' },
                    type: { type: 'string', enum: [...NODE_TYPES] },
                    layer: { type: 'string', enum: ARCH_LAYERS },
                    parts: { type: 'array', items: { type: 'string' }, description: 'Ids of the building blocks it consists of (none for external systems and actors).' },
                },
                required: ['id', 'label', 'description', 'type'],
            },
        },
        edges: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    source: { type: 'string' },
                    target: { type: 'string' },
                    label: { type: 'string', description: '2–5 words: what flows along it.' },
                    type: { type: 'string', enum: [...EDGE_TYPES] },
                },
                required: ['source', 'target', 'label', 'type'],
            },
        },
    },
    required: ['pattern', 'summary', 'nodes', 'edges'],
};

const SYSTEM = [
    'You are a senior software architect. Design the high-level system architecture of a codebase for a new engineer, like an architecture diagram on a whiteboard.',
    'You get the building blocks the analyzer found in the code (main parts and the components inside them, with roles, sizes and paths), the dependencies between them, how the system is entered, and the external systems it reaches.',
    '1. Identify the major subsystems, services and layers (e.g. "API Gateway", "Auth Service", "Order Management", "Persistence Layer", "Web UI"). Name them the way an architect would, NOT by folder name.',
    '2. Assign the building blocks to them by id (`parts`): a subsystem usually groups several; each building block belongs to one. Aim for 4–12 nodes.',
    '3. Describe each one\'s responsibility in one sentence, and give its layer.',
    '4. Add the external systems (databases, third-party APIs, queues) and who calls in (users, clients, schedulers) as nodes of type "external" and "actor", without parts.',
    '5. Give the key relationships between nodes with a short label and a type: dependency, data-flow, api-call or event.',
    '6. Name the overall architectural pattern and write a one-paragraph summary.',
    'Use only building-block ids you were given. Base everything on the facts; when unsure, say less. Reply with one JSON object matching the schema, no markdown.',
].join('\n');

/** The building blocks and facts the model designs from. */
export interface DesignFacts {
    base: Architecture;
    candidates: ArchitectureCandidate[];
    dependencies: Array<{ source: string; target: string; weight: number }>;
}

export function designFacts(index: HierarchyIndex, flows?: ArchitectureFlows): DesignFacts {
    const { candidates, dependencies } = architectureCandidates(index);
    return { base: buildArchitecture(index, flows), candidates, dependencies };
}

export function renderDesignFacts(f: DesignFacts): string {
    const actors = f.base.nodes.filter((n) => n.kind === 'actor');
    const externals = f.base.nodes.filter((n) => n.kind === 'external');
    return JSON.stringify({
        system: f.base.summary,
        buildingBlocks: f.candidates.map((c) => ({ id: c.id, name: c.name, kind: c.kind, path: c.path, files: c.files, ...(c.role ? { role: c.role } : {}), ...(c.within ? { within: c.within } : {}) })),
        dependencies: f.dependencies.map((d) => ({ from: d.source, to: d.target, weight: d.weight })),
        enteredBy: actors.map((a) => ({ who: a.label, into: f.base.edges.filter((e) => e.source === a.id).map((e) => e.target) })),
        externalSystems: externals.map((x) => ({ name: x.label, kind: x.sink, usedBy: f.base.edges.filter((e) => e.target === x.id).map((e) => e.source) })),
    });
}

/** What the model answered (kept, so a stored design is re-checked against today's code). */
export interface StoredDesign {
    reply: unknown;
    provider: string;
    model: string;
    createdAt: number;
}

const slug = (s: string) =>
    s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
        .join('-')
        .slice(0, 40) || 'node';

/**
 * Turns the model's design into the diagram, grounded in today's code: parts
 * are real building blocks, code left out is kept, real dependencies are
 * drawn, and the callers and external systems the code shows stay.
 */
export function applyDesign(f: DesignFacts, design: StoredDesign): Architecture {
    const r = design.reply as { pattern?: unknown; summary?: unknown; nodes?: unknown; edges?: unknown };
    if (!r || typeof r !== 'object' || typeof r.pattern !== 'string' || typeof r.summary !== 'string' || !Array.isArray(r.nodes) || !Array.isArray(r.edges)) {
        throw new CardFormatError('pattern, summary, nodes and edges are required');
    }
    const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
    const byId = new Map(f.candidates.map((c) => [c.id, c]));
    const ownerOf = new Map<string, string>(); // building block → design node
    const idMap = new Map<string, string>(); // the model's ids → ours
    const nodes: ArchNode[] = [];
    const used = new Set<string>();
    const fresh = (want: string) => {
        let id = `ai:${slug(want)}`;
        for (let n = 2; used.has(id); n++) id = `ai:${slug(want)}-${n}`;
        used.add(id);
        return id;
    };
    const baseExternal = (label: string) => f.base.nodes.find((n) => n.kind === 'external' && n.label.toLowerCase() === label.toLowerCase());

    for (const raw of r.nodes as Array<Record<string, unknown>>) {
        if (!raw || typeof raw !== 'object') continue;
        const label = text(raw.label, 48);
        const type = NODE_TYPES.includes(raw.type as (typeof NODE_TYPES)[number]) ? (raw.type as (typeof NODE_TYPES)[number]) : 'subsystem';
        if (!label) continue;
        const description = text(raw.description, 280);
        const theirs = typeof raw.id === 'string' ? raw.id : label;
        if (type === 'external' || type === 'actor') {
            // An external system the code shows keeps its id (and its edges); others are the model's reading.
            const known = type === 'external' ? baseExternal(label) : undefined;
            const id = known?.id ?? fresh(theirs);
            used.add(id);
            idMap.set(theirs, id);
            nodes.push({ id, label, kind: type, layer: type === 'actor' ? 'actors' : 'external', description: description || known?.description || '', parts: [], ...(known?.sink ? { sink: known.sink } : {}) });
            continue;
        }
        // Real building blocks only, each in one node (the first that claims it).
        const parts = (Array.isArray(raw.parts) ? raw.parts : []).filter((p): p is string => typeof p === 'string' && byId.has(p) && !ownerOf.has(p));
        if (!parts.length) continue;
        const id = fresh(theirs);
        idMap.set(theirs, id);
        for (const p of parts) ownerOf.set(p, id);
        const roles = parts.map((p) => byId.get(p)!.role).filter((x): x is ComponentRole => !!x);
        const layer = ARCH_LAYERS.includes(raw.layer as ArchLayer) && raw.layer !== 'external' && raw.layer !== 'actors' ? (raw.layer as ArchLayer) : roles.length ? LAYER_OF_ROLE[mostCommon(roles)] : 'application';
        nodes.push({ id, label, kind: 'part', type, layer, description, parts, files: countFiles(parts, byId) });
    }

    // Code the design left out stays on the diagram: a main part none of whose blocks were claimed.
    const ownerOfBlock = (block: string): string | undefined => ownerOf.get(block) ?? (byId.get(block)?.within ? ownerOf.get(byId.get(block)!.within!) : undefined);
    for (const c of f.candidates) {
        if (c.within) continue;
        if (ownerOf.has(c.id)) continue;
        const kids = f.candidates.filter((k) => k.within === c.id);
        const claimedKids = kids.filter((k) => ownerOf.has(k.id));
        if (claimedKids.length) {
            // Partly claimed: its other components go where most of their siblings went.
            const home = mostCommon(claimedKids.map((k) => ownerOf.get(k.id)!));
            const target = nodes.find((n) => n.id === home)!;
            for (const k of kids) {
                if (ownerOf.has(k.id)) continue;
                ownerOf.set(k.id, home);
                target.parts.push(k.id);
                target.files = (target.files ?? 0) + k.files;
            }
            continue;
        }
        const base = f.base.nodes.find((n) => n.id === c.id);
        ownerOf.set(c.id, c.id);
        used.add(c.id);
        nodes.push({ id: c.id, label: c.name, kind: 'part', layer: base?.layer ?? (c.role ? LAYER_OF_ROLE[c.role] : 'application'), description: base?.description ?? '', parts: [c.id], files: c.files, ...(c.role ? { role: c.role } : {}) });
    }
    // The callers and external systems the code shows, when the model didn't include them.
    for (const n of f.base.nodes) if ((n.kind === 'actor' || n.kind === 'external') && !nodes.some((x) => x.id === n.id)) nodes.push(n);

    const ids = new Set(nodes.map((n) => n.id));
    const edges = new Map<string, ArchEdge>();
    for (const raw of r.edges as Array<Record<string, unknown>>) {
        const source = idMap.get(String(raw?.source)) ?? String(raw?.source);
        const target = idMap.get(String(raw?.target)) ?? String(raw?.target);
        if (!ids.has(source) || !ids.has(target) || source === target) continue;
        const type = EDGE_TYPES.includes(raw.type as (typeof EDGE_TYPES)[number]) ? (raw.type as (typeof EDGE_TYPES)[number]) : 'dependency';
        edges.set(`${source}->${target}`, { source, target, label: text(raw.label, 48) || 'uses', kind: EDGE_KIND[type] });
    }
    // Dependencies the code really has, between the design's nodes.
    const node = (block: string) => ownerOfBlock(block);
    const weights = new Map<string, number>();
    for (const d of f.dependencies) {
        const s = node(d.source);
        const t = node(d.target);
        if (s && t && s !== t) weights.set(`${s}->${t}`, (weights.get(`${s}->${t}`) ?? 0) + d.weight);
    }
    for (const [k, w] of weights) {
        const e = edges.get(k);
        if (e) e.weight = w;
        else {
            const [source, target] = k.split('->') as [string, string];
            edges.set(k, { source, target, label: 'uses', kind: 'depends', weight: w });
        }
    }
    // Callers and external systems: the code's own edges, re-pointed at the design's nodes.
    for (const e of f.base.edges) {
        const isOuter = (id: string) => f.base.nodes.some((n) => n.id === id && n.kind !== 'part');
        if (!isOuter(e.source) && !isOuter(e.target)) continue;
        const source = isOuter(e.source) ? e.source : node(e.source);
        const target = isOuter(e.target) ? e.target : node(e.target);
        if (!source || !target || !ids.has(source) || !ids.has(target) || source === target) continue;
        const k = `${source}->${target}`;
        if (!edges.has(k)) edges.set(k, { ...e, source, target });
    }

    return {
        pattern: text(r.pattern, 120) || f.base.pattern,
        summary: text(r.summary, 1200) || f.base.summary,
        nodes,
        edges: [...edges.values()],
        source: 'ai',
        provider: design.provider,
        model: design.model,
        createdAt: design.createdAt,
    };
}

function mostCommon<T>(xs: T[]): T {
    const counts = new Map<T, number>();
    for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1])[0]![0];
}

/** Files in these blocks, not counting a component inside a part that's also listed. */
function countFiles(parts: string[], byId: Map<string, ArchitectureCandidate>): number {
    const set = new Set(parts);
    return parts.reduce((n, p) => n + (byId.get(p)?.within && set.has(byId.get(p)!.within!) ? 0 : byId.get(p)?.files ?? 0), 0);
}

/** Asks the architect model to design the system (one repair attempt if the reply doesn't fit). */
export async function designArchitecture(registry: ProviderRegistry, f: DesignFacts, signal?: SignalLike, now = () => Date.now()): Promise<StoredDesign> {
    const target = registry.resolve('architect');
    if (!target.ok) throw new Error(target.reason);
    const messages: ChatMessage[] = [{ role: 'user', content: `The codebase:\n${renderDesignFacts(f)}` }];
    for (let attempt = 0; attempt < 2; attempt++) {
        let text = '';
        let done: Extract<ChatEvent, { type: 'done' }> | undefined;
        for await (const event of registry.chat(
            'architect',
            { system: SYSTEM, messages, json: { schema: ARCHITECTURE_SCHEMA, name: 'architecture' }, maxOutputTokens: 3000, temperature: 0.2 },
            { contains: ['structure'], nodes: f.candidates.map((c) => c.id), ...(signal ? { signal } : {}) },
        )) {
            if (event.type === 'text') text += event.delta;
            else if (event.type === 'restart') text = '';
            else if (event.type === 'done') done = event;
            else if (event.type === 'error') throw new Error(event.error.message);
        }
        if (!done) throw new Error('The model stopped without finishing');
        const reply = done.turn.content || text;
        try {
            const design: StoredDesign = { reply: extractJson(reply), provider: target.provider, model: target.model, createdAt: now() };
            const a = applyDesign(f, design);
            if (!a.nodes.some((n) => n.kind === 'part' && n.type)) throw new CardFormatError('no node consists of the building blocks given (use their ids in `parts`)');
            return design;
        } catch (err) {
            if (!(err instanceof CardFormatError) || attempt === 1) throw new Error(`The model's reply couldn't be used (${err instanceof Error ? err.message : String(err)})`);
            messages.push(
                { role: 'assistant', content: reply, toolCalls: [], ...(done.turn.replay ? { replay: done.turn.replay } : {}) },
                { role: 'user', content: `That reply wasn't usable: ${err.message}. Reply with only the JSON object, matching the schema.` },
            );
        }
    }
    throw new Error("The model's reply couldn't be used");
}
