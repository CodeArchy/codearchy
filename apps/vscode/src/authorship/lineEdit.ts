/**
 * Editor changes as line edits for the authorship ledger. Pure (no vscode
 * import), so it's unit-tested without an editor.
 */
/** Lines `start..end` (old numbering, 1-based) replaced by `inserted` lines (core's LineEdit, without who made it). */
export interface LineChange {
    start: number;
    end: number;
    inserted: number;
}

/** Counts `\n` in a string. */
export function breaks(s: string): number {
    let n = 0;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
    return n;
}

/**
 * A content change as a line edit: lines `start..end` (old numbering) replaced
 * by `inserted` lines. Whole lines inserted at a line start are a pure insertion.
 */
export function lineEditOf(change: { range: { start: { line: number; character: number }; end: { line: number } }; rangeLength: number; text: string }): LineChange {
    const start = change.range.start.line + 1;
    const removed = change.range.end.line - change.range.start.line;
    const added = breaks(change.text);
    if (change.rangeLength === 0 && change.range.start.character === 0 && change.text.endsWith('\n')) return { start, end: start - 1, inserted: added };
    return { start, end: start + removed, inserted: added + 1 };
}

