/**
 * Language-agnostic text facts for a module: the file's header doc, and each
 * symbol's signature (its declaration line) and doc comment. Cheap line scans;
 * no parser. These count as "structure" under the privacy tiers: names,
 * signatures and docs, never code bodies.
 */

const MAX_FILE_DOC = 400;
const MAX_SYMBOL_DOC = 200;
const MAX_SIGNATURE = 160;
const LICENSE = /\b(copyright|license|licensed|spdx|all rights reserved)\b/i;

/** Collapses whitespace and caps the length at a word boundary. */
export function tidy(text: string, max: number): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    if (flat.length <= max) return flat;
    const cut = flat.slice(0, max);
    const space = cut.lastIndexOf(' ');
    return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}

const LINE_COMMENT = /^\s*(?:\/\/\/?|#(?!!)|--|;+|%)\s?/;

function stripLineComment(line: string): string | undefined {
    const m = LINE_COMMENT.exec(line);
    return m ? line.slice(m[0].length) : undefined;
}

/** A block comment starting at `lines[i]` (`/* … *\/` or Python triple quotes): its text and the next line index. */
function blockAt(lines: string[], i: number): { text: string; next: number } | undefined {
    const first = lines[i]!.trim();
    const open = first.startsWith('/*') ? '*/' : first.startsWith('"""') ? '"""' : first.startsWith("'''") ? "'''" : undefined;
    if (!open) return undefined;
    const body: string[] = [];
    const start = first.slice(open === '*/' ? (first.startsWith('/**') ? 3 : 2) : 3);
    const closesHere = start.indexOf(open);
    if (closesHere >= 0) return { text: start.slice(0, closesHere), next: i + 1 };
    body.push(start);
    for (let j = i + 1; j < lines.length && j < i + 60; j++) {
        const line = lines[j]!;
        const close = line.indexOf(open);
        const content = (close >= 0 ? line.slice(0, close) : line).replace(/^\s*\*\s?/, '');
        body.push(content);
        if (close >= 0) return { text: body.join('\n'), next: j + 1 };
    }
    return undefined; // unterminated: not a doc we can trust
}

/** The file's leading doc comment or module docstring, skipping a shebang and licence headers. */
export function fileDoc(text: string): string | undefined {
    const lines = text.split('\n', 200);
    let i = 0;
    if (lines[0]?.startsWith('#!')) i++;
    for (let blocks = 0; blocks < 4 && i < lines.length; blocks++) {
        while (i < lines.length && !lines[i]!.trim()) i++;
        if (i >= lines.length) return undefined;
        // Skip encoding pragmas and 'use strict'-style directives.
        if (/^\s*(#.*coding[:=]|['"]use [a-z]+['"];?\s*$|<\?php\s*$)/.test(lines[i]!)) {
            i++;
            continue;
        }
        let text: string | undefined;
        const block = blockAt(lines, i);
        if (block) {
            text = block.text;
            i = block.next;
        } else if (stripLineComment(lines[i]!) !== undefined) {
            const parts: string[] = [];
            while (i < lines.length) {
                const c = stripLineComment(lines[i]!);
                if (c === undefined) break;
                parts.push(c);
                i++;
            }
            text = parts.join('\n');
        } else {
            return undefined; // code before any comment
        }
        if (text && !LICENSE.test(text) && text.trim()) return tidy(text.replace(/^[=\-*# \t]+$/gm, ''), MAX_FILE_DOC) || undefined;
    }
    return undefined;
}

/** The doc comment directly above a declaration (decorators and annotations skipped), or a docstring right below it. */
export function symbolDoc(lines: string[], startLine: number): string | undefined {
    // Above: walk up over decorators, then collect a contiguous comment block.
    let j = startLine - 1;
    while (j >= 0 && /^\s*@/.test(lines[j]!)) j--;
    const above: string[] = [];
    if (j >= 0 && /\*\/\s*$/.test(lines[j]!)) {
        let k = j;
        while (k >= 0 && k > j - 60 && !/\/\*/.test(lines[k]!)) k--;
        if (k >= 0 && /\/\*/.test(lines[k]!)) {
            const block = blockAt(lines, k);
            if (block) above.push(block.text);
        }
    } else {
        while (j >= 0 && j > startLine - 40) {
            const c = stripLineComment(lines[j]!);
            if (c === undefined) break;
            above.unshift(c);
            j--;
        }
    }
    const doc = above.join('\n').trim();
    if (doc && !LICENSE.test(doc)) return tidy(doc, MAX_SYMBOL_DOC);
    // Below: a Python-style docstring as the first statement of the body.
    for (let k = startLine + 1; k < lines.length && k <= startLine + 4; k++) {
        const t = lines[k]!.trim();
        if (!t) continue;
        if (t.startsWith('"""') || t.startsWith("'''")) {
            const block = blockAt(lines, k);
            return block?.text.trim() ? tidy(block.text, MAX_SYMBOL_DOC) : undefined;
        }
        break;
    }
    return undefined;
}

/** The declaration as written: from the start line until the body opens (at most 4 lines), decorators skipped. */
export function signature(lines: string[], startLine: number, endLine: number): string | undefined {
    let i = startLine;
    while (i <= endLine && i < lines.length && /^\s*@/.test(lines[i]!)) i++;
    const parts: string[] = [];
    for (let k = i; k <= endLine && k < lines.length && k < i + 4; k++) {
        const line = lines[k]!;
        const brace = line.indexOf('{');
        if (brace >= 0) {
            parts.push(line.slice(0, brace));
            break;
        }
        parts.push(line);
        if (/(:|=>|\bdo|\bthen|=)\s*$/.test(line.trim()) || /[;)]\s*$/.test(line.trim())) break;
    }
    let sig = tidy(parts.join(' '), MAX_SIGNATURE);
    // Drop the token that opens the body (`=>`, `:`, `=`, `do`); endsWith keeps this linear.
    for (const opener of ['=>', ':', '=', ' do']) {
        if (sig.endsWith(opener)) {
            sig = sig.slice(0, -opener.length).trimEnd();
            break;
        }
    }
    return sig || undefined;
}
