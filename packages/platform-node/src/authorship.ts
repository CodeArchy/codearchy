/**
 * Authorship from git (Phase 5a): classify commits by their metadata, then
 * blame only the files AI commits touched (no other file can have AI lines)
 * and project the AI commits onto today's lines.
 *
 * Read-only: `git log`, `git log --no-walk --name-only` and `git blame`. Works
 * on a workspace that is a subfolder of the repository.
 */
import { execFile } from 'node:child_process';
import { classifyCommit, rangesFromBlame, subjectOf, type AttributedCommit, type AuthorshipData, type AuthorshipRule } from '@codearchy/core';
import type { AuthorshipRange } from '@codearchy/protocol';

export interface GitAuthorshipOptions {
    /** Commits read from HEAD back (default 100 000). */
    maxCommits?: number;
    /** Files blamed at most (default 5 000); the rest stay `unknown`. */
    maxFiles?: number;
    concurrency?: number;
    /** Extra AI markers (an in-house agent's co-author line…). */
    rules?: AuthorshipRule[];
    isCancelled?: () => boolean;
}

export type GitAuthorship = { ok: true; data: AuthorshipData; truncated: boolean } | { ok: false; reason: string };

function git(cwd: string, args: string[], maxBuffer = 512 * 1024 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd, maxBuffer, windowsHide: true, encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
}

const RS = '\x1e';
const US = '\x1f';

export async function computeGitAuthorship(root: string, workspaceFiles: Iterable<string>, options: GitAuthorshipOptions = {}): Promise<GitAuthorship> {
    let prefix: string;
    try {
        prefix = (await git(root, ['rev-parse', '--show-prefix'])).trim();
    } catch {
        return { ok: false, reason: 'This folder is not in a git repository, so there is no history to attribute lines to.' };
    }
    let log: string;
    try {
        log = await git(root, ['log', `--max-count=${options.maxCommits ?? 100_000}`, `--format=%H${US}%ct${US}%an${US}%ae${US}%B${RS}`, 'HEAD']);
    } catch {
        return { ok: false, reason: 'The repository has no commits yet.' };
    }

    const commits = new Map<string, AttributedCommit>();
    let scanned = 0;
    for (const record of log.split(RS)) {
        const [hash, time, authorName, authorEmail, message] = record.replace(/^\n/, '').split(US);
        if (!hash || hash.length < 40) continue;
        scanned++;
        const attribution = classifyCommit({ authorName: authorName ?? '', authorEmail: authorEmail ?? '', message: message ?? '' }, options.rules);
        if (attribution) commits.set(hash, { ...attribution, time: Number(time) * 1000, subject: subjectOf(message ?? '') });
    }
    const empty = (): GitAuthorship => ({ ok: true, data: { ranges: new Map(), commits, stats: { commits: scanned, aiCommits: commits.size, blamedFiles: 0 } }, truncated: false });
    if (commits.size === 0) return empty();

    // The workspace files AI commits touched (git paths are relative to the repository root),
    // followed through later renames (a moved file keeps its blame).
    const renamed = await renames(root);
    const inWorkspace = new Set(workspaceFiles);
    const touched = new Set<string>();
    const hashes = [...commits.keys()];
    for (let i = 0; i < hashes.length; i += 200) {
        if (options.isCancelled?.()) return empty();
        const names = await git(root, ['log', '--no-walk=unsorted', '--name-only', '--format=', '-z', ...hashes.slice(i, i + 200)]);
        for (const raw of names.split('\0')) {
            const name = raw.trim() && current(raw.trim(), renamed);
            if (!name || !name.startsWith(prefix)) continue;
            const rel = name.slice(prefix.length);
            if (inWorkspace.has(rel)) touched.add(rel);
        }
    }

    const maxFiles = options.maxFiles ?? 5000;
    const files = [...touched].sort().slice(0, maxFiles);
    const ranges = new Map<string, AuthorshipRange[]>();
    let next = 0;
    const worker = async () => {
        while (next < files.length && !options.isCancelled?.()) {
            const file = files[next++]!;
            try {
                const out = await git(root, ['blame', '--incremental', '--', file], 64 * 1024 * 1024);
                const r = rangesFromBlame(parseIncrementalBlame(out), commits);
                if (r.length) ranges.set(file, r);
            } catch {
                // deleted, binary or unreadable: its lines stay unknown
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 4) }, worker));
    return { ok: true, data: { ranges, commits, stats: { commits: scanned, aiCommits: commits.size, blamedFiles: files.length } }, truncated: touched.size > files.length };
}

/** Where each renamed path ended up (old → newer), from one pass over the history's renames. */
async function renames(root: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
        const out = await git(root, ['log', '-M', '--diff-filter=R', '--name-status', '--format=', '-z', 'HEAD']);
        // -z: "R100\0old\0new\0" per rename, newest commit first.
        const parts = out.split('\0');
        for (let i = 0; i + 2 < parts.length; i++) {
            const status = parts[i]!.trim();
            if (!status.startsWith('R')) continue;
            const from = parts[i + 1]!;
            const to = parts[i + 2]!;
            // Newest first: the first rename seen for a path is its latest; keep it.
            if (!map.has(from)) map.set(from, to);
            i += 2;
        }
    } catch {
        // no renames to follow
    }
    return map;
}

/** Follows a path through its renames to today's name (bounded, in case of cycles). */
function current(path: string, renamed: Map<string, string>): string {
    let p = path;
    for (let hops = 0; hops < 50; hops++) {
        const next = renamed.get(p);
        if (!next || next === p) break;
        p = next;
    }
    return p;
}

/** `git blame --incremental`: a `<hash> <orig> <final> <count>` header per run, then key lines. */
export function parseIncrementalBlame(out: string): Array<{ start: number; count: number; commit: string }> {
    const runs: Array<{ start: number; count: number; commit: string }> = [];
    for (const line of out.split('\n')) {
        if (line.length < 46 || line.charCodeAt(40) !== 32) continue; // "<40 hex> 1 1 1" is the shortest
        const parts = line.split(' ');
        if (parts.length !== 4 || !isHash(parts[0]!)) continue;
        const start = Number(parts[2]);
        const count = Number(parts[3]);
        if (Number.isInteger(start) && Number.isInteger(count)) runs.push({ start, count, commit: parts[0]! });
    }
    return runs;
}

function isHash(s: string): boolean {
    if (s.length !== 40) return false;
    for (let i = 0; i < 40; i++) {
        const c = s.charCodeAt(i);
        if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return false;
    }
    return true;
}
