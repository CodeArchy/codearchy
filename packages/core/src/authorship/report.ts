/**
 * The branch report, the pure part: counting added lines by origin, lifting
 * file dependencies to the parts of the system, finding the ones a branch
 * introduces, and rendering it all as Markdown for a PR or a review.
 */
import { agentName, type AuthorshipCounts, type AuthorshipRange, type BranchReport, type HierarchyNode } from '@codearchy/protocol';
import type { HierarchyIndex } from '../hierarchy/project.js';
import { emptyCounts } from './index.js';
import { displayName } from '../tours/startHere.js';

/** The part a file belongs to: its nearest component or package, or the file itself when it has none. */
export function partOf(index: HierarchyIndex, path: string): HierarchyNode | undefined {
    const mod = index.indexOf(`mod:${path}`);
    if (mod === undefined) return undefined;
    const nodes = index.hierarchy.nodes;
    for (const i of index.ancestors(mod).reverse()) {
        const n = nodes[i]!;
        if (n.kind === 'component' || n.kind === 'package') return n;
    }
    return nodes[mod];
}

/** Lines (1-based) counted by the origin the ranges give them (lines no range covers are unknown). */
export function countLines(lines: Iterable<number>, ranges: AuthorshipRange[], byAgent?: Record<string, number>): AuthorshipCounts {
    const out = emptyCounts();
    const sorted = [...ranges].sort((a, b) => a.start - b.start);
    for (const n of lines) {
        const r = sorted.find((x) => x.start <= n && x.end >= n);
        const origin = r?.origin ?? 'unknown';
        out[origin]++;
        if (byAgent && r?.agent && (origin === 'ai' || origin === 'reviewed')) byAgent[r.agent] = (byAgent[r.agent] ?? 0) + 1;
    }
    return out;
}

export function addCounts(a: AuthorshipCounts, b: AuthorshipCounts): AuthorshipCounts {
    return { ai: a.ai + b.ai, reviewed: a.reviewed + b.reviewed, human: a.human + b.human, unknown: a.unknown + b.unknown };
}

const total = (c: AuthorshipCounts) => c.ai + c.reviewed + c.human + c.unknown;

/**
 * Part-to-part dependencies present `after` but not `before` (file pairs,
 * lifted to their parts in today's hierarchy), with the file pairs behind each.
 */
export function newDependencies(index: HierarchyIndex, before: Iterable<[string, string]>, after: Iterable<[string, string]>): BranchReport['newDependencies'] {
    const lift = (pairs: Iterable<[string, string]>) => {
        const out = new Map<string, { from: HierarchyNode; to: HierarchyNode; via: Array<{ from: string; to: string }> }>();
        for (const [a, b] of pairs) {
            const pa = partOf(index, a);
            const pb = partOf(index, b);
            if (!pa || !pb || pa.key === pb.key || index.contains(pa.tin, pb.tin) || index.contains(pb.tin, pa.tin)) continue;
            // Tests depending on the code they test isn't architecture news.
            if (pa.role?.role === 'test' || index.node(`mod:${a}`)?.role?.role === 'test') continue;
            const id = `${pa.key}\u0000${pb.key}`;
            const e = out.get(id) ?? { from: pa, to: pb, via: [] };
            if (e.via.length < 5) e.via.push({ from: a, to: b });
            out.set(id, e);
        }
        return out;
    };
    const old = lift(before);
    return [...lift(after)]
        .filter(([id]) => !old.has(id))
        .map(([, e]) => ({ from: e.from.key, to: e.to.key, fromName: displayName(e.from), toName: displayName(e.to), via: e.via }))
        .sort((a, b) => (a.fromName + a.toName < b.fromName + b.toName ? -1 : 1));
}

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '0%');

/** The report as Markdown: a headline, then where the lines went and what the branch now depends on. */
export function renderBranchReport(r: BranchReport): string {
    const t = total(r.added);
    const lines: string[] = [];
    lines.push(`## Authorship: this branch vs \`${r.base}\``, '');
    if (!t && !r.deleted.length) {
        lines.push(`No lines added since \`${r.mergeBase.slice(0, 7)}\`.`, '');
        return lines.join('\n');
    }
    const ai = r.added.ai;
    const headline = [`**${t.toLocaleString()} lines added** in ${r.commits} commit${r.commits === 1 ? '' : 's'}${r.uncommitted ? ` (${r.uncommitted.toLocaleString()} not committed yet)` : ''}:`];
    headline.push(`${ai.toLocaleString()} written by AI tools and not changed since (${pct(ai, t)})`);
    headline.push(`${r.added.reviewed.toLocaleString()} AI-written and reviewed or changed by a person (${pct(r.added.reviewed, t)})`);
    headline.push(`${r.added.human.toLocaleString()} by people (${pct(r.added.human, t)})`);
    headline.push(`${r.added.unknown.toLocaleString()} with no evidence either way (${pct(r.added.unknown, t)}).`);
    lines.push(`${headline[0]} ${headline.slice(1).join(', ')}`, '');
    const agents = Object.entries(r.byAgent).sort((a, b) => b[1] - a[1]);
    if (agents.length) lines.push(`By tool: ${agents.map(([a, n]) => `${agentName(a)} ${n.toLocaleString()}`).join(' · ')}.`, '');
    if (r.newDependencies.length) {
        lines.push('### New dependencies', '');
        for (const d of r.newDependencies) lines.push(`- **${d.fromName} → ${d.toName}** (${d.via.map((v) => `\`${v.from}\` → \`${v.to}\``).join(', ')})`);
        lines.push('');
    }
    if (r.byPart.length) {
        lines.push('### By part', '', '| Part | Added | AI (unchanged) | Reviewed | Human | Unknown |', '|---|---:|---:|---:|---:|---:|');
        for (const p of r.byPart.slice(0, 15)) lines.push(`| ${p.name} | ${total(p.added)} | ${p.added.ai} | ${p.added.reviewed} | ${p.added.human} | ${p.added.unknown} |`);
        lines.push('');
    }
    const aiFiles = r.files.filter((f) => f.added.ai > 0).sort((a, b) => b.added.ai - a.added.ai).slice(0, 10);
    if (aiFiles.length) {
        lines.push('### Unreviewed AI-written lines', '', ...aiFiles.map((f) => `- \`${f.path}\`: ${f.added.ai} of ${total(f.added)} added lines${f.status === 'added' ? ' (new file)' : ''}`), '');
    }
    if (r.deleted.length) lines.push(`${r.deleted.length} file${r.deleted.length === 1 ? '' : 's'} deleted.`, '');
    lines.push('<sub>Authorship from evidence only (agent logs, authorship notes, co-author trailers, editor capture, people\'s reviews); lines without evidence are unknown. Generated by CodeArchy.</sub>', '');
    return lines.join('\n');
}
