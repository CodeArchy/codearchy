/**
 * Authorship notes (doc 07 §3, source 3): a git note on a commit, in
 * `refs/notes/codearchy-authorship`, saying which lines of the files it
 * changed were written by AI tools, reviewed, or written by people, in that
 * commit's line numbers. Notes travel with the repository when they're
 * pushed, so teammates see the same attribution.
 *
 * Reading projects a note onto today's lines through blame: a run of lines
 * blamed on the noted commit carries its original line numbers, so each
 * noted range maps exactly, through later edits above it and renames.
 */
import type { AuthorshipConfidence, AuthorshipOrigin, AuthorshipRange } from '@codearchy/protocol';

export const NOTES_REF = 'refs/notes/codearchy-authorship';
export const NOTE_VERSION = 1;

export interface NoteRange {
    start: number;
    end: number;
    origin: Exclude<AuthorshipOrigin, 'unknown'>;
    agent?: string;
    confidence?: AuthorshipConfidence;
}

export interface AuthorshipNote {
    version: typeof NOTE_VERSION;
    /** Repository-relative paths, as of the noted commit. */
    files: Record<string, NoteRange[]>;
}

/** A blame run: lines `start..start+count-1` today came from `orig..` of `file` in `commit`. */
export interface BlameRun {
    start: number;
    count: number;
    commit: string;
    /** The line number in the commit's version of the file. */
    orig: number;
    /** The file's path in that commit (repository-relative). */
    file?: string;
}

const ORIGINS = new Set(['ai', 'reviewed', 'human']);
const CONFIDENCES = new Set(['verified', 'declared', 'inferred', 'heuristic']);
const MAX_RANGES = 5000;

/** A note's text → its content, or undefined if it isn't a CodeArchy note this version reads. */
export function parseNote(text: string): AuthorshipNote | undefined {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return undefined;
    }
    if (!raw || typeof raw !== 'object' || (raw as AuthorshipNote).version !== NOTE_VERSION) return undefined;
    const filesIn = (raw as AuthorshipNote).files;
    if (!filesIn || typeof filesIn !== 'object') return undefined;
    const files: Record<string, NoteRange[]> = {};
    let total = 0;
    for (const [path, ranges] of Object.entries(filesIn)) {
        if (!Array.isArray(ranges) || path.includes('..') || path.startsWith('/')) continue;
        const clean: NoteRange[] = [];
        for (const r of ranges) {
            if (total >= MAX_RANGES || !r || typeof r !== 'object') break;
            const x = r as NoteRange;
            if (!Number.isInteger(x.start) || !Number.isInteger(x.end) || x.start < 1 || x.end < x.start || !ORIGINS.has(x.origin)) continue;
            clean.push({
                start: x.start,
                end: x.end,
                origin: x.origin,
                ...(typeof x.agent === 'string' && x.agent.length <= 40 ? { agent: x.agent } : {}),
                ...(x.confidence && CONFIDENCES.has(x.confidence) ? { confidence: x.confidence } : {}),
            });
            total++;
        }
        if (clean.length) files[path] = clean;
    }
    return { version: NOTE_VERSION, files };
}

/** A note's text for these files' ranges (`unknown` is never written: it's the default). */
export function serializeNote(files: Map<string, AuthorshipRange[]>): string {
    const out: Record<string, NoteRange[]> = {};
    for (const [path, ranges] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const kept = ranges
            .filter((r): r is AuthorshipRange & { origin: NoteRange['origin'] } => r.origin !== 'unknown')
            .map((r) => ({ start: r.start, end: r.end, origin: r.origin, ...(r.agent ? { agent: r.agent } : {}), ...(r.confidence ? { confidence: r.confidence } : {}) }));
        if (kept.length) out[path] = kept;
    }
    return `${JSON.stringify({ version: NOTE_VERSION, files: out }, null, 2)}\n`;
}

/**
 * Noted ranges carried onto today's lines: for each blame run from a noted
 * commit, the part of each noted range inside the run's original lines.
 */
export function projectNotes(runs: BlameRun[], notes: ReadonlyMap<string, AuthorshipNote>): AuthorshipRange[] {
    const out: AuthorshipRange[] = [];
    for (const run of runs) {
        const note = notes.get(run.commit);
        const ranges = note && run.file ? note.files[run.file] : undefined;
        if (!ranges) continue;
        const lo = run.orig;
        const hi = run.orig + run.count - 1;
        for (const r of ranges) {
            const a = Math.max(lo, r.start);
            const b = Math.min(hi, r.end);
            if (a > b) continue;
            out.push({
                start: run.start + (a - lo),
                end: run.start + (b - lo),
                origin: r.origin,
                ...(r.agent ? { agent: r.agent } : {}),
                confidence: r.confidence ?? 'declared',
                commit: run.commit,
            });
        }
    }
    return out.sort((x, y) => x.start - y.start);
}
