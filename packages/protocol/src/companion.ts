/**
 * The Companion protocol: `codearchy serve` runs the engine natively and the
 * web app talks to it over a WebSocket on 127.0.0.1. JSON text frames.
 *
 *   1. The page opens `ws://127.0.0.1:<port>/` (the server checks Origin and Host).
 *   2. Its first frame authenticates: `pair` with the one-time token from the
 *      pairing link, or `resume` with the session key a previous pairing gave.
 *   3. The server answers `ready` (with the session key and workspace summary),
 *      then serves `request`s and pushes `event`s until the socket closes.
 */
import type { EngineEvent, WorkspaceSummary } from './engine.js';

export const COMPANION_PROTOCOL = 1;

/** The engine requests a Companion serves (all read-only). */
export const COMPANION_METHODS = ['summary', 'view', 'children', 'describe', 'explain', 'search', 'flows', 'flow', 'tours', 'tour', 'anchorTour', 'readFile', 'authorshipStatus', 'authorship'] as const;
export type CompanionMethod = (typeof COMPANION_METHODS)[number];

export type CompanionClientMessage =
    | { type: 'pair'; protocol: number; token: string }
    | { type: 'resume'; protocol: number; session: string }
    | { type: 'request'; id: number; method: CompanionMethod; params?: Record<string, unknown> };

export type CompanionServerMessage =
    | { type: 'ready'; protocol: number; session: string; summary: WorkspaceSummary; version: string }
    | { type: 'response'; id: number; result?: unknown; error?: string }
    | { type: 'event'; event: EngineEvent };

/** WebSocket close codes the server uses (4000–4999 are application codes). */
export const COMPANION_CLOSE = {
    /** The first frame wasn't a valid pair/resume (wrong, used or expired token; unknown session). */
    unauthorized: 4401,
    /** No authentication within the time limit. */
    authTimeout: 4408,
    /** Too many requests. */
    rateLimited: 4429,
    /** A protocol version this server doesn't speak. */
    protocol: 4400,
} as const;
