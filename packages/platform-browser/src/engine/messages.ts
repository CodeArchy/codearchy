/** Messages between WorkerEngine (UI thread) and runEngineWorker (module Worker). */
import type { EngineEvent } from '@codearchy/protocol';

/**
 * Where a workspace comes from.
 *   handle  a folder from showDirectoryPicker() / a dropped folder (Chromium): read in
 *           place; with `watch`, changes on disk are picked up while it's open
 *   files   files with their workspace paths (<input webkitdirectory>, a dropped folder elsewhere)
 *   zip     a .zip archive (a GitHub download, an export); a single top folder is stripped
 *   texts   path → text (samples, fixtures, tests)
 *   repository  a public GitHub or GitLab repository by URL, downloaded by the worker (see repository.ts)
 */
export type EngineSource =
    | { kind: 'handle'; handle: FileSystemDirectoryHandle; watch?: boolean }
    | { kind: 'files'; name: string; files: Array<{ path: string; file: File }> }
    | { kind: 'zip'; name: string; data: ArrayBuffer }
    | { kind: 'texts'; name: string; files: Record<string, string> }
    | { kind: 'repository'; url: string };

export interface EngineRequest {
    id: number;
    method: string;
    params: Record<string, unknown>;
}

export type EngineReply =
    | { id: number; result: unknown }
    | { id: number; error: string }
    | { event: EngineEvent }
    /** Sent by a host handler (HandlerContext.emit): the host defines its shape. */
    | { hostEvent: unknown };
