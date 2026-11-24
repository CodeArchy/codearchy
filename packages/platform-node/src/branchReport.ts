/**
 * The branch report: every line the branch adds since it left its base
 * (committed on the branch, or not committed yet), by who wrote it, per part
 * of the system, plus the dependencies between parts the branch introduces.
 * Read-only git: merge-base, rev-list, diff, blame, show.
 */
import { execFile } from 'node:child_process';
import { addCounts, buildGraph, countLines, emptyCounts, newDependencies, partLabel, partOf, type HierarchyIndex } from '@codearchy/core';
import type { AuthorshipCounts, AuthorshipRange, BranchReport, FileAnalysis } from '@codearchy/protocol';
import { parseIncrementalBlame } from './authorship.js';

export interface BranchReportOptions {
    root: string;
    /** The ref to compare with (default: origin's default branch, then main, then master). */
    base?: string;
    index: HierarchyIndex;
    /** Today's attributed ranges for a workspace file (git evidence, notes and the ledger). */
    rangesFor(rel: string): AuthorshipRange[];
    analyses: ReadonlyMap<string, FileAnalysis>;
    manifests: ReadonlyMap<string, string>;
    /** Re-analyses a file's text as it was at the base (the host's analyzer). */
    analyze(rel: string, text: string): Promise<FileAnalysis | undefined>;
    /** Lines of a workspace file now (for files git doesn't track yet). */
    read(rel: string): Promise<string | undefined>;
}

function git(cwd: string, args: string[], maxBuffer = 256 * 1024 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd, maxBuffer, windowsHide: true, encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
}

const ZERO = '0'.repeat(40);

async function defaultBase(root: string): Promise<string> {
    const remote = (await git(root, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')).trim();
    for (const ref of [remote, 'main', 'master'].filter(Boolean)) {
        if (await git(root, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]).then(() => true, () => false)) return ref;
    }
    throw new Error("Couldn't find a base branch (origin's default, main or master): pass one with --base.");
}

export async function computeBranchReport(o: BranchReportOptions): Promise<BranchReport> {
    const { root } = o;
    // A ref, never an option: git would read "-…" as one.
    if (o.base !== undefined && (o.base.startsWith('-') || !o.base.trim())) throw new Error('The base must be a branch, tag or commit.');
    const base = o.base ?? (await defaultBase(root));
    const mergeBase = (await git(root, ['merge-base', base, 'HEAD']).catch(() => {
        throw new Error(`"${base}" and HEAD have no common history.`);
    })).trim();
    const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
    const branch = new Set((await git(root, ['rev-list', `${mergeBase}..HEAD`])).split('\n').filter(Boolean));
    const prefix = (await git(root, ['rev-parse', '--show-prefix'])).trim();
    const rel = (repoPath: string) => (repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : undefined);

    // What changed since the merge base, working tree included (renames followed); plus untracked files.
    const changed = new Map<string, { status: 'added' | 'modified'; old?: string }>();
    const deleted: string[] = [];
    const parts = (await git(root, ['diff', '--name-status', '-z', '-M', mergeBase, '--'])).split('\0');
    for (let i = 0; i < parts.length; i++) {
        const status = parts[i]!;
        if (!status) continue;
        if (status.startsWith('R') || status.startsWith('C')) {
            const from = rel(parts[i + 1] ?? '');
            const to = rel(parts[i + 2] ?? '');
            i += 2;
            if (to) changed.set(to, { status: status.startsWith('C') ? 'added' : 'modified', ...(from ? { old: from } : {}) });
            continue;
        }
        const p = rel(parts[i + 1] ?? '');
        i += 1;
        if (!p) continue;
        if (status === 'D') deleted.push(p);
        else changed.set(p, { status: status === 'A' ? 'added' : 'modified' });
    }
    const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
    for (const p of untracked) if (!changed.has(p)) changed.set(p, { status: 'added' });

    // Added lines: blamed on a branch commit, or not committed yet. Only indexed source files count.
    const report: BranchReport = { base, mergeBase, head, commits: branch.size, added: emptyCounts(), uncommitted: 0, byAgent: {}, byPart: [], files: [], newDependencies: [], deleted: [...deleted].sort() };
    const byPart = new Map<string, { key: string; name: string; added: AuthorshipCounts }>();
    const untrackedSet = new Set(untracked);
    for (const [path, { status }] of changed) {
        if (!o.analyses.has(path)) continue;
        const lines: number[] = [];
        if (untrackedSet.has(path)) {
            const text = await o.read(path);
            const n = text === undefined ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
            for (let k = 1; k <= n; k++) lines.push(k);
            report.uncommitted += n;
        } else {
            const out = await git(root, ['blame', '--incremental', '--', path], 64 * 1024 * 1024).catch(() => '');
            for (const run of parseIncrementalBlame(out)) {
                const fresh = run.commit === ZERO;
                if (!fresh && !branch.has(run.commit)) continue;
                for (let k = 0; k < run.count; k++) lines.push(run.start + k);
                if (fresh) report.uncommitted += run.count;
            }
        }
        if (!lines.length) continue;
        const counts = countLines(lines, o.rangesFor(path), report.byAgent);
        report.files.push({ path, added: counts, status });
        report.added = addCounts(report.added, counts);
        const part = partOf(o.index, path);
        if (part) {
            const entry = byPart.get(part.key) ?? { key: part.key, name: partLabel(part), added: emptyCounts() };
            entry.added = addCounts(entry.added, counts);
            byPart.set(part.key, entry);
        }
    }
    const size = (c: AuthorshipCounts) => c.ai + c.reviewed + c.human + c.unknown;
    report.files.sort((a, b) => size(b.added) - size(a.added) || (a.path < b.path ? -1 : 1));
    report.byPart = [...byPart.values()].sort((a, b) => size(b.added) - size(a.added));

    // New dependencies: the changed files' imports today vs at the merge base, lifted to parts.
    const before = new Map(o.analyses);
    for (const [path, { status, old }] of changed) {
        if (!o.analyses.has(path)) continue;
        before.delete(path);
        if (status === 'added' && !old) continue;
        const was = old ?? path;
        const text = await git(root, ['show', `${mergeBase}:${prefix}${was}`]).catch(() => undefined);
        const a = text === undefined ? undefined : await o.analyze(was, text).catch(() => undefined);
        if (a) before.set(was, a);
    }
    for (const p of deleted) {
        const text = await git(root, ['show', `${mergeBase}:${prefix}${p}`]).catch(() => undefined);
        const a = text === undefined ? undefined : await o.analyze(p, text).catch(() => undefined);
        if (a) before.set(p, a);
    }
    const sources = new Set([...changed.keys(), ...[...changed.values()].map((c) => c.old).filter((x): x is string => !!x), ...deleted]);
    // Before: every dependency at the merge base (a new file importing a part others already use adds nothing).
    // After: only the changed files' dependencies can be new.
    const pairs = (analyses: Iterable<FileAnalysis>, onlyChanged: boolean) =>
        buildGraph(analyses, new Map(o.manifests))
            .edges.filter((e) => !onlyChanged || sources.has(e.source))
            .map((e): [string, string] => [e.source, e.target]);
    report.newDependencies = newDependencies(o.index, pairs(before.values(), false), pairs(o.analyses.values(), true));
    return report;
}
