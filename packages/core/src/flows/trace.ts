/**
 * Flows: from each entrypoint, follow the calls its handler makes, matching
 * each called name to a symbol (same file first, then the files it imports,
 * then a unique name anywhere), breadth-first with depth, fan-out and size
 * limits. Steps are lifted onto swimlanes (the component or package each one
 * lives in) and the libraries their files import mark where data leaves the
 * system (database, HTTP, queue, cache, storage).
 *
 * Name matching is approximate by nature (no types): a hop that only matched
 * by name marks the flow `approximate`, and widely called helpers are shown
 * but not followed (`crossCutting`), so a trace reads like the code's intent
 * rather than its every call.
 */
import {
    SymbolKind,
    type CallSite,
    type EntryPoint,
    type FileAnalysis,
    type Flow,
    type FlowResolution,
    type FlowSink,
    type FlowStep,
    type FlowSummary,
    type SinkKind,
    type SymbolInfo,
} from '@codearchy/protocol';
import type { HierarchyIndex } from '../hierarchy/project.js';
import { isTestPath } from './entrypoints.js';

export const FLOW_LIMITS = { depth: 6, fanOut: 8, steps: 60, hubCallers: 25, nameCandidates: 3 } as const;

const CALLABLE = new Set<string>([SymbolKind.Function, SymbolKind.Method]);
const KIND_ORDER = ['http', 'ui', 'cli', 'event', 'job', 'main'];

/** Names too common to follow by name alone: builtins, collection and I/O verbs. */
const GENERIC = new Set(
    (
        'log error warn info debug trace push pop shift map filter reduce forEach find some every includes indexOf join split ' +
        'replace slice splice concat keys values entries then catch finally resolve reject toString valueOf json send status ' +
        'emit on off once get set has add delete clear next close open write read parse stringify format append update ' +
        'String Number Boolean Array Object Promise Error Date Math Symbol Map Set JSON parseInt parseFloat setTimeout ' +
        'setInterval clearTimeout require int str float dict tuple bool isinstance getattr setattr hasattr enumerate zip ' +
        'sorted reversed min max abs sum round any all iter super new fmt Println Printf Sprintf Errorf Fatal Fatalf New ' +
        'unwrap expect clone to_string into iter collect ok err Some Ok Err Box Vec len append copy panic recover ' +
        'equals hashCode toString valueOf of asList stream size isEmpty contains Add Remove Contains ToString Equals ' +
        'GetType ToList Select Where First FirstOrDefault Any Count assert assertEquals expect describe it test ' +
        // the registration calls on a route or command line itself
        'post put patch head options route use listen command action schedule HandleFunc Handle Group GET POST PUT PATCH ' +
        'DELETE MapGet MapPost MapPut MapDelete'
    ).split(' ')
);

/**
 * Verbs too common to match by name alone across files (they're still
 * followed within a file and through imports).
 */
const AMBIGUOUS = new Set(
    (
        'init load run start stop dispose reset render handle process execute call apply bind create build show hide ' +
        'refresh register connect request fetch save remove insert query exec main index list find search close setup ' +
        'validate check transform convert handler callback invoke dispatch notify publish subscribe send receive'
    ).split(' ')
);

/** Sample code (fixtures, examples) defines names the real code doesn't call. */
const SAMPLE = /(?:^|\/)(?:fixtures?|examples?|samples?|testdata|demo)\//;

/** Languages whose code can call each other's functions directly. */
const FAMILY: Record<string, string> = { typescript: 'js', javascript: 'js', java: 'jvm', kotlin: 'jvm' };
const family = (language: string | undefined) => (language ? (FAMILY[language] ?? language) : '');

interface SinkRule {
    kind: SinkKind;
    prefixes: string[];
}

const SINKS: SinkRule[] = [
    {
        kind: 'database',
        prefixes: [
            'pg', 'mysql', 'mysql2', 'mongodb', 'mongoose', '@prisma/client', 'prisma', 'typeorm', 'sequelize', 'knex', 'drizzle-orm',
            'better-sqlite3', 'sqlite3', '@supabase/supabase-js', 'sqlalchemy', 'django.db', 'psycopg2', 'psycopg', 'pymongo',
            'peewee', 'gorm.io/gorm', 'database/sql', 'github.com/jmoiron/sqlx', 'go.mongodb.org/mongo-driver', 'java.sql',
            'javax.persistence', 'jakarta.persistence', 'org.springframework.data', 'org.hibernate', 'Microsoft.EntityFrameworkCore',
            'Dapper', 'diesel', 'sqlx', 'sea_orm', 'Illuminate\\Database', 'Doctrine\\ORM', 'Doctrine\\DBAL', 'activerecord',
        ],
    },
    {
        kind: 'http',
        prefixes: [
            'axios', 'node-fetch', 'got', 'undici', 'ky', 'superagent', 'requests', 'httpx', 'aiohttp', 'urllib3', 'reqwest',
            'okhttp3', 'java.net.http', 'org.springframework.web.client', 'org.springframework.web.reactive.function.client',
            'System.Net.Http', 'GuzzleHttp', 'Illuminate\\Support\\Facades\\Http', 'faraday', 'httparty', 'net/http',
        ],
    },
    {
        kind: 'queue',
        prefixes: [
            'kafkajs', 'amqplib', 'bullmq', 'bull', '@aws-sdk/client-sqs', '@aws-sdk/client-sns', '@google-cloud/pubsub', 'nats',
            'celery', 'pika', 'kafka', 'confluent_kafka', 'aiokafka', 'github.com/segmentio/kafka-go', 'github.com/rabbitmq/amqp091-go',
            'org.springframework.kafka', 'org.springframework.amqp', 'org.apache.kafka', 'Confluent.Kafka', 'MassTransit', 'lapin', 'rdkafka',
            'sidekiq',
        ],
    },
    {
        kind: 'cache',
        prefixes: ['redis', 'ioredis', '@upstash/redis', 'memcached', 'node-cache', 'lru-cache', 'django.core.cache', 'github.com/redis/go-redis', 'github.com/go-redis/redis', 'StackExchange.Redis', 'Illuminate\\Support\\Facades\\Cache'],
    },
    {
        kind: 'storage',
        prefixes: ['@aws-sdk/client-s3', 'aws-sdk', 'boto3', '@google-cloud/storage', '@azure/storage-blob', 'minio', 'Illuminate\\Support\\Facades\\Storage'],
    },
];

const sinkFor = (source: string): SinkRule | undefined =>
    SINKS.find((r) => r.prefixes.some((p) => source === p || source.startsWith(`${p}/`) || source.startsWith(`${p}.`) || source.startsWith(`${p}\\`) || source.startsWith(`${p}::`)));

/** `auth.login` → `login`, `handlers::create` → `create`, `App\\Http\\Foo` → `Foo`. */
export const lastSegment = (name: string): string => name.split(/[.:\\]/).filter(Boolean).pop() ?? name;

interface Target {
    file: string;
    /** Index into the file's `symbols`. */
    sym: number;
}

type Resolved = Target & { resolution: FlowResolution };

interface EntryRef extends FlowSummary {
    entry: EntryPoint;
}

export class FlowIndex {
    private entries?: EntryRef[];
    private byName?: Map<string, Target[]>;
    private callsBySymbol = new Map<string, CallSite[]>();
    private callerCount?: Map<string, number>;
    private importsOf?: Map<string, Set<string>>;
    private nodeOf?: Map<string, number>;
    private readonly packages = new Map<string, number>();

    constructor(
        private readonly analyses: ReadonlyMap<string, FileAnalysis>,
        private readonly hierarchy: HierarchyIndex
    ) {}

    /** Every entrypoint, routes first, then by label. */
    list(): FlowSummary[] {
        return this.entryRefs().map(({ entry: _entry, ...summary }) => summary);
    }

    trace(id: string): Flow | undefined {
        const ref = this.entryRefs().find((e) => e.id === id);
        if (!ref) return undefined;
        const { entry, ...summary } = ref;
        const steps: FlowStep[] = [];
        const lanes: Flow['lanes'] = [];
        const laneSeen = new Set<string>();
        const visited = new Set<string>();
        let approximate = false;
        let truncated = false;

        const addLane = (file: string): string => {
            const lane = this.laneOf(file);
            if (!laneSeen.has(lane.key)) {
                laneSeen.add(lane.key);
                lanes.push(lane);
            }
            return lane.key;
        };

        // The entry: its handler symbol, or (inline handler) the declaration itself.
        const handler = this.handlerOf(entry, ref.file);
        const rootCalls: CallSite[] = [];
        if (handler) {
            const sym = this.symbol(handler);
            steps.push({ key: this.keyOf(handler), name: sym.name, file: handler.file, line: sym.startLine, lane: addLane(handler.file), depth: 0, resolution: 'entry' });
            visited.add(`${handler.file}#${handler.sym}`);
            if (handler.resolution === 'name') approximate = true;
        } else {
            steps.push({ key: `mod:${ref.file}`, name: ref.label, file: ref.file, line: entry.line, lane: addLane(ref.file), depth: 0, resolution: 'entry' });
            if (entry.endLine !== undefined) {
                const end = entry.endLine;
                rootCalls.push(...(this.analyses.get(ref.file)?.calls ?? []).filter((c) => c.line >= entry.line && c.line <= end));
            }
        }
        const owners: Array<Target | undefined> = [handler];

        for (let s = 0; s < steps.length; s++) {
            const step = steps[s];
            if (step.crossCutting) continue;
            const owner = owners[s];
            const calls = owner ? this.callsOf(owner) : s === 0 ? rootCalls : [];
            if (calls.length === 0) continue;
            if (step.depth >= FLOW_LIMITS.depth) {
                truncated = true;
                continue;
            }
            let fanned = 0;
            for (const call of [...calls].sort((a, b) => a.line - b.line)) {
                const target = this.resolve(call, step.file, owner);
                if (!target) continue;
                const id = `${target.file}#${target.sym}`;
                if (visited.has(id)) continue;
                if (fanned >= FLOW_LIMITS.fanOut || steps.length >= FLOW_LIMITS.steps) {
                    truncated = true;
                    break;
                }
                visited.add(id);
                fanned++;
                const sym = this.symbol(target);
                const hub = (this.callers().get(sym.name) ?? 0) > FLOW_LIMITS.hubCallers;
                if (target.resolution === 'name') approximate = true;
                steps.push({
                    key: this.keyOf(target),
                    name: sym.container ? `${sym.container}.${sym.name}` : sym.name,
                    file: target.file,
                    line: sym.startLine,
                    lane: addLane(target.file),
                    depth: step.depth + 1,
                    parent: s,
                    callSite: { file: step.file, line: call.line },
                    resolution: target.resolution,
                    ...(hub ? { crossCutting: true } : {}),
                });
                owners.push(target);
            }
        }

        return { ...summary, steps, lanes, sinks: this.sinks(steps), approximate, truncated };
    }

    // ─── resolution ─────────────────────────────────────────────────────────

    /**
     * The symbol a call reaches. Bare calls: the same file, then the files it
     * imports, then (when few enough share the name, within the caller's
     * package) anywhere. Calls on `this`/`self`: the caller's own class, then
     * its file. Calls on another object or module: methods in the same file,
     * anything in the files it imports, else a method whose name is unique.
     */
    private resolve(call: Pick<CallSite, 'name' | 'line' | 'via'>, file: string, from?: Target, entry = false): Resolved | undefined {
        const { name, via } = call;
        if (!entry && via !== 'self' && GENERIC.has(name)) return undefined;
        const all = this.names().get(name);
        if (!all) return undefined;
        const notSelf = (t: Target) => !(from && t.file === from.file && t.sym === from.sym);
        const local = all.filter((t) => t.file === file && notSelf(t));
        if (via === 'self') {
            const container = from ? this.symbol(from).container : undefined;
            const own = container ? local.filter((t) => this.symbol(t).container === container) : [];
            const pick = own[0] ?? local[0];
            return pick && { ...pick, resolution: 'local' };
        }
        const candidates = via === 'member' ? local.filter((t) => this.symbol(t).container !== undefined) : local;
        if (candidates.length) {
            // Prefer the declaration nearest below the line (a decorated handler), else the first.
            const below = candidates.filter((t) => this.symbol(t).startLine >= call.line).sort((a, b) => this.symbol(a).startLine - this.symbol(b).startLine);
            return { ...(below[0] ?? candidates[0]), resolution: 'local' };
        }
        const imports = this.imports().get(file);
        const imported = imports ? all.filter((t) => imports.has(t.file)) : [];
        if (imported.length) return { ...imported[0], resolution: 'import' };
        // Imported through a file that only passes it on (a package's index.ts, a Python __init__.py).
        const reexported = this.throughReexports(name, imports, all);
        if (reexported) return { ...reexported, resolution: 'import' };
        // By name alone: only distinctive names, in the same language family, outside sample code.
        if (AMBIGUOUS.has(name) || name.length < 4) return undefined;
        const lang = family(this.analyses.get(file)?.language);
        const plausible = all.filter((t) => notSelf(t) && !SAMPLE.test(t.file) && family(this.analyses.get(t.file)?.language) === lang);
        if (via === 'member') {
            // No types to follow: only a method name that exists once in the workspace.
            const methods = plausible.filter((t) => this.symbol(t).container !== undefined);
            return methods.length === 1 ? { ...methods[0], resolution: 'name' } : undefined;
        }
        const pkg = this.packageOf(file);
        const anywhere = plausible.filter((t) => this.packageOf(t.file) === pkg);
        if (anywhere.length === 0 || anywhere.length > FLOW_LIMITS.nameCandidates) return undefined;
        // Several share the name: the one closest to the caller in the tree.
        const best = [...anywhere].sort((a, b) => sharedPrefix(b.file, file) - sharedPrefix(a.file, file) || (a.file < b.file ? -1 : 1))[0];
        return { ...best, resolution: 'name' };
    }

    /**
     * A name imported from a file that doesn't declare it but passes it on
     * (`export { placeOrder } from './placeOrder'`, `export * from './money'`,
     * `from .model import recommend_for`): followed to the declaration, a few
     * files deep. Workspace packages are usually imported this way, through their index.
     */
    private throughReexports(name: string, start: Set<string> | undefined, all: Target[]): Target | undefined {
        if (!start) return undefined;
        let frontier = [...start];
        const seen = new Set(frontier);
        for (let hop = 0; hop < 3 && frontier.length; hop++) {
            const next: string[] = [];
            for (const f of frontier) {
                // Re-exported by name, or everything (`export *`); the regex fallback doesn't record names, so any import may pass it on.
                const passes = this.analyses.get(f)?.imports.some((i) => i.isNamespace || i.specifiers.includes(name) || (i.specifiers.length === 0 && !i.isDefault));
                if (!passes) continue;
                for (const g of this.imports().get(f) ?? []) {
                    if (seen.has(g)) continue;
                    seen.add(g);
                    const hit = all.find((t) => t.file === g);
                    if (hit) return hit;
                    next.push(g);
                }
            }
            frontier = next;
        }
        return undefined;
    }

    /** The nearest package above a file (the root when there are none): name-only matches stay inside it. */
    private packageOf(file: string): number {
        let cached = this.packages.get(file);
        if (cached === undefined) {
            cached = 0;
            const mod = this.hierarchy.indexOf(`mod:${file}`);
            if (mod !== undefined) {
                for (const i of this.hierarchy.ancestors(mod)) if (this.hierarchy.hierarchy.nodes[i].kind === 'package') cached = i;
            }
            this.packages.set(file, cached);
        }
        return cached;
    }

    private handlerOf(entry: EntryPoint, file: string): Resolved | undefined {
        return entry.handler ? this.resolve({ name: lastSegment(entry.handler), line: entry.line }, file, undefined, true) : undefined;
    }

    private symbol(t: Target): SymbolInfo {
        return this.analyses.get(t.file)!.symbols[t.sym];
    }

    private callsOf(t: Target): CallSite[] {
        const id = `${t.file}#${t.sym}`;
        let calls = this.callsBySymbol.get(id);
        if (!calls) {
            calls = (this.analyses.get(t.file)?.calls ?? []).filter((c) => c.from === t.sym);
            this.callsBySymbol.set(id, calls);
        }
        return calls;
    }

    /** The hierarchy key of a symbol (`sym:path#Name`), falling back to its module. */
    private keyOf(t: Target): string {
        const sym = this.symbol(t);
        const i = this.nodes().get(`${t.file}\u0000${sym.startLine}\u0000${sym.name}`);
        return i === undefined ? `mod:${t.file}` : this.hierarchy.hierarchy.nodes[i].key;
    }

    private laneOf(file: string): Flow['lanes'][number] {
        const nodes = this.hierarchy.hierarchy.nodes;
        const mod = this.hierarchy.indexOf(`mod:${file}`);
        if (mod !== undefined) {
            const chain = this.hierarchy.ancestors(mod).reverse();
            for (const i of chain) {
                const n = nodes[i];
                if (n.kind === 'component' || n.kind === 'package') return { key: n.key, name: laneName(n.name, n.path), kind: n.kind };
            }
        }
        return { key: nodes[0].key, name: nodes[0].name, kind: nodes[0].kind };
    }

    private sinks(steps: FlowStep[]): FlowSink[] {
        const out: FlowSink[] = [];
        const seen = new Set<string>();
        steps.forEach((step, i) => {
            for (const imp of this.analyses.get(step.file)?.imports ?? []) {
                const rule = sinkFor(imp.source);
                if (!rule) continue;
                const id = `${rule.kind}:${imp.source}`;
                if (seen.has(id)) continue;
                seen.add(id);
                out.push({ kind: rule.kind, name: imp.source, step: i });
            }
        });
        return out;
    }

    // ─── lazily built tables ────────────────────────────────────────────────

    private entryRefs(): EntryRef[] {
        if (this.entries) return this.entries;
        const out: EntryRef[] = [];
        const used = new Map<string, number>();
        for (const [file, a] of this.analyses) {
            for (const entry of a.entrypoints ?? []) {
                const base = `flow:${file}#${entry.kind}:${entry.label}`;
                const n = (used.get(base) ?? 0) + 1;
                used.set(base, n);
                const handler = this.handlerOf(entry, file);
                out.push({
                    id: n > 1 ? `${base}~${n}` : base,
                    kind: entry.kind,
                    label: entry.label,
                    framework: entry.framework,
                    file,
                    line: entry.line,
                    ...(handler ? { handler: this.keyOf(handler) } : {}),
                    entry,
                });
            }
        }
        out.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0) || (a.file < b.file ? -1 : 1));
        this.entries = out;
        return out;
    }

    private names(): Map<string, Target[]> {
        if (this.byName) return this.byName;
        const map = new Map<string, Target[]>();
        for (const [file, a] of this.analyses) {
            if (isTestPath(file)) continue;
            a.symbols.forEach((s, sym) => {
                if (!CALLABLE.has(s.kind)) return;
                const list = map.get(s.name);
                if (list) list.push({ file, sym });
                else map.set(s.name, [{ file, sym }]);
            });
        }
        this.byName = map;
        return map;
    }

    /** How many functions call each name (a helper called from everywhere is cross-cutting). */
    private callers(): Map<string, number> {
        if (this.callerCount) return this.callerCount;
        const map = new Map<string, number>();
        for (const a of this.analyses.values()) for (const c of a.calls ?? []) map.set(c.name, (map.get(c.name) ?? 0) + 1);
        this.callerCount = map;
        return map;
    }

    private imports(): Map<string, Set<string>> {
        if (this.importsOf) return this.importsOf;
        const { nodes, edges } = this.hierarchy.hierarchy;
        const map = new Map<string, Set<string>>();
        for (const e of edges) {
            const src = nodes[e.src];
            const dst = nodes[e.dst];
            if (src.kind !== 'module' || dst.kind !== 'module') continue;
            const set = map.get(src.path);
            if (set) set.add(dst.path);
            else map.set(src.path, new Set([dst.path]));
        }
        this.importsOf = map;
        return map;
    }

    private nodes(): Map<string, number> {
        if (this.nodeOf) return this.nodeOf;
        const map = new Map<string, number>();
        this.hierarchy.hierarchy.nodes.forEach((n, i) => {
            if (n.kind !== 'symbol' || n.startLine === undefined) return;
            const id = `${n.path}\u0000${n.startLine}\u0000${lastSegment(n.name)}`;
            if (!map.has(id)) map.set(id, i);
        });
        this.nodeOf = map;
        return map;
    }
}

/** Folder names that say nothing on their own: `packages/ai/src` reads better as `ai/src`. */
const VAGUE = new Set(['src', 'lib', 'app', 'apps', 'source', 'main', 'internal', 'pkg', 'java', 'kotlin', 'python', 'js', 'ts', 'code']);

function laneName(name: string, path: string): string {
    if (!VAGUE.has(name.toLowerCase())) return name;
    const parts = path.split('/').filter(Boolean);
    return parts.length >= 2 ? parts.slice(-2).join('/') : name;
}

function sharedPrefix(a: string, b: string): number {
    const x = a.split('/');
    const y = b.split('/');
    let n = 0;
    while (n < x.length && n < y.length && x[n] === y[n]) n++;
    return n;
}
