/**
 * Repository URLs the browser can open: public GitHub and GitLab (gitlab.com).
 * No dependencies, so the page can check a URL without loading the engine.
 */

export interface RepositoryRef {
    host: 'github' | 'gitlab';
    /** `owner/repo` (GitHub) or `group/subgroup/project` (GitLab). */
    path: string;
    /** A branch, tag or commit from the URL (`/tree/<ref>`); the default branch otherwise. */
    ref?: string;
}

/** Files read from a repository at most (an index of more wants the Companion). */
export const MAX_REPOSITORY_FILES = 8000;

/**
 * `https://github.com/owner/repo`, `github.com/owner/repo/tree/main`, `owner/repo`
 * (GitHub), `git@github.com:owner/repo.git`, `https://gitlab.com/group/project/-/tree/dev`…
 */
export function parseRepositoryUrl(input: string): RepositoryRef | undefined {
    let s = input.trim();
    if (!s) return undefined;
    const ssh = /^git@(github\.com|gitlab\.com):(.+)$/i.exec(s);
    if (ssh) s = `https://${ssh[1]}/${ssh[2]}`;
    if (/^[\w.-]+\/[\w.-]+$/.test(s)) s = `https://github.com/${s}`; // owner/repo
    if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
    let url: URL;
    try {
        url = new URL(s);
    } catch {
        return undefined;
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const parts = url.pathname
        .split('/')
        .filter(Boolean)
        .map((p) => decodeURIComponent(p));
    const clean = (p: string) => p.replace(/\.git$/i, '');
    if (host === 'github.com') {
        if (parts.length < 2) return undefined;
        const [owner, repo, kind, ...rest] = parts;
        const ref = (kind === 'tree' || kind === 'commit' || kind === 'blob') && rest[0] ? rest[0] : undefined;
        return { host: 'github', path: `${owner}/${clean(repo!)}`, ...(ref ? { ref } : {}) };
    }
    if (host === 'gitlab.com') {
        const dash = parts.indexOf('-');
        const project = (dash >= 0 ? parts.slice(0, dash) : parts).map(clean);
        if (project.length < 2) return undefined;
        const after = dash >= 0 ? parts.slice(dash + 1) : [];
        const ref = (after[0] === 'tree' || after[0] === 'commit' || after[0] === 'blob') && after[1] ? after[1] : undefined;
        return { host: 'gitlab', path: project.join('/'), ...(ref ? { ref } : {}) };
    }
    return undefined;
}
