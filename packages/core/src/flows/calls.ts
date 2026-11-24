/**
 * Call sites from source text: every `name(` outside strings and comments,
 * with the innermost function or method it sits in. A single linear pass
 * (no regular expressions), language-aware only for comment and string
 * syntax. Approximate by design: calls without parentheses (Ruby, Scala-style)
 * are missed, and the name isn't resolved here (flows resolve it later).
 */
import { SymbolKind, type CallSite, type SymbolInfo } from '@codearchy/protocol';

const MAX_CALLS = 3000;

/**
 * Keywords that can precede `(` without being a call (control flow,
 * declarations, operators). Builtins (`len(`, `print(`) are real calls; the
 * tracer declines to follow them by name.
 */
const NOT_CALLS = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'def', 'fn', 'func', 'fun', 'typeof', 'sizeof',
    'await', 'yield', 'elif', 'else', 'try', 'with', 'assert', 'lambda', 'not', 'and', 'or', 'in', 'is', 'do', 'case',
    'throw', 'throws', 'super', 'this', 'self', 'match', 'when', 'unless', 'until', 'foreach', 'void', 'import',
    'require', 'export', 'from', 'as', 'using', 'lock', 'fixed', 'checked', 'unchecked', 'nameof', 'default', 'static',
    'instanceof', 'synchronized', 'async', 'macro_rules', 'where', 'loop', 'struct', 'enum', 'impl', 'new', 'keyof', 'satisfies',
]);

/** Kinds of symbol a call can sit inside. */
const CALLABLE = new Set<string>([SymbolKind.Function, SymbolKind.Method]);

const HASH_COMMENTS = new Set(['python', 'ruby']);
const BOTH_COMMENTS = new Set(['php']);

/** Receivers that mean the caller's own class. */
const SELF = new Set(['this', 'self', '$this', 'static', 'parent', 'super', 'cls', 'Self']);

const isIdentStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
const isIdent = (c: number) => isIdentStart(c) || (c >= 48 && c <= 57);

export function extractCalls(source: string, language: string, symbols: SymbolInfo[]): CallSite[] {
    const hash = HASH_COMMENTS.has(language) || BOTH_COMMENTS.has(language);
    const slash = !HASH_COMMENTS.has(language);
    const python = language === 'python';
    const rust = language === 'rust';
    // Innermost callable containing a line: callables sorted by start; a short list per file.
    const callables = symbols
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => CALLABLE.has(s.kind))
        .sort((a, b) => a.s.startLine - b.s.startLine);
    const declaredAt = new Set(symbols.map((s) => `${s.startLine}:${s.name}`));
    const enclosing = (line: number): number | undefined => {
        let best: { i: number; span: number } | undefined;
        for (const { s, i } of callables) {
            if (s.startLine > line) break;
            if (s.endLine >= line) {
                const span = s.endLine - s.startLine;
                if (!best || span <= best.span) best = { i, span };
            }
        }
        return best?.i;
    };

    const out: CallSite[] = [];
    const seen = new Set<string>();
    let line = 0;
    let prevWord = '';
    // The last identifier and where it ended, to name a member call's receiver.
    let lastWord = '';
    let lastWordEnd = -1;
    const n = source.length;
    const isSpace = (c: number) => c === 32 || c === 9;
    /** `obj.name(`, `obj?.name(`, `obj->name(`, `Obj::name(`: the receiver word, '' if it isn't a plain word; undefined = a bare call. */
    const receiverOf = (start: number): string | undefined => {
        let p = start - 1;
        while (p >= 0 && isSpace(source.charCodeAt(p))) p--;
        const c = source.charCodeAt(p);
        let op: number;
        if (c === 46) op = source.charCodeAt(p - 1) === 63 ? p - 1 : p; // . ?.
        else if (c === 62 && source.charCodeAt(p - 1) === 45) op = p - 1; // ->
        else if (c === 58 && source.charCodeAt(p - 1) === 58) op = p - 1; // ::
        else return undefined;
        let q = op - 1;
        while (q >= 0 && isSpace(source.charCodeAt(q))) q--;
        return lastWordEnd - 1 === q ? lastWord : '';
    };
    let i = 0;
    // Template literals: `${` leaves the string for code; its matching `}` resumes the string.
    let braces = 0;
    const templates: number[] = [];
    /** Scans string content from `i` up to its closing quote (or a template's `${`). */
    const scanString = (q: number, triple: boolean, multiline: boolean) => {
        while (i < n) {
            const d = source.charCodeAt(i);
            if (d === 92) {
                if (source.charCodeAt(i + 1) === 10) line++;
                i += 2;
                continue;
            }
            if (d === 10) {
                line++;
                if (!multiline) return; // an unclosed quote ends with its line
            }
            if (q === 96 && d === 36 && source.charCodeAt(i + 1) === 123) {
                i += 2;
                templates.push(braces);
                return;
            }
            if (d === q && (!triple || (source.charCodeAt(i + 1) === q && source.charCodeAt(i + 2) === q))) {
                i += triple ? 3 : 1;
                return;
            }
            i++;
        }
    };
    while (i < n && out.length < MAX_CALLS) {
        const c = source.charCodeAt(i);
        if (c === 123) braces++;
        else if (c === 125) {
            if (templates.length && templates[templates.length - 1] === braces) {
                templates.pop();
                i++;
                scanString(96, false, true);
                prevWord = '';
                continue;
            }
            braces--;
        }
        // Newlines
        if (c === 10) {
            line++;
            i++;
            continue;
        }
        // Comments
        if (slash && c === 47 && source.charCodeAt(i + 1) === 47) {
            while (i < n && source.charCodeAt(i) !== 10) i++;
            continue;
        }
        if (slash && c === 47 && source.charCodeAt(i + 1) === 42) {
            i += 2;
            while (i < n && !(source.charCodeAt(i) === 42 && source.charCodeAt(i + 1) === 47)) {
                if (source.charCodeAt(i) === 10) line++;
                i++;
            }
            i += 2;
            continue;
        }
        if (hash && c === 35 && !(language === 'php' && source.charCodeAt(i + 1) === 91)) {
            while (i < n && source.charCodeAt(i) !== 10) i++;
            continue;
        }
        // Strings
        if (c === 34 || c === 39 || c === 96) {
            if (rust && c === 39) {
                // A char literal ('a', '\n') or a lifetime ('a): only skip a closed literal.
                const close = source.charCodeAt(i + 1) === 92 ? i + 3 : i + 2;
                i = source.charCodeAt(close) === 39 ? close + 1 : i + 1;
                continue;
            }
            const triple = python && source.charCodeAt(i + 1) === c && source.charCodeAt(i + 2) === c;
            i += triple ? 3 : 1;
            scanString(c, triple, triple || c === 96);
            prevWord = '';
            continue;
        }
        // Identifiers
        if (isIdentStart(c)) {
            const start = i;
            while (i < n && isIdent(source.charCodeAt(i))) i++;
            const word = source.slice(start, i);
            let j = i;
            while (j < n && (source.charCodeAt(j) === 32 || source.charCodeAt(j) === 9)) j++;
            // Skip a short generic argument list: `useState<T>(`, `Vec::<u8>::new(`.
            if (source.charCodeAt(j) === 60 /* < */) {
                let k = j + 1;
                let depth = 1;
                while (k < n && k < j + 120 && depth > 0) {
                    const d = source.charCodeAt(k);
                    if (d === 60) depth++;
                    else if (d === 62) depth--;
                    else if (d === 10 || d === 59 || d === 123) break;
                    k++;
                }
                if (depth === 0) {
                    j = k;
                    while (j < n && (source.charCodeAt(j) === 32 || source.charCodeAt(j) === 9)) j++;
                }
            }
            const declaration = prevWord === 'function' || prevWord === 'def' || prevWord === 'fn' || prevWord === 'func' || prevWord === 'fun' || prevWord === 'class';
            if (source.charCodeAt(j) === 40 /* ( */ && !NOT_CALLS.has(word) && !declaration && !declaredAt.has(`${line}:${word}`)) {
                const receiver = receiverOf(start);
                const via = receiver === undefined ? undefined : SELF.has(receiver) ? 'self' : 'member';
                const from = enclosing(line);
                const id = `${line}:${via ?? ''}:${word}`; // per line: inline handlers need every site, not one per function
                if (!seen.has(id)) {
                    seen.add(id);
                    out.push({ name: word, line, ...(from !== undefined ? { from } : {}), ...(via ? { via } : {}) });
                }
            }
            prevWord = word;
            lastWord = word;
            lastWordEnd = i;
            continue;
        }
        if (c !== 32 && c !== 9 && c !== 46 && c !== 58) prevWord = ''; // `.` and `::` keep a member call's context
        i++;
    }
    return out;
}
