/**
 * Minimal glob matcher for exclude patterns, applied to workspace-relative
 * POSIX paths. Supports `**`, `*`, `?` and `{a,b}`; that covers VS Code-style
 * exclude settings without pulling in a dependency.
 */
export function globToRegExp(glob: string): RegExp {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                const atSegmentStart = i === 0 || glob[i - 1] === '/';
                i++;
                if (glob[i + 1] === '/' && atSegmentStart) {
                    i++;
                    re += '(?:.*/)?'; // `**/` — zero or more directories
                } else {
                    re += '.*';
                }
            } else {
                re += '[^/]*';
            }
        } else if (c === '?') {
            re += '[^/]';
        } else if (c === '{') {
            const close = glob.indexOf('}', i);
            if (close < 0) {
                re += '\\{';
                continue;
            }
            const options = glob.slice(i + 1, close).split(',');
            re += `(?:${options.map((o) => globToRegExp(o).source.slice(1, -1)).join('|')})`;
            i = close;
        } else {
            re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${re}$`);
}

export function compileGlobs(globs: string[]): (relativePosixPath: string) => boolean {
    const regexes = globs.filter(Boolean).map(globToRegExp);
    if (regexes.length === 0) return () => false;
    return (p) => regexes.some((r) => r.test(p));
}
