/**
 * Tours: an ordered walk through the codebase. Each step points at a part of
 * the map, a flow or lines of code, says how the canvas should look, and
 * explains in a few sentences why that piece matters.
 *
 * A "Start Here" tour is generated from the index; authored tours live in the
 * repository as `.codearchy/tours/<slug>.json`, so they're reviewed like code.
 */

export const TOUR_FILE_VERSION = 1;

/** 1-based, inclusive. */
export interface TourCodeRange {
    path: string;
    start: number;
    end: number;
}

export interface TourStep {
    /** Unique within the tour. */
    id: string;
    /** What the step is about: a hierarchy key, a flow id, or both. */
    target: { node?: string; flow?: string };
    /** How the canvas looks for this step (defaults: the Map, focused on the target node). */
    view?: { mode?: 'map' | 'matrix' | 'flows'; scope?: string; focus?: string; lens?: string };
    title: string;
    /** 2–6 sentences; plain text with `[Name](node:key)` links allowed. */
    body: string;
    /** The lines worth reading for this step. */
    code?: TourCodeRange[];
    /** Hash of the target's content when the step was written: a different hash marks it stale. */
    anchorHash?: string;
}

export type TourOrigin = 'generated' | 'authored';

/** The `.codearchy/tours/*.json` format (also how the engine hands tours to the UI). */
export interface Tour {
    version: typeof TOUR_FILE_VERSION;
    /** Stable: the file's slug for authored tours, `start-here` for the generated one. */
    id: string;
    title: string;
    origin: TourOrigin;
    description?: string;
    steps: TourStep[];
}

export interface TourSummary {
    id: string;
    title: string;
    origin: TourOrigin;
    description?: string;
    steps: number;
    /** Workspace path of an authored tour's file. */
    file?: string;
    /** Authored steps whose target is gone or changed since they were written. */
    stale: number;
    /** The file couldn't be read as a tour (shown so the author can fix it). */
    error?: string;
}

export interface TourStepStatus {
    /** `missing`: the target no longer exists; `changed`: its content differs from when the step was written. */
    stale?: 'missing' | 'changed';
    /** Human-readable detail for the author. */
    reason?: string;
}

export interface TourDetails extends Tour {
    file?: string;
    /** Per step, same order as `steps`. */
    status: TourStepStatus[];
}
