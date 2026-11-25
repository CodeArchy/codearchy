import { describe, expect, test } from 'vitest';
import { downloadRepository, parseRepositoryUrl, RepositoryError } from '../../src/engine/repository.js';

describe('parseRepositoryUrl', () => {
    test('GitHub in its usual forms, with a branch from /tree/', () => {
        for (const u of ['https://github.com/acme/shop', 'github.com/acme/shop', 'acme/shop', 'https://github.com/acme/shop.git', 'git@github.com:acme/shop.git', 'https://www.github.com/acme/shop/']) {
            expect(parseRepositoryUrl(u)).toEqual({ host: 'github', path: 'acme/shop' });
        }
        expect(parseRepositoryUrl('https://github.com/acme/shop/tree/dev/src')).toEqual({ host: 'github', path: 'acme/shop', ref: 'dev' });
    });

    test('GitLab, with subgroups and /-/tree/', () => {
        expect(parseRepositoryUrl('https://gitlab.com/group/sub/project')).toEqual({ host: 'gitlab', path: 'group/sub/project' });
        expect(parseRepositoryUrl('gitlab.com/group/project/-/tree/main')).toEqual({ host: 'gitlab', path: 'group/project', ref: 'main' });
        expect(parseRepositoryUrl('git@gitlab.com:group/project.git')).toEqual({ host: 'gitlab', path: 'group/project' });
    });

    test('anything else is not a repository URL', () => {
        for (const u of ['', 'https://example.com/a/b', 'https://github.com/acme', 'not a url at all', 'https://bitbucket.org/a/b']) expect(parseRepositoryUrl(u)).toBeUndefined();
    });
});

/** A fake GitHub: the repo, its tree, and raw files (with request counting). */
function fakeGitHub(opts: { status?: number; rateLimited?: boolean } = {}) {
    const asked: string[] = [];
    const tree = [
        { path: 'package.json', type: 'blob', sha: 'aaa111', size: 40 },
        { path: 'src/index.ts', type: 'blob', sha: 'bbb222', size: 30 },
        { path: 'src/util.ts', type: 'blob', sha: 'ccc333', size: 20 },
        { path: 'src/big.ts', type: 'blob', sha: 'ddd444', size: 5_000_000 },
        { path: 'docs/logo.png', type: 'blob', sha: 'eee555', size: 900 },
        { path: 'node_modules/x/index.js', type: 'blob', sha: 'fff666', size: 10 },
        { path: 'dist/out.js', type: 'blob', sha: 'abc777', size: 10 },
        { path: 'src', type: 'tree', sha: '999' },
    ];
    const fetch = (async (input: string) => {
        const url = String(input);
        asked.push(url);
        if (opts.rateLimited) return new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1767225600' } });
        if (opts.status) return new Response('{}', { status: opts.status });
        if (url === 'https://api.github.com/repos/acme/shop') return Response.json({ default_branch: 'main' });
        if (url === 'https://api.github.com/repos/acme/shop/git/trees/main?recursive=1') return Response.json({ tree, truncated: false });
        if (url.startsWith('https://raw.githubusercontent.com/acme/shop/main/')) return new Response(`// ${url.slice(49)}`);
        return new Response('', { status: 404 });
    }) as unknown as typeof globalThis.fetch;
    return { fetch, asked };
}

describe('downloadRepository (GitHub)', () => {
    test('two API calls, then only the files the indexer reads, with progress and content-derived stamps', async () => {
        const { fetch, asked } = fakeGitHub();
        const progress: string[] = [];
        const repo = await downloadRepository('https://github.com/acme/shop', { maxFileSize: 1_000_000, fetch, onProgress: (c, t) => progress.push(`${c}/${t}`) });
        expect(repo.name).toBe('acme/shop');
        expect(repo.entries.map(([p]) => p)).toEqual(['package.json', 'src/index.ts', 'src/util.ts']);
        expect(asked.filter((u) => u.startsWith('https://api.github.com'))).toHaveLength(2);
        // Never fetched: too big, not code, excluded folders.
        expect(asked.some((u) => /big\.ts|logo\.png|node_modules|dist\//.test(u))).toBe(false);
        expect(progress[0]).toBe('0/3');
        expect(progress.at(-1)).toBe('3/3');
        const [, entry] = repo.entries.find(([p]) => p === 'src/index.ts')!;
        expect(await (entry.data as Blob).text()).toBe('// src/index.ts');
        expect(entry.mtimeMs).toBe(parseInt('bbb222', 16));
        expect(repo.truncated).toBe(false);
    });

    test('a branch in the URL skips the repository lookup', async () => {
        const { fetch, asked } = fakeGitHub();
        await downloadRepository('acme/shop/tree/main', { maxFileSize: 1_000_000, fetch }).catch(() => undefined);
        expect(asked.some((u) => u === 'https://api.github.com/repos/acme/shop')).toBe(false);
    });

    test('says plainly when the repository is private or missing, or GitHub’s anonymous limit is reached', async () => {
        await expect(downloadRepository('acme/secret', { maxFileSize: 1e6, fetch: fakeGitHub({ status: 404 }).fetch })).rejects.toThrow(/no public repository acme\/secret/);
        await expect(downloadRepository('acme/shop', { maxFileSize: 1e6, fetch: fakeGitHub({ rateLimited: true }).fetch })).rejects.toThrow(/60 an hour/);
        await expect(downloadRepository('https://example.com/x/y', { maxFileSize: 1e6 })).rejects.toBeInstanceOf(RepositoryError);
    });
});

describe('downloadRepository (GitLab)', () => {
    test('one archive, unzipped by the engine, with progress in kilobytes', async () => {
        const asked: string[] = [];
        const fetch = (async (input: string) => {
            asked.push(String(input));
            return new Response(new Uint8Array(4096), { headers: { 'content-length': '4096' } });
        }) as unknown as typeof globalThis.fetch;
        const progress: string[] = [];
        const repo = await downloadRepository('https://gitlab.com/group/sub/project/-/tree/dev', {
            maxFileSize: 1e6,
            fetch,
            onProgress: (c, t) => progress.push(`${c}/${t}`),
            unzip: (data) => [[`size-${data.length}.ts`, { data: 'x', mtimeMs: 1 }]],
        });
        expect(asked).toEqual(['https://gitlab.com/api/v4/projects/group%2Fsub%2Fproject/repository/archive.zip?sha=dev']);
        expect(repo).toMatchObject({ name: 'group/sub/project', entries: [['size-4096.ts', { data: 'x', mtimeMs: 1 }]] });
        expect(progress.at(-1)).toBe('4/4');
    });

    test('GitLab busy (406 while it prepares the archive, or 429): one retry, then a plain message', async () => {
        let calls = 0;
        const busyOnce = (async () => (++calls === 1 ? new Response('{}', { status: 406 }) : new Response(new Uint8Array(8)))) as unknown as typeof globalThis.fetch;
        const ok = await downloadRepository('gitlab.com/g/p', { maxFileSize: 1e6, fetch: busyOnce, retryDelayMs: 0, unzip: () => [] });
        expect([ok.name, calls]).toEqual(['g/p', 2]);
        const busy = (async () => new Response('{}', { status: 429 })) as unknown as typeof globalThis.fetch;
        await expect(downloadRepository('gitlab.com/g/p', { maxFileSize: 1e6, fetch: busy, retryDelayMs: 0, unzip: () => [] })).rejects.toThrow(/limiting archive downloads/);
    });
});
