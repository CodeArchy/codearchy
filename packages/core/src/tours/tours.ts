/**
 * Tours from the workspace: the generated Start Here tour plus authored tours
 * in `.codearchy/tours/*.json`. Authored files are validated (they come from
 * the repository, so a hand edit can break them) and every step is checked
 * against the current index: a target that disappeared is `missing`, one whose
 * content hash moved is `changed`.
 */
import { TOUR_FILE_VERSION, type Tour, type TourCodeRange, type TourDetails, type TourStep, type TourStepStatus, type TourSummary } from '@codearchy/protocol';
import type { FlowIndex } from '../flows/trace.js';
import type { HierarchyIndex } from '../hierarchy/project.js';
import { TOURS_DIR } from '../discovery/classify.js';
import { contentHash } from '../util/hash.js';
import { START_HERE_ID, generateStartHere } from './startHere.js';

const MAX_STEPS = 200;
const MAX_TEXT = 4000;
const MAX_CODE_RANGES = 10;
const MAX_TOUR_BYTES = 1_000_000;

export type TourParse = { ok: true; tour: Tour } | { ok: false; error: string };

/** `.codearchy/tours/onboarding.json` → `onboarding`. */
export function tourSlug(path: string): string {
    const name = path.split('/').pop() ?? path;
    return name.endsWith('.json') ? name.slice(0, -5) : name;
}

/** Validates a tour file; the id comes from the file name, so renaming a file renames the tour. */
export function parseTour(text: string, path: string): TourParse {
    if (text.length > MAX_TOUR_BYTES) return { ok: false, error: 'The file is larger than 1 MB' };
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (err) {
        return { ok: false, error: `Not valid JSON: ${(err as Error).message}` };
    }
    if (!isObject(raw)) return { ok: false, error: 'Expected a JSON object' };
    if (raw.version !== TOUR_FILE_VERSION) return { ok: false, error: `Unsupported "version" (expected ${TOUR_FILE_VERSION})` };
    if (!isText(raw.title)) return { ok: false, error: '"title" must be a non-empty string' };
    if (!Array.isArray(raw.steps) || raw.steps.length === 0) return { ok: false, error: '"steps" must be a non-empty array' };
    if (raw.steps.length > MAX_STEPS) return { ok: false, error: `At most ${MAX_STEPS} steps` };
    const steps: TourStep[] = [];
    const ids = new Set<string>();
    for (let i = 0; i < raw.steps.length; i++) {
        const s: unknown = raw.steps[i];
        const at = `step ${i + 1}`;
        if (!isObject(s)) return { ok: false, error: `${at}: expected an object` };
        if (!isText(s.title)) return { ok: false, error: `${at}: "title" must be a non-empty string` };
        if (typeof s.body !== 'string') return { ok: false, error: `${at}: "body" must be a string` };
        const target = isObject(s.target) ? s.target : {};
        const node = isText(target.node) ? target.node : undefined;
        const flow = isText(target.flow) ? target.flow : undefined;
        const code = Array.isArray(s.code) ? s.code.slice(0, MAX_CODE_RANGES) : [];
        const ranges: TourCodeRange[] = [];
        for (const c of code) {
            if (!isObject(c) || !isText(c.path) || !isLine(c.start) || !isLine(c.end) || c.end < c.start || c.path.includes('..')) return { ok: false, error: `${at}: each "code" range needs a path and 1-based start ≤ end` };
            ranges.push({ path: c.path, start: c.start, end: c.end });
        }
        if (!node && !flow && !ranges.length) return { ok: false, error: `${at}: needs a target node, a flow or code` };
        let id = isText(s.id) ? s.id : `s${i + 1}`;
        while (ids.has(id)) id = `${id}-${i + 1}`;
        ids.add(id);
        const view = isObject(s.view) ? s.view : undefined;
        steps.push({
            id,
            target: { ...(node ? { node } : {}), ...(flow ? { flow } : {}) },
            ...(view ? { view: cleanView(view) } : {}),
            title: s.title.slice(0, 200),
            body: s.body.slice(0, MAX_TEXT),
            ...(ranges.length ? { code: ranges } : {}),
            ...(isText(s.anchorHash) ? { anchorHash: s.anchorHash } : {}),
        });
    }
    return {
        ok: true,
        tour: {
            version: TOUR_FILE_VERSION,
            id: tourSlug(path),
            title: raw.title.slice(0, 200),
            origin: 'authored',
            ...(isText(raw.description) ? { description: raw.description.slice(0, MAX_TEXT) } : {}),
            steps,
        },
    };
}

export interface TourSources {
    index: HierarchyIndex;
    flows?: FlowIndex;
    /** Workspace paths of authored tour files (`DiscoveryResult.tours`). */
    files: string[];
    read(path: string): Promise<string | undefined>;
    /** For the Start Here title (defaults to the root node's name). */
    name?: string;
}

/**
 * What a step's anchor covers: the code ranges' text when it has some, else
 * the target node's identity (kind, path and, for a symbol, its line span).
 */
export async function anchorFor(step: Pick<TourStep, 'target' | 'code'>, index: HierarchyIndex, read: (path: string) => Promise<string | undefined>): Promise<string | undefined> {
    if (step.code?.length) {
        const parts: string[] = [];
        for (const c of step.code) {
            const text = await read(c.path);
            if (text === undefined) return undefined;
            parts.push(`${c.path}\n${text.split('\n').slice(c.start - 1, c.end).join('\n')}`);
        }
        return contentHash(parts.join('\n\u0000\n'));
    }
    const n = step.target.node ? index.node(step.target.node) : undefined;
    if (!n) return undefined;
    return contentHash(`${n.kind}\n${n.path}\n${n.kind === 'symbol' ? `${(n.endLine ?? 0) - (n.startLine ?? 0)}` : ''}`);
}

export class TourIndex {
    private startHere?: Tour;
    private authored?: Promise<Map<string, { file: string; parse: TourParse }>>;

    constructor(private readonly sources: TourSources) {}

    async list(): Promise<TourSummary[]> {
        const out: TourSummary[] = [];
        const authored = await this.loadAuthored();
        // A committed Start Here tour replaces the generated one.
        if (!authored.has(START_HERE_ID)) {
            const g = this.generated();
            out.push({ id: g.id, title: g.title, origin: 'generated', ...(g.description ? { description: g.description } : {}), steps: g.steps.length, stale: 0 });
        }
        for (const [id, { file, parse }] of authored) {
            if (!parse.ok) {
                out.push({ id, title: id, origin: 'authored', steps: 0, file, stale: 0, error: parse.error });
                continue;
            }
            const status = await this.check(parse.tour);
            const t = parse.tour;
            out.push({ id, title: t.title, origin: 'authored', ...(t.description ? { description: t.description } : {}), steps: t.steps.length, file, stale: status.filter((s) => s.stale).length });
        }
        return out;
    }

    async get(id: string): Promise<TourDetails | undefined> {
        const authored = (await this.loadAuthored()).get(id);
        if (authored) {
            if (!authored.parse.ok) return undefined;
            return { ...authored.parse.tour, file: authored.file, status: await this.check(authored.parse.tour) };
        }
        if (id !== START_HERE_ID) return undefined;
        const g = this.generated();
        return { ...g, status: g.steps.map(() => ({})) };
    }

    /** Each step against the current index: is its target still there, and unchanged? */
    async check(tour: Tour): Promise<TourStepStatus[]> {
        const { index, flows, read } = this.sources;
        const flowIds = flows ? new Set(flows.list().map((f) => f.id)) : undefined;
        const out: TourStepStatus[] = [];
        for (const step of tour.steps) {
            const node = step.target.node;
            if (node && !index.node(node)) {
                out.push({ stale: 'missing', reason: `${node} is no longer in the index` });
                continue;
            }
            if (step.target.flow && flowIds && !flowIds.has(step.target.flow)) {
                out.push({ stale: 'missing', reason: 'The flow is no longer found' });
                continue;
            }
            const missingFile = step.code?.find((c) => !index.node(`mod:${c.path}`));
            if (missingFile) {
                out.push({ stale: 'missing', reason: `${missingFile.path} is no longer indexed` });
                continue;
            }
            if (step.anchorHash) {
                const now = await anchorFor(step, index, read);
                if (now !== step.anchorHash) {
                    out.push({ stale: 'changed', reason: step.code?.length ? 'The code it points at has changed' : 'The part it points at has changed' });
                    continue;
                }
            }
            out.push({});
        }
        return out;
    }

    private generated(): Tour {
        this.startHere ??= generateStartHere(this.sources.index, this.sources.flows, this.sources.name ? { name: this.sources.name } : {});
        return this.startHere;
    }

    private loadAuthored(): Promise<Map<string, { file: string; parse: TourParse }>> {
        this.authored ??= (async () => {
            const map = new Map<string, { file: string; parse: TourParse }>();
            for (const file of [...this.sources.files].sort()) {
                if (!file.startsWith(`${TOURS_DIR}/`)) continue;
                const text = await this.sources.read(file);
                const parse: TourParse = text === undefined ? { ok: false, error: "The file couldn't be read" } : parseTour(text, file);
                map.set(tourSlug(file), { file, parse });
            }
            return map;
        })();
        return this.authored;
    }
}

function cleanView(v: Record<string, unknown>): NonNullable<TourStep['view']> {
    const mode = v.mode === 'map' || v.mode === 'matrix' || v.mode === 'flows' ? v.mode : undefined;
    return {
        ...(mode ? { mode } : {}),
        ...(isText(v.scope) ? { scope: v.scope } : {}),
        ...(isText(v.focus) ? { focus: v.focus } : {}),
        ...(isText(v.lens) ? { lens: v.lens } : {}),
    };
}

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isText(v: unknown): v is string {
    return typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_TEXT;
}
function isLine(v: unknown): v is number {
    return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 10_000_000;
}
