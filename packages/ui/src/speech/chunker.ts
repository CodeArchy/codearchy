/**
 * Text to speech chunks: what the voice says, a phrase at a time.
 *
 * Kokoro makes audio at roughly 1.5x real time on a laptop (GPU or native
 * CPU alike), and the time to make a phrase grows with its length. So speech
 * starts with a short phrase (fast first sound) and each later chunk is
 * allowed to grow by less than that margin, which keeps synthesis ahead of
 * playback: once the voice starts, it doesn't stop to wait.
 *
 * Input is the markdown the UI shows (answers, tour steps): links keep their
 * label and record their node key (a "mark", so the canvas can follow the
 * voice), code blocks are skipped, emphasis and list markers go.
 *
 * Deterministic: the chunks depend on the text only, never on how it arrived
 * (an answer streamed in any pieces chunks exactly like the whole answer), so
 * audio made while an answer streamed is found again when it's replayed.
 */

export interface SpeechChunk {
    /** What is said. */
    text: string;
    /** Node keys linked in it (`[Name](node:key)`), in order. */
    keys: string[];
}

/**
 * Chunk limits. The first chunk is short: it decides how soon the voice
 * starts. Synthesis is serial and ~1.5x faster than speech, so chunk k is
 * ready in time if it's at most about `first + 0.5 × everything before it`;
 * 0.42 keeps a margin (per-call overhead, a slower machine).
 */
const FIRST_MAX = 32;
const AHEAD = 0.42;
const MAX = 240;
/** A sentence may end a chunk once it has this many characters. */
const SENTENCE_MIN = 4;
const ABBREVIATIONS = new Set(['e.g', 'i.e', 'etc', 'vs', 'mr', 'mrs', 'ms', 'dr', 'fig', 'approx', 'cf', 'no']);

/** Where a chunk may end: a clause from `clauseMin` characters on, a space beyond `hardMax`, a sentence end within `slack` after it. */
function limits(said: { first: number; total: number } | undefined): { clauseMin: number; hardMax: number; slack: number } {
    if (!said) return { clauseMin: 10, hardMax: FIRST_MAX, slack: 14 };
    const hardMax = Math.min(MAX, Math.max(28, Math.round(said.first + AHEAD * said.total)));
    return { clauseMin: Math.max(12, Math.round(hardMax * 0.5)), hardMax, slack: Math.min(24, Math.round(hardMax / 3)) };
}

interface Label {
    start: number;
    end: number;
    key?: string;
}

export class SpeechChunker {
    /** Markdown not converted yet (an unfinished link, code span or fence). */
    private raw = '';
    /** Plain text not chunked yet. */
    private plain = '';
    /** Link labels in `plain` (keys for marks; cuts never fall inside one). */
    private labels: Label[] = [];
    /** What has been chunked so far: the first chunk's length and the total (the next may grow from them). */
    private said: { first: number; total: number } | undefined;
    private lineStart = true;
    private inFence = false;

    /** Adds text; returns the chunks it completed. */
    push(markdown: string): SpeechChunk[] {
        this.raw += markdown;
        this.convert(false);
        return this.cut(false);
    }

    /** No more text: returns the rest. */
    end(): SpeechChunk[] {
        this.convert(true);
        return this.cut(true);
    }

    /** Markdown → plain text, as far as it's complete. */
    private convert(final: boolean): void {
        const s = this.raw;
        let i = 0;
        const emit = (text: string) => {
            if (!text) return;
            this.plain += text;
            this.lineStart = false;
        };
        while (i < s.length) {
            if (this.inFence) {
                const close = s.indexOf('```', i);
                if (close < 0) {
                    i = final ? s.length : i;
                    if (!final) break;
                    continue;
                }
                this.inFence = false;
                i = close + 3;
                const nl = s.indexOf('\n', i);
                if (nl < 0 && !final) break;
                i = nl < 0 ? s.length : nl + 1;
                this.lineStart = true;
                continue;
            }
            const c = s[i]!;
            if (c === '`') {
                if (s.startsWith('```', i)) {
                    this.inFence = true;
                    i += 3;
                    continue;
                }
                if (s.length - i < 3 && !final && s.slice(i).split('').every((x) => x === '`')) break; // maybe a fence
                const close = s.indexOf('`', i + 1);
                if (close < 0) {
                    if (!final && s.length - i < 200) break;
                    i++;
                    continue;
                }
                emit(s.slice(i + 1, close));
                i = close + 1;
                continue;
            }
            if (c === '[') {
                const close = s.indexOf(']', i + 1);
                if (close < 0) {
                    if (!final && s.length - i < 300) break;
                    emit('[');
                    i++;
                    continue;
                }
                if (close + 1 >= s.length && !final) break;
                if (s[close + 1] !== '(') {
                    emit(s.slice(i, close + 1));
                    i = close + 1;
                    continue;
                }
                const end = s.indexOf(')', close + 2);
                if (end < 0) {
                    if (!final && s.length - i < 600) break;
                    emit(s.slice(i, close + 1));
                    i = close + 1;
                    continue;
                }
                const label = s.slice(i + 1, close);
                const target = s.slice(close + 2, end);
                const start = this.plain.length;
                emit(label);
                this.labels.push({ start, end: this.plain.length, ...(target.startsWith('node:') ? { key: target.slice(5) } : {}) });
                i = end + 1;
                continue;
            }
            if (this.lineStart) {
                // Line markers: headings, quotes, bullets, numbered items. Wait until it's clear which.
                const m = /^(#{1,6}\s+|>\s?|[-*+]\s+|\d{1,3}[.)]\s+)/.exec(s.slice(i, i + 8));
                if (m) {
                    i += m[0].length;
                    this.lineStart = false;
                    continue;
                }
                if (!final && /^(#{1,6}|[-*+]|\d{1,3}[.)]?|>)$/.test(s.slice(i))) break;
                if (c === ' ' || c === '\t') {
                    i++;
                    continue;
                }
            }
            if (c === '\n') {
                // A line ends: a pause, like a sentence end.
                const last = this.plain.trimEnd().slice(-1);
                if (last && /[\p{L}\p{N})"']/u.test(last)) this.plain = `${this.plain.trimEnd()}. `;
                else if (last) this.plain += ' ';
                this.lineStart = true;
                i++;
                continue;
            }
            if (c === '*' || c === '~') {
                i++;
                continue;
            }
            if (c === '_' && !(/\w/.test(s[i - 1] ?? '') && /\w/.test(s[i + 1] ?? ''))) {
                if (i + 1 >= s.length && !final) break;
                i++;
                continue;
            }
            if (c === '<') {
                const close = s.indexOf('>', i);
                if (close < 0) {
                    if (!final && s.length - i < 200) break;
                    i++;
                    continue;
                }
                i = close + 1;
                continue;
            }
            emit(c === '|' || c === '\t' ? ' ' : c);
            i++;
        }
        this.raw = s.slice(i);
    }

    /** Plain text → chunks, as far as each cut is certain. */
    private cut(final: boolean): SpeechChunk[] {
        const out: SpeechChunk[] = [];
        for (;;) {
            const p = this.plain;
            const { clauseMin, hardMax, slack } = limits(this.said);
            const inLabel = (x: number) => this.labels.some((l) => x > l.start && x < l.end);
            let cutAt = -1;
            let lastSpace = -1;
            let waiting = false;
            for (let x = 0; x < p.length; x++) {
                const c = p[x]!;
                if (c === ' ' && !inLabel(x)) lastSpace = x;
                const nextKnown = x + 1 < p.length;
                const nextSpace = nextKnown ? /\s/.test(p[x + 1]!) : final;
                if (c === '.' || c === '!' || c === '?') {
                    if (!nextKnown && !final) {
                        waiting = true;
                        break;
                    }
                    if (nextSpace && x + 1 >= SENTENCE_MIN && !inLabel(x) && !abbreviation(p, x)) {
                        cutAt = x + 1;
                        break;
                    }
                } else if (c === ',' || c === ';' || c === ':' || c === '—') {
                    if (!nextKnown && !final) {
                        waiting = true;
                        break;
                    }
                    if (nextSpace && x + 1 >= clauseMin && !inLabel(x)) {
                        cutAt = x + 1;
                        break;
                    }
                }
                if (x >= hardMax && lastSpace > clauseMin / 2) {
                    // Too long: end at a sentence or clause just ahead, or else at the last space.
                    const ahead = endWithin(p, x + 1, x + slack, final, inLabel);
                    if (ahead === 'wait') waiting = true;
                    else cutAt = ahead ?? lastSpace;
                    break;
                }
            }
            if (cutAt < 0) {
                if (waiting || !final || !p.trim()) break;
                cutAt = p.length;
            }
            const text = p.slice(0, cutAt).trim();
            const keys = this.labels.filter((l) => l.start < cutAt && l.key).map((l) => l.key!);
            // What's left, with label positions moved along.
            const rest = p.slice(cutAt);
            const lead = rest.length - rest.trimStart().length;
            const shift = cutAt + lead;
            this.plain = rest.slice(lead);
            this.labels = this.labels.filter((l) => l.end > cutAt).map((l) => ({ ...l, start: Math.max(0, l.start - shift), end: l.end - shift }));
            if (/[\p{L}\p{N}]/u.test(text)) {
                out.push({ text, keys: [...new Set(keys)] });
                this.said = this.said ? { first: this.said.first, total: this.said.total + text.length } : { first: text.length, total: text.length };
            }
        }
        return out;
    }
}

/** A sentence or clause end in [from, to): its cut position, none, or 'wait' (the text doesn't reach `to` yet). */
function endWithin(p: string, from: number, to: number, final: boolean, inLabel: (x: number) => boolean): number | undefined | 'wait' {
    for (let y = from; y < to; y++) {
        if (y >= p.length) return final ? undefined : 'wait';
        const c = p[y]!;
        if ('.!?,;:—'.includes(c) && !inLabel(y)) {
            if (y + 1 >= p.length) return final ? y + 1 : 'wait';
            if (/\s/.test(p[y + 1]!) && !(c === '.' && abbreviation(p, y))) return y + 1;
        }
    }
    return undefined;
}

function abbreviation(text: string, dot: number): boolean {
    let s = dot;
    while (s > 0 && /[\p{L}.]/u.test(text[s - 1]!)) s--;
    return ABBREVIATIONS.has(text.slice(s, dot).toLowerCase());
}

/** The chunks of a whole text (the same ones streaming it would give). */
export function speechChunks(markdown: string): SpeechChunk[] {
    const c = new SpeechChunker();
    return [...c.push(markdown), ...c.end()];
}
