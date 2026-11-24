/**
 * The architecture diagram: the system at a glance, in layers. The parts are
 * real (hierarchy keys), dependencies come from the index, and the systems it
 * talks to come from the flows (databases, HTTP APIs, queues…). Built without
 * AI from the code's own structure; with AI, the architect model designs it:
 * it groups the code into named subsystems, services and layers, says what
 * each is responsible for, adds the systems around it and the relationships,
 * and names the pattern (like v1's System view). It can only group real code:
 * every part points at hierarchy nodes, and code it leaves out is kept.
 */
import type { ComponentRole } from './hierarchy.js';
import type { SinkKind } from './flows.js';

export type ArchLayer = 'actors' | 'interface' | 'application' | 'domain' | 'data' | 'infrastructure' | 'shared' | 'external';

export interface ArchNode {
    id: string;
    label: string;
    /** part: code in the repository · external: a system it talks to · actor: who calls in. */
    kind: 'part' | 'external' | 'actor';
    /** How the architect model sees a part (AI designs only). */
    type?: 'subsystem' | 'layer' | 'service';
    layer: ArchLayer;
    description: string;
    /** The hierarchy nodes it stands for (parts: one, or the several an AI design groups), for "show on the map". */
    parts: string[];
    role?: ComponentRole;
    files?: number;
    sink?: SinkKind;
}

export interface ArchEdge {
    source: string;
    target: string;
    label: string;
    kind: 'depends' | 'request' | 'data' | 'event';
    /** Dependencies behind it (parts). */
    weight?: number;
}

export interface Architecture {
    pattern: string;
    summary: string;
    nodes: ArchNode[];
    edges: ArchEdge[];
    source: 'deterministic' | 'ai';
    provider?: string;
    model?: string;
    /** Why the AI description isn't there (no model, blocked by privacy…). */
    note?: string;
    createdAt: number;
}

/** Layers top to bottom, as drawn. */
export const ARCH_LAYERS: ArchLayer[] = ['actors', 'interface', 'application', 'domain', 'data', 'infrastructure', 'shared', 'external'];
