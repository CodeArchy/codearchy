/**
 * Streaming phrase chunker for text-to-speech.
 *
 * Feeds on LLM deltas as they stream and releases speakable phrases as soon
 * as it is safe to, so synthesis starts before the answer is finished:
 *
 *   - First phrase: as soon as there are >= 4 words AND a clause boundary
 *     (, ; : — or a sentence end), or 12 complete words, whichever comes
 *     first. A short first phrase gives the fastest first audio.
 *   - Later phrases: sentence or line sized, at most ~200 characters, so
 *     prosody stays natural and synthesis runs ahead of playback.
 *   - Never cuts inside inline code, a link, bold text or math; code fences
 *     are skipped entirely (they are read on screen, not aloud).
 *
 * Pure and dependency-free (also exports `cleanText`) so it runs in the
 * webview, in workers, and in plain-Node tests.
 */

export interface ChunkerOptions {
    firstMinWords?: number;
    firstMaxWords?: number;
    /** Soft upper bound for a phrase. */
    maxChars?: number;
    /** Later phrases shorter than this wait for more text. */
    minChars?: number;
}

const ABBREVIATIONS = new Set(['e.g', 'i.e', 'etc', 'vs', 'mr', 'mrs', 'ms', 'dr', 'no', 'fig', 'approx', 'cf']);

/** Markdown / LaTeX → plain speakable text. Shared by streaming and whole-message speech. */
export function cleanText(raw: string): string {
    let t = raw;
    t = t.replace(/\$\$[\s\S]*?\$\$/g, '');
    t = t.replace(/\\\[[\s\S]*?\\\]/g, '');
    t = t.replace(/\$[^$\n]+?\$/g, '');
    t = t.replace(/\\\([\s\S]*?\\\)/g, '');
    t = t.replace(/```[\s\S]*?```/g, '');
    t = t.replace(/`[^`\n]+?`/g, '');
    t = t.replace(/!\[[^\]]*?\]\([^)]*?\)/g, '');
    t = t.replace(/\[([^\]]+?)\]\([^)]*?\)/g, '$1');
    t = t.replace(/(\*\*|__)(.*?)\1/gs, '$2');
    t = t.replace(/(\*|_)(.*?)\1/gs, '$2');
    t = t.replace(/~~(.*?)~~/gs, '$1');
    t = t.replace(/^#{1,6}\s+/gm, '');
    t = t.replace(/^\s*>\s?/gm, '');
    t = t.replace(/^[-*_]{3,}\s*$/gm, '.');
    t = t.replace(/^\s*[-*+]\s+/gm, '');
    t = t.replace(/^\s*\d+\.\s+/gm, '');
    // Speech output, not HTML, but strip tags completely anyway: remove tags,
    // then any stray angle brackets a partial tag could leave behind.
    t = t.replace(/<[^>]*>/g, '').replace(/[<>]/g, '');
    t = t.replace(/&amp;/gi, 'and').replace(/&lt;/gi, '').replace(/&gt;/gi, '')
        .replace(/&nbsp;/gi, ' ').replace(/&[a-z]+;/gi, '');
    t = t.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ');
    return t.trim();
}

function wordCount(s: string): number {
    const m = s.trim().match(/\S+/g);
    return m ? m.length : 0;
}

/** True when cutting after `s` would not split an inline markdown/math construct. */
function isBalanced(s: string): boolean {
    if ((s.match(/`/g)?.length ?? 0) % 2) return false;
    if ((s.match(/\*\*/g)?.length ?? 0) % 2) return false;
    if ((s.match(/\$/g)?.length ?? 0) % 2) return false;
    if ((s.match(/\[/g)?.length ?? 0) !== (s.match(/\]/g)?.length ?? 0)) return false;
    // A link target that has opened but not closed: "](http..." without ")"
    const lastLinkOpen = s.lastIndexOf('](');
    if (lastLinkOpen >= 0 && s.indexOf(')', lastLinkOpen) < 0) return false;
    return true;
}

/** Is the "." at `i` the end of an abbreviation like "e.g." or "Dr."? */
function isAbbreviation(s: string, i: number): boolean {
    const before = s.slice(0, i).match(/([A-Za-z.]+)$/);
    return !!before && ABBREVIATIONS.has(before[1].toLowerCase());
}

export class PhraseChunker {
    private raw = '';
    private inFence = false;
    private emittedFirst = false;
    private readonly firstMinWords: number;
    private readonly firstMaxWords: number;
    private readonly maxChars: number;
    private readonly minChars: number;

    constructor(options: ChunkerOptions = {}) {
        this.firstMinWords = options.firstMinWords ?? 4;
        this.firstMaxWords = options.firstMaxWords ?? 12;
        this.maxChars = options.maxChars ?? 200;
        this.minChars = options.minChars ?? 24;
    }

    /** Adds a streamed delta; returns phrases that are ready to speak. */
    push(delta: string): string[] {
        this.raw += delta;
        return this.drain(false);
    }

    /** End of stream: returns whatever is left. */
    flush(): string[] {
        const out = this.drain(true);
        this.raw = '';
        this.inFence = false;
        return out;
    }

    private drain(final: boolean): string[] {
        const out: string[] = [];
        for (;;) {
            if (this.inFence) {
                const close = this.raw.indexOf('```');
                if (close < 0) {
                    // Drop fenced content as it arrives; keep a possible partial "``".
                    this.raw = final ? '' : this.raw.slice(-2);
                    return out;
                }
                this.raw = this.raw.slice(close + 3);
                this.inFence = false;
                continue;
            }

            const fence = this.raw.indexOf('```');
            let region = fence >= 0 ? this.raw.slice(0, fence) : this.raw;
            // Trailing backticks may be the start of a fence still streaming in.
            if (fence < 0 && !final) region = region.replace(/`{1,2}$/, '');

            const cut = this.findCut(region, final || fence >= 0);
            if (cut > 0) {
                this.emit(region.slice(0, cut), out);
                this.raw = this.raw.slice(cut);
                continue;
            }
            if (fence >= 0) {
                this.emit(region, out); // text before a code block is complete
                this.raw = this.raw.slice(fence + 3);
                this.inFence = true;
                continue;
            }
            if (final) {
                this.emit(region, out);
                this.raw = this.raw.slice(region.length);
            }
            return out;
        }
    }

    /**
     * Index just after the next safe phrase boundary in `r`, or 0 if none yet.
     * `complete` means no more text will follow this region.
     */
    private findCut(r: string, complete: boolean): number {
        if (!r.trim()) return 0;
        const first = !this.emittedFirst;
        let sinceStart = 0;
        let wordsSeen = 0;
        let inWord = false;

        for (let i = 0; i < r.length; i++) {
            const c = r[i];
            const next = r[i + 1];
            const ws = /\s/.test(c);
            if (!ws && !inWord) {
                inWord = true;
            } else if (ws && inWord) {
                inWord = false;
                wordsSeen++;
                // Hard limit on the first phrase: N complete words.
                if (first && wordsSeen >= this.firstMaxWords && isBalanced(r.slice(0, i))) return i;
            }
            sinceStart++;

            const atLineEnd = c === '\n';
            const followedByBreak = next === undefined ? complete : /\s/.test(next);
            const sentenceEnd = /[.!?]/.test(c) && followedByBreak && !(c === '.' && isAbbreviation(r, i));
            const clauseEnd = /[,;:—]/.test(c) && followedByBreak;
            const end = i + 1;
            const candidate = r.slice(0, end);

            if (first) {
                if ((sentenceEnd || clauseEnd || atLineEnd) && wordCount(candidate) >= this.firstMinWords && isBalanced(candidate)) {
                    return end;
                }
            } else if ((sentenceEnd || atLineEnd) && candidate.trim().length >= this.minChars && isBalanced(candidate)) {
                return end;
            }

            // Runaway phrase with no sentence end: cut at the last clause or space.
            if (!first && sinceStart >= this.maxChars) {
                const window = r.slice(0, end);
                const clause = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '));
                const space = window.lastIndexOf(' ');
                const at = clause > this.maxChars / 2 ? clause + 1 : space > 0 ? space : end;
                if (isBalanced(r.slice(0, at))) return at;
            }
        }
        return 0;
    }

    private emit(piece: string, out: string[]): void {
        const spoken = cleanText(piece);
        if (/[\p{L}\p{N}]/u.test(spoken)) {
            out.push(spoken);
            this.emittedFirst = true;
        }
    }
}
