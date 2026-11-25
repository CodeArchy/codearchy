/**
 * Tours mode, the pure part: a walk-through built from a flow, the draft tour
 * ("Add to tour" appends to it until it's saved), progress, and the view a
 * step asks the canvas for.
 */
import { TOUR_FILE_VERSION, type Flow, type Tour, type TourDetails, type TourStep } from '@codearchy/protocol';

/** Steps at most when a flow becomes a tour (beyond that it's a list, not a walk). */
const FLOW_TOUR_STEPS = 12;

/**
 * A tour that walks a traced flow: its entrypoint, then each call in reading
 * order. Every step stays in Flows, on the flow's sequence, with the step's
 * call highlighted; each body links the file so "show on the map" is a click.
 */
export function tourFromFlow(flow: Flow, order: number[] = flow.steps.map((_, i) => i)): TourDetails {
    const lane = new Map(flow.lanes.map((l) => [l.key, l.name]));
    const steps: TourStep[] = [
        {
            id: 'entry',
            target: { flow: flow.id, ...(flow.handler ? { node: flow.handler } : {}) },
            view: { mode: 'flows' },
            title: flow.label,
            body: `${flow.label} (${flow.framework}) is declared in ${flow.file}. Its trace has ${flow.steps.length} step${flow.steps.length === 1 ? '' : 's'} across ${flow.lanes.map((l) => l.name).join(', ')}${flow.sinks.length ? `, and reaches ${[...new Set(flow.sinks.map((s) => s.name))].join(', ')}` : ''}.`,
            code: [{ path: flow.file, start: flow.line + 1, end: flow.line + 1 }],
        },
    ];
    for (const i of order) {
        if (steps.length > FLOW_TOUR_STEPS) break;
        const s = flow.steps[i];
        if (!s || s.crossCutting) continue;
        const parent = s.parent !== undefined ? flow.steps[s.parent] : undefined;
        const sinks = flow.sinks.filter((k) => k.step === i).map((k) => `${k.name} (${k.kind})`);
        steps.push({
            id: `step-${i}`,
            target: { flow: flow.id, node: s.key },
            view: { mode: 'flows', focus: s.key },
            title: s.name,
            body: [
                parent ? `${parent.name} calls ${s.name}${s.callSite ? ` on line ${s.callSite.line + 1} of ${s.callSite.file.split('/').pop()}` : ''}.` : `${s.name} handles ${flow.label}.`,
                `It lives in [${s.file.split('/').pop()}](node:mod:${s.file}) (${lane.get(s.lane) ?? s.lane}).`,
                s.resolution === 'name' ? 'This call was matched by name only, so double-check it.' : '',
                sinks.length ? `This file talks to ${sinks.join(', ')}.` : '',
            ]
                .filter(Boolean)
                .join(' '),
            code: [{ path: s.file, start: s.line + 1, end: s.line + 1 }],
        });
    }
    return {
        version: TOUR_FILE_VERSION,
        id: `flow-walk:${flow.id}`,
        title: `Walk through ${flow.label}`,
        origin: 'generated',
        steps,
        status: steps.map(() => ({})),
    };
}

/** The first step not yet done (where "Resume" starts), or 0. */
export function firstUndone(tour: Pick<Tour, 'steps'>, done: ReadonlySet<string>): number {
    const i = tour.steps.findIndex((s) => !done.has(s.id));
    return i < 0 ? 0 : i;
}

/** What "Add to tour" captures from the canvas. */
export interface StepCapture {
    title: string;
    body: string;
    target: TourStep['target'];
    view: NonNullable<TourStep['view']>;
    code?: TourStep['code'];
}

/**
 * The draft: the one tour being written in this workspace. `replaces` is set
 * when it's an edit of a tour saved in the repository (saving overwrites that
 * file); otherwise saving creates a new one.
 */
export type DraftTour = Tour & { replaces?: string };

/** Appends a step to the draft, creating it on first use. */
export function addToDraft(draft: DraftTour | undefined, capture: StepCapture, tourTitle: string): DraftTour {
    const base: DraftTour = draft ?? { version: TOUR_FILE_VERSION, id: 'draft', title: tourTitle.trim() || 'My tour', origin: 'authored', steps: [] };
    const used = new Set(base.steps.map((s) => s.id));
    let n = base.steps.length + 1;
    while (used.has(`s${n}`)) n++;
    const step: TourStep = { id: `s${n}`, target: capture.target, view: capture.view, title: capture.title.trim() || 'Untitled step', body: capture.body.trim(), ...(capture.code?.length ? { code: capture.code } : {}) };
    return { ...base, title: draft ? base.title : tourTitle.trim() || base.title, steps: [...base.steps, step] };
}

export function removeFromDraft(draft: DraftTour, stepId: string): DraftTour | undefined {
    const steps = draft.steps.filter((s) => s.id !== stepId);
    return steps.length ? { ...draft, steps } : undefined;
}

/**
 * A tour as a draft to edit. `edit` keeps the repository tour's id, so saving
 * replaces its file; otherwise it's a copy that saves as a new tour.
 */
export function draftFrom(tour: Tour, edit = false): DraftTour {
    const replace = edit && tour.origin === 'authored' && tour.id !== 'draft';
    return {
        version: TOUR_FILE_VERSION,
        id: 'draft',
        title: replace ? tour.title : `${tour.title} (my copy)`,
        origin: 'authored',
        ...(tour.description ? { description: tour.description } : {}),
        steps: tour.steps.map(({ id, target, view, title, body, code }) => ({ id, target, ...(view ? { view } : {}), title, body, ...(code?.length ? { code } : {}) })),
        ...(replace ? { replaces: tour.id } : {}),
    };
}

/** Moves a step up (-1) or down (+1); out of range leaves it where it is. */
export function moveStep(draft: DraftTour, stepId: string, delta: number): DraftTour {
    const i = draft.steps.findIndex((s) => s.id === stepId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= draft.steps.length) return draft;
    const steps = [...draft.steps];
    [steps[i], steps[j]] = [steps[j]!, steps[i]!];
    return { ...draft, steps };
}

export function updateStep(draft: DraftTour, stepId: string, patch: { title?: string; body?: string }): DraftTour {
    return { ...draft, steps: draft.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)) };
}

/** The tour to hand the engine for saving: a draft edit keeps its file's id. */
export function tourToSave(draft: DraftTour): Tour {
    const { replaces, ...tour } = draft;
    return { ...tour, id: replaces ?? 'draft', title: tour.title.trim() || 'My tour' };
}

/** The `.codearchy/tours` file format (the engine validates the same shape when reading). */
export function tourFile(t: Tour): string {
    const { version, title, description, steps } = t;
    return `${JSON.stringify({ version, title, ...(description ? { description } : {}), steps }, null, 2)}\n`;
}

export function slug(title: string): string {
    return (
        title
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean)
            .join('-')
            .slice(0, 60) || 'tour'
    );
}

/** Where a step puts the canvas: the mode, and the node to show (if any). */
export function stepView(step: TourStep): { mode: 'map' | 'matrix' | 'flows'; node?: string; scope?: string; flow?: string; lens?: string } {
    const v = step.view ?? {};
    const mode = v.mode ?? (step.target.flow && !step.target.node ? 'flows' : 'map');
    return {
        mode,
        ...(v.focus ?? step.target.node ? { node: v.focus ?? step.target.node } : {}),
        ...(v.scope ? { scope: v.scope } : {}),
        ...(step.target.flow ? { flow: step.target.flow } : {}),
        ...(v.lens ? { lens: v.lens } : {}),
    };
}

// ─── per-viewer storage (progress and the draft) ────────────────────────────

/** localStorage when the host allows it; nothing breaks without it. */
const storage = {
    get(key: string): string | undefined {
        try {
            return globalThis.localStorage?.getItem(key) ?? undefined;
        } catch {
            return undefined;
        }
    },
    set(key: string, value: string | undefined): void {
        try {
            if (value === undefined) globalThis.localStorage?.removeItem(key);
            else globalThis.localStorage?.setItem(key, value);
        } catch {
            // private mode or blocked storage: progress just isn't kept
        }
    },
};

const narrateKey = 'codearchy.tour.narrate';
const autoKey = 'codearchy.tour.autoplay';

/** Narration is on unless the viewer turned it off. */
export function loadNarration(): { narrate: boolean; auto: boolean } {
    return { narrate: storage.get(narrateKey) !== 'off', auto: storage.get(autoKey) === 'on' };
}

export function saveNarration(p: { narrate: boolean; auto: boolean }): void {
    storage.set(narrateKey, p.narrate ? undefined : 'off');
    storage.set(autoKey, p.auto ? 'on' : undefined);
}

const progressKey = (workspace: string, tourId: string) => `codearchy.tour.progress:${workspace}:${tourId}`;
const draftKey = (workspace: string) => `codearchy.tour.draft:${workspace}`;

export function loadProgress(workspace: string, tourId: string): Set<string> {
    try {
        const raw = JSON.parse(storage.get(progressKey(workspace, tourId)) ?? '[]') as unknown;
        return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
    } catch {
        return new Set();
    }
}

export function saveProgress(workspace: string, tourId: string, done: ReadonlySet<string>): void {
    storage.set(progressKey(workspace, tourId), done.size ? JSON.stringify([...done]) : undefined);
}

export function loadDraft(workspace: string): DraftTour | undefined {
    try {
        const raw = JSON.parse(storage.get(draftKey(workspace)) ?? 'null') as DraftTour | null;
        return raw && Array.isArray(raw.steps) && raw.steps.length ? raw : undefined;
    } catch {
        return undefined;
    }
}

export function saveDraft(workspace: string, draft: DraftTour | undefined): void {
    storage.set(draftKey(workspace), draft ? JSON.stringify(draft) : undefined);
}

/**
 * An answer's walkthrough as tour steps: one step per paragraph (or list
 * item) that links a part of the map, at that part; text without a link
 * joins the step before it (or the first). Line by line, no backtracking.
 */
export function capturesFromAnswer(answer: string): StepCapture[] {
    const blocks: string[] = [];
    let current: string[] = [];
    const flush = () => {
        const text = current.join('\n').trim();
        if (text) blocks.push(text);
        current = [];
    };
    for (const line of answer.split('\n')) {
        const t = line.trim();
        if (!t) flush();
        else {
            if (/^([-*+]|\d{1,3}[.)])\s/.test(t)) flush();
            current.push(line);
        }
    }
    flush();
    const out: StepCapture[] = [];
    let lead = '';
    for (const b of blocks) {
        const link = firstNodeLink(b);
        if (!link) {
            if (out.length) out[out.length - 1]!.body += `\n\n${b}`;
            else lead += `${b}\n\n`;
            continue;
        }
        out.push({ title: link.label, body: `${lead}${b}`, target: { node: link.key }, view: { mode: 'map', focus: link.key } });
        lead = '';
    }
    return out;
}

/** The first `[label](node:key)` in a text (a plain scan). */
function firstNodeLink(text: string): { label: string; key: string } | undefined {
    for (let i = text.indexOf('['); i >= 0; i = text.indexOf('[', i + 1)) {
        const close = text.indexOf('](node:', i);
        if (close < 0) return undefined;
        const end = text.indexOf(')', close);
        const label = text.slice(i + 1, close);
        if (end > close && !label.includes('[') && !label.includes(']')) return { label, key: text.slice(close + 7, end) };
    }
    return undefined;
}
