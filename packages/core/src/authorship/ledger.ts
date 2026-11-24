/**
 * The authorship ledger (doc 07 §4): ranges attributed going forward, kept in
 * step with edits, plus people's review marks and corrections.
 *
 *   - Edits shift ranges below them. A person's edit inside an `ai` range
 *     turns that range `reviewed` ("AI-written, later changed by a person").
 *   - "Mark as reviewed" turns the selected `ai` lines `reviewed`; "correct
 *     attribution" sets lines to what the person says (recorded as theirs).
 *   - Each range keeps a hash of its text, so after changes the ledger didn't
 *     see (a pull, another editor) it re-finds the text or drops the range.
 *
 * Host-agnostic and pure: VS Code feeds it editor events, the Companion
 * serves it to the web app. Ranges are 1-based and inclusive.
 */
import type { AuthorshipConfidence, AuthorshipOrigin, AuthorshipRange } from '@codearchy/protocol';
import { contentHash } from '../util/hash.js';
import type { AuthorshipData } from './index.js';

export const LEDGER_VERSION = 1;

export type LedgerSource = 'capture' | 'review' | 'correction' | 'log';

export interface LedgerRange extends AuthorshipRange {
    /** When it was recorded (ms). */
    time: number;
    source: LedgerSource;
    /** Hash of the range's text when last confirmed. */
    anchor?: string;
}

/** One change to a file: lines `start..end` (old numbering, inclusive) replaced by `inserted` lines. `end < start` = pure insertion before `start`. */
export interface LineEdit {
    start: number;
    end: number;
    inserted: number;
    /** Who made it: a person (typing, pasting), an AI tool (with its name), or unknown (a reload, a formatter). */
    by: 'human' | 'ai' | 'unknown';
    agent?: string;
    confidence?: AuthorshipConfidence;
}

export interface LedgerFile {
    version: typeof LEDGER_VERSION;
    files: Record<string, LedgerRange[]>;
}

const MAX_RANGES_PER_FILE = 2000;

export class AuthorshipLedger {
    private readonly files = new Map<string, LedgerRange[]>();
    private changed = false;

    static from(data: unknown): AuthorshipLedger {
        const ledger = new AuthorshipLedger();
        if (!data || typeof data !== 'object' || (data as LedgerFile).version !== LEDGER_VERSION) return ledger;
        for (const [path, ranges] of Object.entries((data as LedgerFile).files ?? {})) {
            if (!Array.isArray(ranges)) continue;
            const clean = ranges.filter(validRange).slice(0, MAX_RANGES_PER_FILE);
            if (clean.length) ledger.files.set(path, clean.sort((a, b) => a.start - b.start));
        }
        return ledger;
    }

    toJSON(): LedgerFile {
        return { version: LEDGER_VERSION, files: Object.fromEntries([...this.files].filter(([, r]) => r.length)) };
    }

    /** True once since the last call when something changed (for debounced saving). */
    takeChanged(): boolean {
        const c = this.changed;
        this.changed = false;
        return c;
    }

    paths(): string[] {
        return [...this.files.keys()];
    }

    ranges(path: string): LedgerRange[] {
        return this.files.get(path) ?? [];
    }

    /** Applies an edit: shifts what's below, splits or re-labels what it touches, and records new AI lines. */
    applyEdit(path: string, edit: LineEdit, text?: string, now = Date.now()): void {
        const before = this.files.get(path) ?? [];
        const removed = Math.max(0, edit.end - edit.start + 1);
        const delta = edit.inserted - removed;
        const out: LedgerRange[] = [];
        for (const r of before) {
            if (r.end < edit.start) {
                out.push(r); // above the edit
            } else if (r.start > edit.end && removed > 0) {
                out.push(shift(r, delta)); // below a replacement
            } else if (removed === 0 && r.start >= edit.start) {
                out.push(shift(r, delta)); // at or below a pure insertion point
            } else if (removed === 0 && r.end >= edit.start) {
                // A pure insertion inside the range: it grows (and a person's lines review it).
                out.push(this.touched({ ...r, end: r.end + delta }, edit));
            } else if (r.start < edit.start && r.end > edit.end) {
                // The edit is inside the range: it spans the new lines too.
                out.push(this.touched({ ...r, end: r.end + delta }, edit));
            } else if (r.start < edit.start) {
                // The edit replaced the range's tail: its head survives.
                out.push(this.touched({ ...r, end: edit.start - 1 }, edit));
            } else if (r.end > edit.end) {
                // The edit replaced the range's head: its tail survives, after the new lines.
                out.push(this.touched({ ...r, start: edit.start + edit.inserted, end: r.end + delta }, edit));
            }
            // else: the edit replaced the whole range, which is gone.
        }
        if (edit.by === 'ai' && edit.inserted > 0) {
            out.push({ start: edit.start, end: edit.start + edit.inserted - 1, origin: 'ai', agent: edit.agent ?? 'unknown-ai', confidence: edit.confidence ?? 'inferred', time: now, source: 'capture' });
        }
        this.set(path, overlayLedger(out), text);
    }

    /** "Mark as reviewed": `ai` lines in the selection become `reviewed`. */
    markReviewed(path: string, start: number, end: number, text?: string, now = Date.now()): number {
        let marked = 0;
        const out: LedgerRange[] = [];
        for (const r of this.ranges(path)) {
            if (r.origin !== 'ai' || r.end < start || r.start > end) {
                out.push(r);
                continue;
            }
            const a = Math.max(r.start, start);
            const b = Math.min(r.end, end);
            // Split pieces cover different text: their anchors are recomputed, never inherited.
            if (r.start < a) out.push({ ...r, end: a - 1, anchor: undefined });
            out.push({ ...r, start: a, end: b, origin: 'reviewed', confidence: 'declared', time: now, source: 'review', anchor: undefined });
            if (b < r.end) out.push({ ...r, start: b + 1, anchor: undefined });
            marked += b - a + 1;
        }
        this.set(path, out, text);
        return marked;
    }

    /** "Correct attribution": the person says these lines are `origin` (recorded as declared by them). */
    correct(path: string, start: number, end: number, origin: AuthorshipOrigin, agent?: string, text?: string, now = Date.now()): void {
        const kept = this.ranges(path).flatMap((r) => cut(r, start, end));
        if (origin !== 'unknown') kept.push({ start, end, origin, ...(agent ? { agent } : {}), confidence: 'declared', time: now, source: 'correction' });
        this.set(path, kept, text);
    }

    /**
     * What agents' session logs say about a file (ranges from `matchEdits`).
     * Replaces earlier log ranges, so re-reading the logs is idempotent. Log
     * evidence (verified) supersedes the editor capture (inferred) it
     * overlaps, for good; people's reviews and corrections still win.
     */
    recordLog(path: string, ranges: LedgerRange[], text?: string): void {
        const existing = this.ranges(path);
        const capture = existing.filter((r) => r.source === 'capture');
        const people = existing.filter((r) => r.source === 'review' || r.source === 'correction');
        this.set(path, overlayLedger([...capture, ...ranges.map((r) => ({ ...r, source: 'log' as const }))].concat(people)), text);
    }

    /** The file moved or was renamed: its ranges follow. */
    rename(from: string, to: string): void {
        const r = this.files.get(from);
        if (!r) return;
        this.files.delete(from);
        this.files.set(to, r);
        this.changed = true;
    }

    remove(path: string): void {
        if (this.files.delete(path)) this.changed = true;
    }

    /**
     * After changes the ledger didn't see: each range whose text moved is
     * re-found (exact match, nearest to where it was); one whose text is gone
     * was rewritten and is dropped.
     */
    reconcile(path: string, text: string): void {
        const ranges = this.files.get(path);
        if (!ranges?.length) return;
        const lines = text.split('\n');
        const out: LedgerRange[] = [];
        for (const r of ranges) {
            if (!r.anchor) {
                if (r.end <= lines.length) out.push({ ...r, anchor: anchorOf(lines, r.start, r.end) });
                continue;
            }
            if (r.end <= lines.length && anchorOf(lines, r.start, r.end) === r.anchor) {
                out.push(r);
                continue;
            }
            const len = r.end - r.start + 1;
            let best = -1;
            for (let s = 1; s + len - 1 <= lines.length; s++) {
                if (anchorOf(lines, s, s + len - 1) === r.anchor && (best < 0 || Math.abs(s - r.start) < Math.abs(best - r.start))) best = s;
            }
            if (best > 0) out.push({ ...r, start: best, end: best + len - 1 });
        }
        this.set(path, out);
    }

    private touched(r: LedgerRange, edit: LineEdit): LedgerRange {
        // A person changing AI-written lines is the "reviewed" signal.
        return edit.by === 'human' && r.origin === 'ai' ? { ...r, origin: 'reviewed', anchor: undefined } : { ...r, anchor: undefined };
    }

    private set(path: string, ranges: LedgerRange[], text?: string): void {
        const lines = text?.split('\n');
        // Adjacent ranges that say the same thing (origin, tool, confidence, source) are one range.
        const merged: LedgerRange[] = [];
        for (const r of ranges.filter((x) => x.end >= x.start && x.start >= 1).sort((x, y) => x.start - y.start)) {
            const prev = merged[merged.length - 1];
            if (prev && prev.end + 1 === r.start && prev.origin === r.origin && prev.agent === r.agent && prev.confidence === r.confidence && prev.source === r.source) {
                merged[merged.length - 1] = { ...prev, end: r.end, time: Math.max(prev.time, r.time), anchor: undefined };
            } else merged.push(r);
        }
        const clean = merged.slice(0, MAX_RANGES_PER_FILE).map((r) => (lines && r.end <= lines.length ? { ...r, anchor: anchorOf(lines, r.start, r.end) } : r));
        if (clean.length) this.files.set(path, clean);
        else this.files.delete(path);
        this.changed = true;
    }
}

function shift(r: LedgerRange, delta: number): LedgerRange {
    return delta ? { ...r, start: r.start + delta, end: r.end + delta } : r;
}

/** What's left of `r` outside `start..end`. */
function cut(r: LedgerRange, start: number, end: number): LedgerRange[] {
    if (r.end < start || r.start > end) return [r];
    const out: LedgerRange[] = [];
    if (r.start < start) out.push({ ...r, end: start - 1, anchor: undefined });
    if (r.end > end) out.push({ ...r, start: end + 1, anchor: undefined });
    return out;
}

function anchorOf(lines: string[], start: number, end: number): string {
    return contentHash(lines.slice(start - 1, end).join('\n'));
}

function validRange(r: unknown): r is LedgerRange {
    if (!r || typeof r !== 'object') return false;
    const x = r as LedgerRange;
    return Number.isInteger(x.start) && Number.isInteger(x.end) && x.start >= 1 && x.end >= x.start && ['ai', 'reviewed', 'human', 'unknown'].includes(x.origin);
}

/** Later ranges win where ranges overlap (new evidence replaces old). */
function overlayLedger(ranges: LedgerRange[]): LedgerRange[] {
    let out: LedgerRange[] = [];
    for (const r of ranges) {
        out = out.flatMap((o) => cut(o, r.start, r.end));
        out.push(r);
    }
    return out.sort((a, b) => a.start - b.start);
}

/**
 * Git-derived ranges with the ledger on top: the ledger is newer and
 * finer-grained, so it wins where they overlap, except that an inferred
 * `ai` capture never replaces a commit's declared `ai` (same answer, and the
 * commit names the tool).
 */
export function overlayRanges(base: AuthorshipRange[], top: AuthorshipRange[]): AuthorshipRange[] {
    let out: AuthorshipRange[] = [...base];
    for (const r of [...top].sort((a, b) => a.start - b.start)) {
        if (r.origin === 'ai' && r.confidence !== 'verified' && out.some((o) => o.origin === 'ai' && o.start <= r.start && o.end >= r.end)) continue;
        out = out.flatMap((o) => (o.end < r.start || o.start > r.end ? [o] : cutRange(o, r.start, r.end)));
        out.push(r);
    }
    return out.sort((a, b) => a.start - b.start).map(({ start, end, origin, agent, confidence, commit }) => ({ start, end, origin, ...(agent ? { agent } : {}), ...(confidence ? { confidence } : {}), ...(commit ? { commit } : {}) }));
}

function cutRange(r: AuthorshipRange, start: number, end: number): AuthorshipRange[] {
    const out: AuthorshipRange[] = [];
    if (r.start < start) out.push({ ...r, end: start - 1 });
    if (r.end > end) out.push({ ...r, start: end + 1 });
    return out;
}

/**
 * Authorship data with the ledger laid over git's (or the ledger alone when
 * there's no git history): what the index, the lens and the gutter read.
 */
export function withLedger(data: AuthorshipData | undefined, ledger: AuthorshipLedger): AuthorshipData {
    const ranges = new Map(data?.ranges ?? []);
    for (const path of ledger.paths()) ranges.set(path, overlayRanges(ranges.get(path) ?? [], ledger.ranges(path)));
    return { ranges, commits: data?.commits ?? new Map(), stats: data?.stats ?? { commits: 0, aiCommits: 0, blamedFiles: 0 } };
}

/**
 * A person's say on lines `start..end` of a file: `reviewed` marks AI lines as
 * reviewed (including lines only git attributes, which are brought into the
 * ledger first); an origin corrects the attribution. Returns the lines marked.
 */
export function markLines(ledger: AuthorshipLedger, current: AuthorshipRange[] | undefined, path: string, start: number, end: number, as: 'reviewed' | AuthorshipOrigin, now = Date.now()): number {
    const lo = Math.max(1, Math.min(start, end));
    const hi = Math.max(start, end);
    if (as !== 'reviewed') {
        ledger.correct(path, lo, hi, as, undefined, undefined, now);
        return hi - lo + 1;
    }
    for (const r of current ?? []) {
        if (r.origin !== 'ai' || r.end < lo || r.start > hi) continue;
        const a = Math.max(r.start, lo);
        const b = Math.min(r.end, hi);
        if (!ledger.ranges(path).some((x) => x.origin === 'ai' && x.start <= a && x.end >= b)) ledger.correct(path, a, b, 'ai', r.agent, undefined, now);
    }
    return ledger.markReviewed(path, lo, hi, undefined, now);
}
