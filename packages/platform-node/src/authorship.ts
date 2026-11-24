/**
 * Authorship from git (Phase 5a): classify commits by their metadata, then
 * blame only the files AI commits touched (no other file can have AI lines)
 * and project the AI commits onto today's lines.
 *
 * Read-only: `git log`, `git log --no-walk --name-only` and `git blame`. Works
 * on a workspace that is a subfolder of the repository.
 */
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyCommit, NOTES_REF, overlayRanges, parseNote, projectNotes, rangesFromBlame, serializeNote, subjectOf, type AttributedCommit, type AuthorshipData, type AuthorshipNote, type AuthorshipRule, type BlameRun } from '@codearchy/core';
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

function git(cwd: string, args: string[], maxBuffer = 512 * 1024 * 1024, env?: NodeJS.ProcessEnv): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd, maxBuffer, windowsHide: true, encoding: 'utf8', ...(env ? { env } : {}) }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
}

/**
 * The environment for git commands that record a commit (a note is one, on the
 * notes ref): the user's own identity when git has one, else a neutral one,
 * so a machine without user.name / user.email can still write notes.
 */
async function committerEnv(root: string): Promise<NodeJS.ProcessEnv | undefined> {
    const known = await git(root, ['var', 'GIT_COMMITTER_IDENT']).then(() => true, () => false);
    if (known) return undefined;
    const id = { name: 'CodeArchy', email: 'codearchy@localhost' };
    return { ...process.env, GIT_AUTHOR_NAME: id.name, GIT_AUTHOR_EMAIL: id.email, GIT_COMMITTER_NAME: id.name, GIT_COMMITTER_EMAIL: id.email };
}

/** Runs git with `input` on stdin (for `cat-file --batch`). */
function gitStdin(cwd: string, args: string[], input: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', args, { cwd, windowsHide: true });
        const chunks: Buffer[] = [];
        child.stdout.on('data', (d: Buffer) => chunks.push(d));
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(new Error(`git ${args[0]} exited ${code}`))));
        child.stdin.end(input);
    });
}

/** CodeArchy's authorship notes (refs/notes/codearchy-authorship), by commit; empty when there are none. */
export async function readAuthorshipNotes(root: string): Promise<Map<string, AuthorshipNote>> {
    const notes = new Map<string, AuthorshipNote>();
    let list: string;
    try {
        list = await git(root, ['notes', `--ref=${NOTES_REF}`, 'list']);
    } catch {
        return notes;
    }
    const pairs = list
        .split('\n')
        .map((l) => l.trim().split(' '))
        .filter((p): p is [string, string] => p.length === 2 && isHash(p[0]!) && isHash(p[1]!));
    if (!pairs.length) return notes;
    // One `cat-file --batch` for every note blob: "<sha> blob <size>\n<content>\n" each.
    const out = await gitStdin(root, ['cat-file', '--batch'], pairs.map(([blob]) => blob).join('\n') + '\n');
    const buf = Buffer.from(out, 'utf8');
    let at = 0;
    for (const [, commit] of pairs) {
        const nl = buf.indexOf(10, at);
        if (nl < 0) break;
        const header = buf.subarray(at, nl).toString('utf8').split(' ');
        const size = Number(header[2]);
        if (header[1] !== 'blob' || !Number.isInteger(size)) {
            at = nl + 1;
            continue;
        }
        const note = parseNote(buf.subarray(nl + 1, nl + 1 + size).toString('utf8'));
        if (note) notes.set(commit, note);
        at = nl + 1 + size + 1;
    }
    return notes;
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
    const notes = await readAuthorshipNotes(root).catch(() => new Map<string, AuthorshipNote>());
    const empty = (): GitAuthorship => ({ ok: true, data: { ranges: new Map(), commits, stats: { commits: scanned, aiCommits: commits.size, blamedFiles: 0, notedCommits: notes.size } }, truncated: false });
    if (commits.size === 0 && notes.size === 0) return empty();

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
    // Files that notes speak about need blame too.
    for (const note of notes.values()) {
        for (const repoPath of Object.keys(note.files)) {
            const name = current(repoPath, renamed);
            if (name.startsWith(prefix) && inWorkspace.has(name.slice(prefix.length))) touched.add(name.slice(prefix.length));
        }
    }
    // Commits that only a note attributes: their time and subject, for the Inspector.
    const shown = new Map(commits);
    const noteOnly = [...notes.keys()].filter((h) => !commits.has(h));
    for (let i = 0; i < noteOnly.length; i += 200) {
        const info = await git(root, ['log', '--no-walk=unsorted', `--format=%H${US}%ct${US}%s${RS}`, ...noteOnly.slice(i, i + 200)]).catch(() => '');
        for (const record of info.split(RS)) {
            const [hash, time, subject] = record.trim().split(US);
            if (!hash || !isHash(hash)) continue;
            const agents = Object.values(notes.get(hash)?.files ?? {}).flat().map((r) => r.agent).filter((a): a is string => !!a);
            shown.set(hash, { agent: agents[0] ?? 'unknown-ai', evidence: 'authorship note', time: Number(time) * 1000, subject: (subject ?? '').slice(0, 120) });
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
                const runs = parseIncrementalBlame(out);
                // Commit metadata says "this commit was AI-assisted"; a note says exactly which lines.
                const r = overlayRanges(rangesFromBlame(runs, commits), projectNotes(runs, notes));
                if (r.length) ranges.set(file, r);
            } catch {
                // deleted, binary or unreadable: its lines stay unknown
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 4) }, worker));
    return { ok: true, data: { ranges, commits: shown, stats: { commits: scanned, aiCommits: commits.size, blamedFiles: files.length, notedCommits: notes.size } }, truncated: touched.size > files.length };
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

/**
 * `git blame --incremental`: a `<hash> <orig> <final> <count>` header per run,
 * then key lines, ending with `filename <path at that commit>`.
 */
export function parseIncrementalBlame(out: string): BlameRun[] {
    const runs: BlameRun[] = [];
    for (const line of out.split('\n')) {
        if (line.startsWith('filename ') && runs.length && runs[runs.length - 1]!.file === undefined) {
            runs[runs.length - 1]!.file = line.slice('filename '.length);
            continue;
        }
        if (line.length < 46 || line.charCodeAt(40) !== 32) continue; // "<40 hex> 1 1 1" is the shortest
        const parts = line.split(' ');
        if (parts.length !== 4 || !isHash(parts[0]!)) continue;
        const orig = Number(parts[1]);
        const start = Number(parts[2]);
        const count = Number(parts[3]);
        if (Number.isInteger(start) && Number.isInteger(count) && Number.isInteger(orig)) runs.push({ start, count, commit: parts[0]!, orig });
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

export interface NoteWriteResult {
    commit: string;
    /** Workspace files written to the note. */
    files: string[];
    /** Changed files left out because the working copy differs from the commit (lines wouldn't match). */
    skipped: string[];
}

/**
 * Writes what's known about a commit's changed files (the ledger's ranges,
 * from `rangesFor`) as its authorship note, merged with any note already
 * there. Only files whose working copy equals the commit's version are
 * written, so the line numbers are the commit's. Never pushes: sharing is
 * `git push origin refs/notes/codearchy-authorship`.
 */
export async function writeAuthorshipNote(
    root: string,
    rangesFor: (rel: string) => AuthorshipRange[],
    read: (rel: string) => Promise<string | undefined>,
    commit = 'HEAD'
): Promise<NoteWriteResult> {
    const sha = (await git(root, ['rev-parse', '--verify', `${commit}^{commit}`])).trim();
    const prefix = (await git(root, ['rev-parse', '--show-prefix'])).trim();
    const changed = (await git(root, ['show', '--name-only', '--format=', '-z', sha])).split('\0').filter(Boolean);
    const existing = (await readAuthorshipNotes(root)).get(sha);
    const files = new Map<string, AuthorshipRange[]>(Object.entries(existing?.files ?? {}));
    const written: string[] = [];
    const skipped: string[] = [];
    for (const repoPath of changed) {
        if (!repoPath.startsWith(prefix)) continue;
        const rel = repoPath.slice(prefix.length);
        const ranges = rangesFor(rel).filter((r) => r.origin !== 'unknown');
        if (!ranges.length) continue;
        const [now, then] = await Promise.all([read(rel), git(root, ['show', `${sha}:${repoPath}`], 64 * 1024 * 1024).catch(() => undefined)]);
        if (now === undefined || then === undefined || now !== then) {
            skipped.push(rel);
            continue;
        }
        files.set(repoPath, ranges);
        written.push(rel);
    }
    if (written.length) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codearchy-note-'));
        try {
            const file = path.join(dir, 'note.json');
            fs.writeFileSync(file, serializeNote(files));
            await git(root, ['notes', `--ref=${NOTES_REF}`, 'add', '-f', '-F', file, sha], undefined, await committerEnv(root));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
    return { commit: sha, files: written, skipped };
}
