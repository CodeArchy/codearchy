/**
 * A small, safe markdown subset for chat answers, parsed to a tree the UI
 * renders as React elements (never as HTML), so model output can't inject
 * markup into the webview or the web app.
 *
 *   blocks   paragraphs, bullet and numbered lists, headings (shown bold), ``` code blocks
 *   inline   `code`, **bold**, [label](node:<key>), [label](file:<path>#L12) and other links (shown as text)
 */

export type Inline =
    | { t: 'text'; text: string }
    | { t: 'code'; text: string }
    | { t: 'bold'; children: Inline[] }
    | { t: 'node'; key: string; label: Inline[] }
    | { t: 'file'; path: string; line?: number; label: Inline[] };

export type Block =
    | { t: 'p'; inline: Inline[] }
    | { t: 'h'; inline: Inline[] }
    | { t: 'ul'; items: Inline[][] }
    | { t: 'ol'; items: Inline[][] }
    | { t: 'pre'; text: string };

const BULLET = /^\s{0,6}[-*•]\s+(.*)$/;
const NUMBERED = /^\s{0,6}\d{1,3}[.)]\s+(.*)$/;
const HEADING = /^#{1,6}\s+(.*)$/;

export function parseAnswer(text: string): Block[] {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const blocks: Block[] = [];
    let para: string[] = [];
    let list: { t: 'ul' | 'ol'; items: Inline[][] } | undefined;
    const flushPara = () => {
        if (para.length) blocks.push({ t: 'p', inline: parseInline(para.join(' ')) });
        para = [];
    };
    const flushList = () => {
        if (list) blocks.push(list);
        list = undefined;
    };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.trimStart().startsWith('```')) {
            flushPara();
            flushList();
            const code: string[] = [];
            for (i++; i < lines.length && !lines[i]!.trimStart().startsWith('```'); i++) code.push(lines[i]!);
            blocks.push({ t: 'pre', text: code.join('\n') });
            continue;
        }
        if (!line.trim()) {
            flushPara();
            flushList();
            continue;
        }
        const h = HEADING.exec(line);
        const b = BULLET.exec(line);
        const n = NUMBERED.exec(line);
        if (h) {
            flushPara();
            flushList();
            blocks.push({ t: 'h', inline: parseInline(h[1]!) });
        } else if (b || n) {
            flushPara();
            const kind = b ? 'ul' : 'ol';
            if (list && list.t !== kind) flushList();
            list ??= { t: kind, items: [] };
            list.items.push(parseInline((b ?? n)![1]!));
        } else if (list && /^\s{2,}\S/.test(line)) {
            // a wrapped list item
            const last = list.items[list.items.length - 1]!;
            last.push({ t: 'text', text: ' ' }, ...parseInline(line.trim()));
        } else {
            flushList();
            para.push(line.trim());
        }
    }
    flushPara();
    flushList();
    return blocks;
}

/** Inline markup, scanned left to right with plain index searches (linear, no backtracking). */
export function parseInline(text: string): Inline[] {
    const out: Inline[] = [];
    let buf = '';
    const push = (node: Inline) => {
        if (buf) out.push({ t: 'text', text: buf });
        buf = '';
        out.push(node);
    };
    // Each marker's search remembers its last answer: the first match at or after `from` is still the
    // same while `from` hasn't passed it, and a marker that's absent stays absent. So every position
    // is scanned once per marker, however many unmatched markers come first.
    const last = new Map<string, { from: number; at: number }>();
    const find = (marker: string, from: number): number => {
        const prev = last.get(marker);
        if (prev && from >= prev.from && (prev.at < 0 || from <= prev.at)) return prev.at;
        const at = text.indexOf(marker, from);
        last.set(marker, { from, at });
        return at;
    };
    let i = 0;
    while (i < text.length) {
        const ch = text[i]!;
        if (ch === '`') {
            const end = find('`', i + 1);
            if (end > i + 1) {
                push({ t: 'code', text: text.slice(i + 1, end) });
                i = end + 1;
                continue;
            }
        } else if (ch === '*' && text[i + 1] === '*') {
            const end = find('**', i + 2);
            if (end > i + 2) {
                push({ t: 'bold', children: parseInline(text.slice(i + 2, end)) });
                i = end + 2;
                continue;
            }
        } else if (ch === '[') {
            const close = find('](', i + 1);
            const end = close > i ? find(')', close + 2) : -1;
            if (close > i && end > close && close - i <= 200 && end - close <= 500) {
                const label = parseInline(text.slice(i + 1, close));
                const target = text.slice(close + 2, end);
                if (target.startsWith('node:')) push({ t: 'node', key: target.slice(5), label });
                else if (target.startsWith('file:')) {
                    const rest = target.slice(5);
                    const hash = rest.indexOf('#L');
                    const line = hash >= 0 ? Number.parseInt(rest.slice(hash + 2), 10) : NaN;
                    push({ t: 'file', path: hash >= 0 ? rest.slice(0, hash) : rest, ...(Number.isFinite(line) && line > 0 ? { line } : {}), label });
                } else {
                    // Other links stay text: the UI doesn't navigate to arbitrary URLs.
                    for (const node of label) push(node);
                    if (target && !target.startsWith('#')) buf += ` (${target})`;
                }
                i = end + 1;
                continue;
            }
        }
        buf += ch;
        i++;
    }
    if (buf) out.push({ t: 'text', text: buf });
    return out;
}
