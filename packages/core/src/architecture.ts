/**
 * The architecture diagram, built from what the engine knows (no AI): the
 * system's main parts in layers by role, the dependencies between them, who
 * calls in (the kinds of entrypoints) and the systems it talks to (the flows'
 * sinks: databases, HTTP APIs, queues, caches, storage).
 *
 * "Main parts" is a level with enough to say: the top of the hierarchy, with
 * the biggest part opened until there are a handful (a single-package repo
 * shows its components, not one box). Test-only parts are left out.
 */
import type { ArchEdge, ArchLayer, ArchNode, Architecture, ComponentRole, EntryPointKind, Flow, FlowSummary, SinkKind, ViewNode } from '@codearchy/protocol';
import type { HierarchyIndex } from './hierarchy/project.js';

export interface ArchitectureFlows {
    list(): FlowSummary[];
    trace(id: string): Flow | undefined;
}

const LAYER_OF_ROLE: Record<ComponentRole, ArchLayer> = { ui: 'interface', api: 'interface', domain: 'domain', data: 'data', infra: 'infrastructure', config: 'shared', util: 'shared', test: 'shared' };
const SINK_LABEL: Record<SinkKind, string> = { database: 'Database', http: 'HTTP APIs', queue: 'Message queue', cache: 'Cache', storage: 'File storage' };
const ACTOR: Partial<Record<EntryPointKind, { id: string; label: string; edge: string; description: string }>> = {
    http: { id: 'actor:http', label: 'API clients', edge: 'HTTP requests', description: 'Callers of the HTTP routes.' },
    ui: { id: 'actor:ui', label: 'Users', edge: 'uses the UI', description: 'People using the interface.' },
    cli: { id: 'actor:cli', label: 'Operators', edge: 'runs commands', description: 'People and scripts running the command line.' },
    event: { id: 'actor:event', label: 'Events', edge: 'events', description: 'Messages and events the system listens to.' },
    job: { id: 'actor:job', label: 'Scheduler', edge: 'scheduled jobs', description: 'Timers and job runners.' },
};
/** Well-known clients, so the diagram says "PostgreSQL" rather than "pg". */
const PRODUCT: Record<string, string> = {
    pg: 'PostgreSQL', postgres: 'PostgreSQL', psycopg2: 'PostgreSQL', psycopg: 'PostgreSQL', asyncpg: 'PostgreSQL', 'pg-promise': 'PostgreSQL',
    mysql: 'MySQL', mysql2: 'MySQL', pymysql: 'MySQL', mongodb: 'MongoDB', mongoose: 'MongoDB', pymongo: 'MongoDB', redis: 'Redis', ioredis: 'Redis',
    kafkajs: 'Kafka', 'kafka-python': 'Kafka', amqplib: 'RabbitMQ', pika: 'RabbitMQ', sqlite3: 'SQLite', 'better-sqlite3': 'SQLite',
    '@prisma/client': 'Database (Prisma)', sqlalchemy: 'SQL database', typeorm: 'SQL database', sequelize: 'SQL database', knex: 'SQL database',
    axios: 'HTTP APIs', 'node-fetch': 'HTTP APIs', requests: 'HTTP APIs', httpx: 'HTTP APIs', 'aws-sdk': 'AWS', boto3: 'AWS', '@aws-sdk/client-s3': 'Amazon S3',
};
const MIN_PARTS = 4;
const MAX_FLOWS = 80;

/** The level to draw: the top, opened (biggest first) until there are a few parts. */
function mainParts(index: HierarchyIndex): { nodes: ViewNode[]; edges: Array<{ source: string; target: string; weight: number }> } {
    const view = index.project({ scope: 'sys:root', expanded: mainExpansions(index) });
    const nodes = view.nodes.filter((n) => !n.expanded && n.role !== 'test');
    const keep = new Set(nodes.map((n) => n.key));
    return { nodes, edges: view.edges.filter((e) => keep.has(e.source) && keep.has(e.target) && e.source !== e.target) };
}

export function buildArchitecture(index: HierarchyIndex, flows?: ArchitectureFlows, now = Date.now()): Architecture {
    const { nodes: parts, edges: deps } = mainParts(index);
    const partOf = (file: string): string | undefined => {
        const i = index.indexOf(`mod:${file}`);
        if (i === undefined) return undefined;
        const chain = new Set([i, ...index.ancestors(i)].map((x) => index.hierarchy.nodes[x]!.key));
        return parts.find((p) => chain.has(p.key))?.key;
    };

    const nodes: ArchNode[] = parts.map((p) => ({
        id: p.key,
        label: p.name,
        kind: 'part',
        layer: p.role ? LAYER_OF_ROLE[p.role] : 'application',
        description: `${p.kind === 'module' ? 'A file' : `${p.modules.toLocaleString()} file${p.modules === 1 ? '' : 's'}`}${p.role ? `, ${p.role} code` : ''}${p.path ? ` in ${p.path}` : ''}.`,
        parts: [p.key],
        ...(p.role ? { role: p.role } : {}),
        files: p.modules,
    }));
    const edges: ArchEdge[] = deps.map((e) => ({ source: e.source, target: e.target, label: 'uses', kind: 'depends', weight: e.weight }));

    // Who calls in, and what the system reaches: from the flows.
    const actors = new Map<string, { node: ArchNode; to: Map<string, number> }>();
    const externals = new Map<string, { node: ArchNode; from: Map<string, number> }>();
    const list = flows?.list() ?? [];
    for (const f of list.slice(0, MAX_FLOWS)) {
        const actor = ACTOR[f.kind];
        const entry = partOf(f.file);
        if (actor && entry) {
            const a = actors.get(actor.id) ?? { node: { id: actor.id, label: actor.label, kind: 'actor' as const, layer: 'actors' as const, description: actor.description, parts: [] }, to: new Map() };
            a.to.set(entry, (a.to.get(entry) ?? 0) + 1);
            actors.set(actor.id, a);
        }
        const traced = flows!.trace(f.id);
        for (const sink of traced?.sinks ?? []) {
            const step = traced!.steps[sink.step];
            const from = step ? partOf(step.file) : undefined;
            if (!from) continue;
            const product = PRODUCT[sink.name] ?? PRODUCT[sink.name.toLowerCase()];
            const id = `ext:${sink.kind}:${product ?? sink.name}`;
            const x = externals.get(id) ?? {
                node: { id, label: product ?? sink.name, kind: 'external' as const, layer: 'external' as const, description: `${SINK_LABEL[sink.kind]}, reached through ${sink.name}.`, parts: [], sink: sink.kind },
                from: new Map(),
            };
            x.from.set(from, (x.from.get(from) ?? 0) + 1);
            externals.set(id, x);
        }
    }
    for (const [, a] of actors) {
        nodes.push(a.node);
        const label = Object.values(ACTOR).find((x) => x?.id === a.node.id)?.edge ?? 'calls';
        for (const [to, n] of a.to) edges.push({ source: a.node.id, target: to, label: `${label} (${n})`, kind: 'request', weight: n });
    }
    for (const [, x] of externals) {
        nodes.push(x.node);
        const kind: ArchEdge['kind'] = x.node.sink === 'queue' ? 'event' : x.node.sink === 'http' ? 'request' : 'data';
        const label = x.node.sink === 'database' ? 'reads and writes' : x.node.sink === 'http' ? 'calls' : x.node.sink === 'queue' ? 'publishes / consumes' : x.node.sink === 'cache' ? 'caches in' : 'stores files in';
        for (const [from, n] of x.from) edges.push({ source: from, target: x.node.id, label, kind, weight: n });
    }

    return { pattern: patternOf(nodes, list), summary: summaryOf(index, nodes, list), nodes, edges, source: 'deterministic', createdAt: now };
}

function patternOf(nodes: ArchNode[], flows: FlowSummary[]): string {
    const layers = new Set(nodes.filter((n) => n.kind === 'part').map((n) => n.layer));
    const packages = nodes.filter((n) => n.kind === 'part' && n.parts[0]?.startsWith('pkg:')).length;
    const queues = nodes.some((n) => n.sink === 'queue') || flows.some((f) => f.kind === 'event');
    const parts: string[] = [];
    if (packages >= 3) parts.push('Modular monorepo');
    if (layers.has('interface') && (layers.has('domain') || layers.has('data'))) parts.push('layered (interface → domain → data)');
    if (queues) parts.push('event-driven in places');
    if (!parts.length) parts.push(flows.some((f) => f.kind === 'http') ? 'Service with an HTTP API' : 'Modular codebase');
    const text = parts.join(', ');
    return text[0]!.toUpperCase() + text.slice(1);
}

function summaryOf(index: HierarchyIndex, nodes: ArchNode[], flows: FlowSummary[]): string {
    const parts = nodes.filter((n) => n.kind === 'part');
    const ext = nodes.filter((n) => n.kind === 'external');
    const counts = new Map<string, number>();
    for (const f of flows) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
    const entry = [...counts].map(([k, n]) => `${n} ${k === 'http' ? 'HTTP route' : k === 'ui' ? 'UI route' : k === 'cli' ? 'command' : k === 'main' ? 'main entrypoint' : k}${n === 1 ? '' : 's'}`).join(', ');
    const biggest = [...parts].sort((a, b) => (b.files ?? 0) - (a.files ?? 0))[0];
    return [
        `${index.hierarchy.nodes[0]?.name ?? 'The system'} has ${index.summary(0).modules.toLocaleString()} source files in ${parts.length} main part${parts.length === 1 ? '' : 's'}${biggest ? `; the largest is ${biggest.label}` : ''}.`,
        entry ? `It is entered through ${entry}.` : '',
        ext.length ? `It talks to ${ext.map((x) => x.label).join(', ')}.` : '',
    ]
        .filter(Boolean)
        .join(' ');
}

/** A building block the architect model may group into subsystems: a main part, or a component inside one. */
export interface ArchitectureCandidate {
    id: string;
    name: string;
    kind: string;
    path: string;
    files: number;
    role?: ComponentRole;
    /** The main part it sits in (components only). */
    within?: string;
}

const MAX_CANDIDATES = 60;

/**
 * What the architect model designs from: the main parts and the components
 * inside them, with the dependencies between components (the finest level it
 * may group). Bounded, so a big repository still fits a prompt.
 */
export function architectureCandidates(index: HierarchyIndex): { candidates: ArchitectureCandidate[]; dependencies: Array<{ source: string; target: string; weight: number }> } {
    const { nodes: main } = mainParts(index);
    const candidates: ArchitectureCandidate[] = main.map((n) => ({ id: n.key, name: n.name, kind: n.kind, path: n.path, files: n.modules, ...(n.role ? { role: n.role } : {}) }));
    const open: string[] = [];
    for (const n of [...main].sort((a, b) => b.modules - a.modules)) {
        if (!n.hasChildren || candidates.length >= MAX_CANDIDATES) continue;
        const kids = (index.children(n.key) ?? []).filter((c) => c.role !== 'test');
        if (kids.length < 2 || candidates.length + kids.length > MAX_CANDIDATES) continue;
        open.push(n.key);
        for (const c of kids) candidates.push({ id: c.key, name: c.name, kind: c.kind, path: c.path, files: c.modules, ...(c.role ? { role: c.role } : {}), within: n.key });
    }
    // Dependencies at the finest level offered: main parts opened where their components are offered.
    const view = index.project({ scope: 'sys:root', expanded: [...new Set([...mainExpansions(index), ...open])] });
    const known = new Set(candidates.map((c) => c.id));
    const dependencies = view.edges.filter((e) => known.has(e.source) && known.has(e.target) && e.source !== e.target).map((e) => ({ source: e.source, target: e.target, weight: e.weight }));
    return { candidates, dependencies };
}

/** The expansions mainParts used to reach its level. */
function mainExpansions(index: HierarchyIndex): string[] {
    let expanded: string[] = [];
    let view = index.project({ scope: 'sys:root', expanded });
    for (let i = 0; i < 4; i++) {
        const leaves = view.nodes.filter((n) => !n.expanded && n.role !== 'test');
        if (leaves.length >= MIN_PARTS) break;
        const open = leaves.filter((n) => n.hasChildren).sort((a, b) => b.modules - a.modules)[0];
        if (!open) break;
        expanded = [...expanded, open.key];
        view = index.project({ scope: 'sys:root', expanded });
    }
    return expanded;
}

