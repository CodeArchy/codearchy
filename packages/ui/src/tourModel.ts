/**
 * Tours mode, the pure part: a walk-through built from a flow, the draft tour
 * ("Add to tour" appends to it until it's saved), progress, and the view a
 * step asks the canvas for.
 */
import { TOUR_FILE_VERSION, type Flow, type Tour, type TourDetails, type TourStep } from '@codearchy/protocol';

/** Steps at most when a flow becomes a tour (beyond that it's a list, not a walk). */
const FLOW_TOUR_STEPS = 12;

/** A tour that walks a traced flow: its entrypoint, then each call in reading order. */
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
            target: { node: s.key },
            view: { mode: 'map', focus: s.key },
            title: s.name,
            body: [
                parent ? `${parent.name} calls ${s.name}${s.callSite ? ` on line ${s.callSite.line + 1} of ${s.callSite.file.split('/').pop()}` : ''}.` : `${s.name} handles ${flow.label}.`,
                `It lives in ${s.file} (${lane.get(s.lane) ?? s.lane}).`,
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

/** Appends a step to the draft, creating it on first use. */
export function addToDraft(draft: Tour | undefined, capture: StepCapture, tourTitle: string): Tour {
    const base: Tour = draft ?? { version: TOUR_FILE_VERSION, id: 'draft', title: tourTitle.trim() || 'My tour', origin: 'authored', steps: [] };
    const used = new Set(base.steps.map((s) => s.id));
    let n = base.steps.length + 1;
    while (used.has(`s${n}`)) n++;
    const step: TourStep = { id: `s${n}`, target: capture.target, view: capture.view, title: capture.title.trim() || 'Untitled step', body: capture.body.trim(), ...(capture.code?.length ? { code: capture.code } : {}) };
    return { ...base, title: draft ? base.title : tourTitle.trim() || base.title, steps: [...base.steps, step] };
}

export function removeFromDraft(draft: Tour, stepId: string): Tour | undefined {
    const steps = draft.steps.filter((s) => s.id !== stepId);
    return steps.length ? { ...draft, steps } : undefined;
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

export function loadDraft(workspace: string): Tour | undefined {
    try {
        const raw = JSON.parse(storage.get(draftKey(workspace)) ?? 'null') as Tour | null;
        return raw && Array.isArray(raw.steps) && raw.steps.length ? raw : undefined;
    } catch {
        return undefined;
    }
}

export function saveDraft(workspace: string, draft: Tour | undefined): void {
    storage.set(draftKey(workspace), draft ? JSON.stringify(draft) : undefined);
}
