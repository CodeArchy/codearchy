/**
 * Minimal POSIX path helpers for workspace-relative paths ("web/src/a.ts").
 * The core never sees OS paths: hosts convert at the edge, so these never
 * deal with drive letters or backslashes, and never escape the workspace
 * (a ".." above the root makes `resolve` return undefined).
 */

/** Normalises "a/./b/../c" → "a/c"; returns undefined if it climbs above the root. */
export function normalize(p: string): string | undefined {
    const out: string[] = [];
    for (const seg of p.split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') {
            if (out.length === 0) return undefined;
            out.pop();
        } else {
            out.push(seg);
        }
    }
    return out.join('/');
}

/** Joins segments and normalises; undefined if the result leaves the workspace. */
export function join(...parts: string[]): string | undefined {
    return normalize(parts.filter((p) => p !== '').join('/'));
}

/** Directory of a path: "a/b/c.ts" → "a/b"; "c.ts" → "". */
export function dirname(p: string): string {
    const i = p.lastIndexOf('/');
    return i < 0 ? '' : p.slice(0, i);
}

export function basename(p: string): string {
    return p.slice(p.lastIndexOf('/') + 1);
}

/** Extension including the dot: "a/b.test.ts" → ".ts"; "Makefile" → "". */
export function extname(p: string): string {
    const base = basename(p);
    const i = base.lastIndexOf('.');
    return i <= 0 ? '' : base.slice(i);
}

/** True when `p` is `dir` itself or inside it ("" is the workspace root). */
export function isWithin(p: string, dir: string): boolean {
    return dir === '' || p === dir || p.startsWith(`${dir}/`);
}

/** Length of the shared leading characters (used to prefer nearby matches). */
export function commonPrefixLength(a: string, b: string): number {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
}
