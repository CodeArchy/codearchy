/**
 * Flows: what happens when a request, command or job enters the system,
 * traced from its entrypoint through the calls it makes and lifted onto the
 * components it passes through (the Flows mode's swimlanes).
 */
import type { EntryPointKind } from './index.js';

export interface FlowSummary {
    /** Stable for a workspace: the entry's file, line and label. */
    id: string;
    kind: EntryPointKind;
    label: string;
    framework: string;
    /** Workspace path of the declaring file. */
    file: string;
    /** 0-based. */
    line: number;
    /** Hierarchy key of the handler symbol, when it could be found. */
    handler?: string;
}

/** How a call was matched to the symbol it reaches. */
export type FlowResolution = 'entry' | 'local' | 'import' | 'name';

export interface FlowStep {
    /** Hierarchy key of the symbol (`sym:path#name`). */
    key: string;
    name: string;
    file: string;
    /** 0-based line of the symbol. */
    line: number;
    /** Hierarchy key of the swimlane (component or package) this step belongs to. */
    lane: string;
    depth: number;
    /** Index of the step that called this one (absent for the entry). */
    parent?: number;
    /** Where the call was made (the caller's file and 0-based line). */
    callSite?: { file: string; line: number };
    resolution: FlowResolution;
    /** A widely shared helper: shown, not followed. */
    crossCutting?: boolean;
}

export type SinkKind = 'database' | 'http' | 'queue' | 'cache' | 'storage';

export interface FlowSink {
    kind: SinkKind;
    /** The library or service (from the import): `pg`, `axios`, `kafkajs`… */
    name: string;
    /** The step whose file imports it. */
    step: number;
}

export interface Flow extends FlowSummary {
    steps: FlowStep[];
    /** Swimlanes in order of first appearance. */
    lanes: Array<{ key: string; name: string; kind: string }>;
    sinks: FlowSink[];
    /** Some hop was matched by name only (no import or same-file evidence). */
    approximate: boolean;
    /** The depth or size limit cut the trace short. */
    truncated: boolean;
}
