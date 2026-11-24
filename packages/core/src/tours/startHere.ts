/**
 * The generated "Start Here" tour: a deterministic walk that needs no AI.
 *
 *   1. The big picture       the top-level parts and the most depended-on one
 *   2. Where things start    the entrypoints, and one flow followed end to end
 *   3. The core              the most connected domain/API parts (up to 3)
 *   4. The data layer        where data is stored and read
 *   5. Integrations          the databases, APIs and queues flows reach
 *   6. Shared foundations    utilities, config and hubs everything leans on
 *   7. A first change        a tested, lightly used module outside cycles
 *
 * Steps that have nothing to show are left out. Bodies are built from the
 * index (names, roles, counts, dependencies); the Inspector beside the player
 * adds each part's summary card.
 */
import { TOUR_FILE_VERSION, type ComponentRole, type FlowSummary, type HierarchyNode, type Tour, type TourCodeRange, type TourStep } from '@codearchy/protocol';
import type { FlowIndex } from '../flows/trace.js';
import type { HierarchyIndex } from '../hierarchy/project.js';

export const START_HERE_ID = 'start-here';

const ROLE_WORDS: Record<ComponentRole, string> = {
    api: 'the API layer',
    ui: 'the user interface',
    domain: 'domain logic',
    data: 'data access',
    infra: 'infrastructure',
    config: 'configuration',
    test: 'tests',
    util: 'shared utilities',
};

const KIND_WORDS: Record<string, [string, string]> = {
    http: ['HTTP route', 'HTTP routes'],
    ui: ['UI route', 'UI routes'],
    cli: ['command', 'commands'],
    event: ['event handler or tool', 'event handlers and tools'],
    job: ['job', 'jobs'],
    main: ['program entry', 'program entries'],
};
const ENTRY_PREFERENCE = ['http', 'cli', 'event', 'job', 'ui', 'main'];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** Folder names that say nothing alone: `packages/core/src` reads better as `core/src`. */
const VAGUE = new Set(['src', 'lib', 'app', 'source', 'main', 'internal', 'pkg', 'java', 'kotlin', 'python', 'code']);
export function displayName(n: Pick<HierarchyNode, 'name' | 'path' | 'kind'>): string {
    if (n.kind === 'module' || !VAGUE.has(n.name.toLowerCase())) return n.name;
    const parts = n.path.split('/').filter(Boolean);
    return parts.length >= 2 ? parts.slice(-2).join('/') : n.name;
}
const link = (n: HierarchyNode) => `[${displayName(n)}](node:${n.key})`;
const article = (n: number) => (/^(8|11|18|8\d)$/.test(String(n)) ? 'An' : 'A');
function list(items: string[], max = 4): string {
    const shown = items.slice(0, max);
    const rest = items.length - shown.length;
    const tail = rest > 0 ? [...shown, `${rest} more`] : shown;
    return tail.length <= 1 ? (tail[0] ?? '') : `${tail.slice(0, -1).join(', ')} and ${tail[tail.length - 1]}`;
}

export interface StartHereOptions {
    /** The system's name (defaults to the root node's). */
    name?: string;
    /** Steps at most (default 10). */
    maxSteps?: number;
}

export function generateStartHere(index: HierarchyIndex, flows?: FlowIndex, options: StartHereOptions = {}): Tour {
    const { nodes } = index.hierarchy;
    const metrics = index.metrics;
    const root = nodes[0];
    const name = options.name ?? root.name;
    const steps: TourStep[] = [];
    const used = new Set<string>();
    const add = (step: Omit<TourStep, 'id'>) => {
        steps.push({ id: `s${steps.length + 1}`, ...step });
        if (step.target.node) used.add(step.target.node);
    };
    const m = (n: HierarchyNode) => metrics.nodes[n.tin];
    const degree = (n: HierarchyNode) => m(n).fanIn + m(n).fanOut;
    const isTesty = (n: HierarchyNode) => n.role?.role === 'test' || m(n).codeModules === 0;

    // Containers worth a stop: packages and components with real code, most connected first.
    const containers = nodes.filter((n) => (n.kind === 'package' || n.kind === 'component') && !isTesty(n) && n.modules >= 1);
    // Ties go to the higher level (a package over its own src folder).
    const byDegree = [...containers].sort((a, b) => degree(b) - degree(a) || a.depth - b.depth || b.modules - a.modules || (a.key < b.key ? -1 : 1));
    /** Parts featured as core, data or shared so far: one stop per area, never a part and its own folder. */
    const featured: HierarchyNode[] = [];
    const overlaps = (n: HierarchyNode) => featured.some((u) => index.contains(u.tin, n.tin) || index.contains(n.tin, u.tin));
    const notTest = (key: string) => index.node(key)?.role?.role !== 'test';

    // 1. The big picture.
    const top = index.childrenOf(0).map((i) => nodes[i]);
    const packages = nodes.filter((n) => n.kind === 'package').length;
    const mostUsed = [...top].filter((n) => !isTesty(n)).sort((a, b) => m(b).fanIn - m(a).fanIn)[0];
    add({
        target: { node: root.key },
        view: { mode: 'map', scope: root.key },
        title: `The big picture`,
        body: [
            `${name} has ${plural(root.modules, 'source file')} in ${plural(top.length, 'top-level part')}: ${list(top.map(link), 6)}.`,
            packages > 1 ? `It is split into ${plural(packages, 'package')}, each with its own manifest.` : '',
            mostUsed && m(mostUsed).fanIn > 0 ? `${link(mostUsed)} is the most depended-on part, so it's a good anchor while you explore.` : '',
            'Double-click a part on the map to open it in place; the Inspector on the right summarises whatever you select.',
        ]
            .filter(Boolean)
            .join(' '),
    });

    // 2. Where things start.
    const entries = flows?.list() ?? [];
    if (entries.length) {
        const counts = new Map<string, number>();
        for (const e of entries) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
        const kinds = ENTRY_PREFERENCE.filter((k) => counts.has(k)).map((k) => plural(counts.get(k)!, KIND_WORDS[k][0], KIND_WORDS[k][1]));
        const pick = pickFlow(entries, flows!);
        const traced = pick ? flows!.trace(pick.id) : undefined;
        const path = traced ? traced.lanes.map((l) => l.name) : [];
        const reaches = traced ? [...new Set(traced.sinks.map((s) => s.name))] : [];
        add({
            target: { flow: pick?.id, ...(traced?.handler ? { node: traced.handler } : {}) },
            view: { mode: 'flows' },
            title: 'Where things start',
            body: [
                `Execution enters ${name} through ${list(kinds)}.`,
                pick
                    ? `Follow ${pick.label} (${pick.framework}): it ${path.length > 1 ? `passes through ${list(path, 5)}` : `stays in ${path[0] ?? 'one part'}`}${reaches.length ? ` and reaches ${list(reaches)}` : ''}.`
                    : '',
                'Flows mode lists every entrypoint; pick one to see its calls step by step.',
            ]
                .filter(Boolean)
                .join(' '),
            ...(traced ? { code: [{ path: traced.file, start: traced.line + 1, end: traced.line + 1 }] } : {}),
        });
    }

    // 3. The core: the most connected domain / API parts (or the most connected parts at all).
    const coreRoles = new Set<ComponentRole | undefined>(['domain', 'api', 'ui', undefined]);
    const linkKey = (key: string) => {
        const x = index.node(key);
        return x ? link(x) : key;
    };
    for (let picked = 0; picked < 3; picked++) {
        const n = byDegree.find((c) => coreRoles.has(c.role?.role) && c.key !== root.key && degree(c) > 0 && !overlaps(c));
        if (!n) break;
        featured.push(n);
        const d = index.describe(n.key);
        const deps = d ? d.dependsOn.filter((l) => !l.outside && notTest(l.key)).slice(0, 3).map((l) => linkKey(l.key)) : [];
        const users = d ? d.usedBy.filter((l) => !l.outside && notTest(l.key)).slice(0, 3).map((l) => linkKey(l.key)) : [];
        add({
            target: { node: n.key },
            view: { mode: 'map', focus: n.key },
            title: n.role ? `The core: ${displayName(n)} (${ROLE_WORDS[n.role.role]})` : `The core: ${displayName(n)}`,
            body: [
                `${link(n)} holds ${plural(n.modules, 'file')}${n.role ? ` of ${ROLE_WORDS[n.role.role]}` : ''} and is one of the most connected parts of ${name}.`,
                deps.length ? `It relies on ${list(deps)}.` : '',
                users.length ? `It is used by ${list(users)}.` : '',
                keyFilesSentence(index, n),
            ]
                .filter(Boolean)
                .join(' '),
            code: keyCode(index, n),
        });
    }

    // 4. The data layer.
    const data = byDegree.find((n) => n.role?.role === 'data' && !overlaps(n));
    if (data) {
        featured.push(data);
        add({
            target: { node: data.key },
            view: { mode: 'map', focus: data.key },
            title: 'The data layer',
            body: [
                `${link(data)} is where data is stored and read (${data.role!.reason}).`,
                m(data).fanIn ? `${plural(m(data).fanIn, 'dependency', 'dependencies')} from the rest of the code point into it.` : '',
                keyFilesSentence(index, data),
            ]
                .filter(Boolean)
                .join(' '),
            code: keyCode(index, data),
        });
    }

    // 5. Integrations: what the flows reach.
    if (flows && entries.length) {
        const reached = new Map<string, { kind: string; file: string }>();
        for (const e of entries.slice(0, 60)) {
            const f = flows.trace(e.id);
            for (const s of f?.sinks ?? []) if (!reached.has(s.name)) reached.set(s.name, { kind: s.kind, file: f!.steps[s.step].file });
        }
        if (reached.size) {
            const byKind = new Map<string, string[]>();
            for (const [lib, { kind }] of reached) byKind.set(kind, [...(byKind.get(kind) ?? []), lib]);
            const first = [...reached.values()][0];
            const mod = index.node(`mod:${first.file}`);
            add({
                target: mod ? { node: mod.key } : {},
                view: mod ? { mode: 'map', focus: mod.key } : { mode: 'map' },
                title: 'Integrations',
                body: [
                    `The flows reach outside ${name} through ${list([...byKind].map(([kind, libs]) => `${kind === 'http' ? 'HTTP' : kind} (${list(libs, 3)})`))}.`,
                    mod ? `${link(mod)} is one place where that happens.` : '',
                    'These are the edges of the system: worth knowing before you change anything that writes data or calls out.',
                ]
                    .filter(Boolean)
                    .join(' '),
            });
        }
    }

    // 6. Shared foundations: utilities, config, infrastructure.
    const shared = byDegree.find((n) => (n.role?.role === 'util' || n.role?.role === 'infra' || n.role?.role === 'config') && !overlaps(n) && m(n).fanIn > 0);
    if (shared) {
        add({
            target: { node: shared.key },
            view: { mode: 'map', focus: shared.key },
            title: 'Shared foundations',
            body: [
                `${link(shared)} is ${ROLE_WORDS[shared.role!.role]} that other parts lean on (${plural(m(shared).fanIn, 'incoming dependency', 'incoming dependencies')}).`,
                m(shared).hubModules ? `${plural(m(shared).hubModules, 'file is a hub', 'files are hubs')}: a change there ripples widely.` : 'Changes here ripple to everything that uses it.',
            ].join(' '),
            code: keyCode(index, shared),
        });
    }

    // 7. A first change: tested, lightly used, outside cycles.
    const candidates: HierarchyNode[] = [];
    for (const [i, facts] of metrics.modules) {
        if (facts.tested && !facts.hub && !facts.cyclic && !facts.test) candidates.push(nodes[i]);
    }
    candidates.sort((a, b) => m(a).fanIn - m(b).fanIn || (a.key < b.key ? -1 : 1));
    const first = candidates.find((n) => !used.has(n.key));
    if (first) {
        const d = index.describe(first.key);
        add({
            target: { node: first.key },
            view: { mode: 'map', focus: first.key },
            title: 'A good first change',
            body: [
                `${link(first)} is a safe place to start changing code: it has tests${d?.testedBy?.length ? ` (${list(d.testedBy.map((p) => p.split('/').pop()!), 2)})` : ''}, few parts depend on it, and it isn't in a dependency cycle.`,
                'Make a small change, run its tests, and use the map to check what else could be affected.',
            ].join(' '),
            code: keyCode(index, first),
        });
    }

    return {
        version: TOUR_FILE_VERSION,
        id: START_HERE_ID,
        title: `Start here: ${name}`,
        origin: 'generated',
        description: `${article(steps.length)} ${steps.length}-step walk through ${name}: the big picture, where things start, the core, and where to make a first change.`,
        steps: steps.slice(0, options.maxSteps ?? 10),
    };
}

/** HTTP first, then commands…; within a kind, the route whose trace is longest (the most to see). */
function pickFlow(entries: FlowSummary[], flows: FlowIndex): FlowSummary | undefined {
    for (const kind of ENTRY_PREFERENCE) {
        const ofKind = entries.filter((e) => e.kind === kind).slice(0, 25);
        if (!ofKind.length) continue;
        let best = ofKind[0];
        let bestSteps = -1;
        for (const e of ofKind) {
            const n = flows.trace(e.id)?.steps.length ?? 0;
            if (n > bestSteps) {
                best = e;
                bestSteps = n;
            }
        }
        return best;
    }
    return undefined;
}

/** The modules inside a container that the rest of the code uses most. */
function keyModules(index: HierarchyIndex, n: HierarchyNode, max = 2): HierarchyNode[] {
    const { nodes } = index.hierarchy;
    const out: HierarchyNode[] = [];
    for (let i = n.tin; i <= n.tout; i++) if (nodes[i].kind === 'module' && nodes[i].role?.role !== 'test') out.push(nodes[i]);
    const fanIn = (x: HierarchyNode) => index.metrics.nodes[x.tin].fanIn;
    return out.sort((a, b) => fanIn(b) - fanIn(a) || (a.key < b.key ? -1 : 1)).slice(0, max);
}

function keyFilesSentence(index: HierarchyIndex, n: HierarchyNode): string {
    if (n.kind === 'module') return '';
    const files = keyModules(index, n);
    return files.length ? `Start reading at ${list(files.map(link))}.` : '';
}

/** The first top-level symbol of each key file (or its first lines), at most 40 lines each. */
function keyCode(index: HierarchyIndex, n: HierarchyNode): TourCodeRange[] {
    const { nodes } = index.hierarchy;
    const files = n.kind === 'module' ? [n] : keyModules(index, n);
    return files.map((f) => {
        let sym: HierarchyNode | undefined;
        for (let i = f.tin + 1; i <= f.tout; i++) {
            const s = nodes[i];
            if (s.kind === 'symbol' && s.parent === f.tin && s.startLine !== undefined) {
                if (s.exported) {
                    sym = s;
                    break;
                }
                sym ??= s;
            }
        }
        const start = (sym?.startLine ?? 0) + 1;
        const end = Math.min((sym?.endLine ?? 29) + 1, start + 39);
        return { path: f.path, start, end };
    });
}
