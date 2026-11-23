/**
 * Search over the hierarchy: node names, paths, symbol names, and the text of
 * any cards written so far. A small BM25 over word tokens (camelCase,
 * snake_case and path segments split), with a boost for exact name matches.
 * In memory and rebuilt per index snapshot; fast enough for 100k nodes.
 */
import type { HierarchyIndex } from '@codearchy/core';
import type { HierarchyKind } from '@codearchy/protocol';
import type { Card } from './card.js';

export interface SearchHit {
    key: string;
    kind: HierarchyKind;
    name: string;
    path: string;
    score: number;
}

/** Lower-case word tokens: `parseHTTPRequest` → parse, http, request; `src/auth_service.py` → src, auth, service, py. */
export function tokens(text: string): string[] {
    const out: string[] = [];
    for (const raw of text.split(/[^A-Za-z0-9]+/)) {
        if (!raw) continue;
        // Split camelCase and acronym boundaries with a linear scan.
        let start = 0;
        for (let i = 1; i <= raw.length; i++) {
            const prev = raw.charCodeAt(i - 1);
            const cur = i < raw.length ? raw.charCodeAt(i) : 0;
            const next = i + 1 < raw.length ? raw.charCodeAt(i + 1) : 0;
            const lower = (c: number) => c >= 97 && c <= 122;
            const upper = (c: number) => c >= 65 && c <= 90;
            const digit = (c: number) => c >= 48 && c <= 57;
            // Letters and digits stay together (v2, oauth2, utf8): they're how code names things.
            const boundary =
                i === raw.length || (lower(prev) && upper(cur)) || (upper(prev) && upper(cur) && lower(next)) || (digit(prev) && upper(cur));
            if (boundary) {
                const t = raw.slice(start, i).toLowerCase();
                if (t.length > 1 || digit(t.charCodeAt(0))) out.push(t);
                start = i;
            }
        }
    }
    return out;
}

/**
 * A light stem, the same on both sides of a search, so plural and tense forms
 * meet: invoices/invoice → invoic, charged/charging/charge → charg.
 */
export function stem(word: string): string {
    let w = word;
    if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
    else if (w.endsWith('sses')) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
    else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
    if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
    return w;
}

/** English function words and question words: they say nothing about code. */
const STOPWORDS = new Set(
    (
        'a an and are as at be been but by can could did do does doing done for from had has have how i if in into is it its ' +
        'me my of on or our should so than that the their them then there these they this those to up us was we were what ' +
        'when where which while who whom why will with would you your about does'
    ).split(' '),
);

/** Search terms: tokens without stopwords, stemmed. */
export function terms(text: string): string[] {
    return tokens(text)
        .filter((t) => !STOPWORDS.has(t))
        .map(stem);
}

interface Doc {
    i: number;
    name: string;
    terms: Map<string, number>;
    length: number;
}

export class NodeSearch {
    /** A search that also covers the text of each node's card (cards are looked up once, up front). */
    static async withCards(index: HierarchyIndex, cardFor: (key: string) => Promise<Card | undefined>): Promise<NodeSearch> {
        const cards = new Map<string, Card>();
        for (const n of index.hierarchy.nodes) {
            if (n.kind === 'symbol') continue;
            try {
                const card = await cardFor(n.key);
                if (card) cards.set(n.key, card);
            } catch {
                // no card for this node
            }
        }
        return new NodeSearch(index, cards);
    }

    private readonly docs: Doc[] = [];
    private readonly df = new Map<string, number>();
    private readonly avgLength: number;

    constructor(
        private readonly index: HierarchyIndex,
        cards: ReadonlyMap<string, Card> = new Map(),
    ) {
        const nodes = index.hierarchy.nodes;
        let total = 0;
        nodes.forEach((n, i) => {
            if (i === 0) return; // the root isn't a useful hit
            const card = cards.get(n.key);
            const text = [n.name, n.name, n.path, n.kind === 'symbol' ? n.symbolKind ?? '' : '', card?.title ?? '', card?.purpose ?? '', ...(card?.responsibilities ?? [])].join(' ');
            const counts = new Map<string, number>();
            const toks = terms(text);
            for (const t of toks) counts.set(t, (counts.get(t) ?? 0) + 1);
            for (const t of counts.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
            this.docs.push({ i, name: n.name.toLowerCase(), terms: counts, length: toks.length });
            total += toks.length;
        });
        this.avgLength = this.docs.length ? total / this.docs.length : 1;
    }

    search(query: string, options: { kinds?: HierarchyKind[]; limit?: number } = {}): SearchHit[] {
        const q = [...new Set(terms(query))];
        if (!q.length) return [];
        const n = this.docs.length;
        const exact = query.trim().toLowerCase();
        const k1 = 1.2;
        const b = 0.75;
        const nodes = this.index.hierarchy.nodes;
        const hits: SearchHit[] = [];
        for (const d of this.docs) {
            const node = nodes[d.i]!;
            if (options.kinds && !options.kinds.includes(node.kind)) continue;
            let score = 0;
            for (const t of q) {
                const tf = d.terms.get(t);
                if (!tf) continue;
                const idf = Math.log(1 + (n - (this.df.get(t) ?? 0) + 0.5) / ((this.df.get(t) ?? 0) + 0.5));
                score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.length) / this.avgLength));
            }
            if (!score) continue;
            const dot = d.name.lastIndexOf('.');
            if (d.name === exact || (dot > 0 && d.name.slice(0, dot) === exact)) score *= 2;
            if (node.kind !== 'symbol') score *= 1.15; // containers and files are better first answers
            hits.push({ key: node.key, kind: node.kind, name: node.name, path: node.path, score: Math.round(score * 1000) / 1000 });
        }
        return hits.sort((a, b2) => b2.score - a.score || a.key.localeCompare(b2.key, 'en')).slice(0, options.limit ?? 10);
    }
}
