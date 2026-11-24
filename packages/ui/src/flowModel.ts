/**
 * Flows mode, the pure part: grouping and filtering the entrypoint list, and
 * turning a traced flow into rows of a swimlane sequence (call order, each
 * call under its caller, with the lane it starts from).
 */
import type { EntryPointKind, Flow, FlowSink, FlowStep, FlowSummary } from '@codearchy/protocol';

export const FLOW_KINDS: Array<{ kind: EntryPointKind; title: string }> = [
    { kind: 'http', title: 'HTTP routes' },
    { kind: 'ui', title: 'UI routes' },
    { kind: 'cli', title: 'Commands' },
    { kind: 'event', title: 'Events & tools' },
    { kind: 'job', title: 'Jobs' },
    { kind: 'main', title: 'Programs' },
];

export interface FlowGroup {
    kind: EntryPointKind;
    title: string;
    flows: FlowSummary[];
}

/** Flows grouped by kind (in FLOW_KINDS order), keeping only those matching every word of `query`. */
export function groupFlows(flows: FlowSummary[], query = ''): FlowGroup[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (f: FlowSummary) => {
        if (!words.length) return true;
        const text = `${f.label} ${f.framework} ${f.file} ${f.kind}`.toLowerCase();
        return words.every((w) => text.includes(w));
    };
    return FLOW_KINDS.map(({ kind, title }) => ({ kind, title, flows: flows.filter((f) => f.kind === kind && matches(f)) })).filter((g) => g.flows.length > 0);
}

/** `GET /api/users` → verb `GET`, rest `/api/users`; other labels have no verb. */
export function splitLabel(label: string): { verb?: string; rest: string } {
    const sp = label.indexOf(' ');
    const verb = sp > 0 ? label.slice(0, sp) : '';
    return /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY|WS)$/.test(verb) || verb === 'resources' ? { verb, rest: label.slice(sp + 1) } : { rest: label };
}

export interface FlowRow {
    /** Index into `flow.steps`. */
    index: number;
    step: FlowStep;
    /** Column of the step's lane. */
    lane: number;
    /** Column of the caller's lane (absent for the entry). */
    from?: number;
    sinks: FlowSink[];
}

/**
 * The steps in reading order: depth-first, each call right under its caller,
 * siblings in call order (the trace itself is breadth-first).
 */
export function flowRows(flow: Flow): FlowRow[] {
    const laneIndex = new Map(flow.lanes.map((l, i) => [l.key, i]));
    const children = new Map<number, number[]>();
    flow.steps.forEach((s, i) => {
        if (s.parent === undefined) return;
        const list = children.get(s.parent);
        if (list) list.push(i);
        else children.set(s.parent, [i]);
    });
    const sinksAt = new Map<number, FlowSink[]>();
    for (const sink of flow.sinks) sinksAt.set(sink.step, [...(sinksAt.get(sink.step) ?? []), sink]);
    const out: FlowRow[] = [];
    const seen = new Set<number>();
    const visit = (i: number) => {
        if (seen.has(i)) return;
        seen.add(i);
        const step = flow.steps[i];
        const parent = step.parent !== undefined ? flow.steps[step.parent] : undefined;
        out.push({
            index: i,
            step,
            lane: laneIndex.get(step.lane) ?? 0,
            ...(parent ? { from: laneIndex.get(parent.lane) ?? 0 } : {}),
            sinks: sinksAt.get(i) ?? [],
        });
        for (const c of children.get(i) ?? []) visit(c);
    };
    flow.steps.forEach((s, i) => s.parent === undefined && visit(i));
    return out;
}

/** The modules a flow passes through, for "Show on map". */
export function flowModules(flow: Flow): string[] {
    return [...new Set(flow.steps.map((s) => `mod:${s.file}`))];
}
