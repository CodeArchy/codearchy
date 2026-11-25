/**
 * Authorship over the hierarchy: per-file attributed ranges (from blame over
 * AI commits, later from live capture and agent logs) summed into every node.
 * Nodes are stored in DFS pre-order, so a container's counts are a difference
 * of prefix sums over its Euler interval: O(1) per node after O(N) setup.
 */
import type { AuthorshipCommit, AuthorshipCounts, AuthorshipOrigin, AuthorshipRange, AuthorshipStatus, NodeAuthorship, NodeOwner, NodeOwnership, View } from '@codearchy/protocol';
import type { HierarchyIndex } from '../hierarchy/project.js';

const ORIGINS: AuthorshipOrigin[] = ['ai', 'reviewed', 'human', 'unknown'];

export interface AttributedCommit {
    agent: string;
    evidence: string;
    time: number;
    subject: string;
}

/** A person's lines in one file (git blame), by index into `AuthorshipData.people`. */
export interface FileOwner {
    person: number;
    lines: number;
    /** Their latest change to a line still here (ms). */
    last: number;
}

export interface AuthorshipData {
    /** Attributed ranges per workspace file; files not listed are all `unknown`. */
    ranges: Map<string, AuthorshipRange[]>;
    commits: Map<string, AttributedCommit>;
    stats: { commits: number; aiCommits: number; blamedFiles: number; notedCommits?: number; people?: number };
    /** People ownership (when it's on): each file's lines by the person who last changed them. */
    owners?: Map<string, FileOwner[]>;
    /** Display names, by person index. */
    people?: string[];
}

/** At most this many owners are listed per part. */
const OWNERS_SHOWN = 8;

export const emptyCounts = (): AuthorshipCounts => ({ ai: 0, reviewed: 0, human: 0, unknown: 0 });

export class AuthorshipIndex {
    /** prefix[o][i] = lines of origin o in nodes[0..i). */
    private readonly prefix: Record<AuthorshipOrigin, Float64Array>;
    private readonly owned = new Map<string, NodeOwnership | undefined>();

    constructor(
        private readonly index: HierarchyIndex,
        private readonly lines: (path: string) => number | undefined,
        private readonly data: AuthorshipData
    ) {
        const nodes = index.hierarchy.nodes;
        const n = nodes.length;
        this.prefix = { ai: new Float64Array(n + 1), reviewed: new Float64Array(n + 1), human: new Float64Array(n + 1), unknown: new Float64Array(n + 1) };
        for (let i = 0; i < n; i++) {
            const c = nodes[i]!.kind === 'module' ? this.fileCounts(nodes[i]!.path) : undefined;
            for (const o of ORIGINS) this.prefix[o][i + 1] = this.prefix[o][i]! + (c ? c[o] : 0);
        }
    }

    /** Lines per origin in a file. */
    fileCounts(path: string): AuthorshipCounts {
        const c = emptyCounts();
        let attributed = 0;
        let last = 0;
        for (const r of this.data.ranges.get(path) ?? []) {
            const len = r.end - r.start + 1;
            c[r.origin] += len;
            attributed += len;
            last = Math.max(last, r.end);
        }
        const total = Math.max(this.lines(path) ?? last, last);
        c.unknown += total - attributed;
        return c;
    }

    counts(key: string): AuthorshipCounts | undefined {
        const i = this.index.indexOf(key);
        if (i === undefined) return undefined;
        const n = this.index.hierarchy.nodes[i]!;
        const out = emptyCounts();
        for (const o of ORIGINS) out[o] = this.prefix[o][n.tout + 1]! - this.prefix[o][n.tin]!;
        return out;
    }

    /** The view with every node's counts (the Authorship lens) and main owner (the Ownership lens) attached. */
    decorate(view: View): View {
        return {
            ...view,
            nodes: view.nodes.map((v) => {
                const owner = this.owner(v.key);
                return { ...v, authorship: this.counts(v.key) ?? emptyCounts(), ...(owner ? { owner } : {}) };
            }),
        };
    }

    status(): AuthorshipStatus {
        return { state: 'ready', ...this.data.stats, counts: this.counts('sys:root') ?? emptyCounts() };
    }

    /**
     * Who holds a part's lines today: each person's lines (whoever last changed
     * them), their latest change, and the bus factor (the fewest people who
     * together hold more than half). Undefined when ownership is off.
     */
    ownership(key: string): NodeOwnership | undefined {
        const owners = this.data.owners;
        if (!owners) return undefined;
        if (this.owned.has(key)) return this.owned.get(key);
        const i = this.index.indexOf(key);
        if (i === undefined) return undefined;
        const nodes = this.index.hierarchy.nodes;
        const node = nodes[i]!;
        const per = new Map<number, { lines: number; last: number }>();
        for (let j = node.tin; j <= node.tout; j++) {
            const m = nodes[j]!;
            if (m.kind !== 'module') continue;
            for (const o of owners.get(m.path) ?? []) {
                const p = per.get(o.person);
                if (p) {
                    p.lines += o.lines;
                    p.last = Math.max(p.last, o.last);
                } else per.set(o.person, { lines: o.lines, last: o.last });
            }
        }
        const ranked = [...per].sort((a, b) => b[1].lines - a[1].lines || b[1].last - a[1].last);
        const lines = ranked.reduce((n, [, p]) => n + p.lines, 0);
        let busFactor = 0;
        for (let held = 0; held * 2 <= lines && busFactor < ranked.length; ) held += ranked[busFactor++]![1].lines;
        const result: NodeOwnership = {
            lines,
            people: ranked.length,
            owners: ranked.slice(0, OWNERS_SHOWN).map(([person, p]) => ({ name: this.data.people?.[person] ?? 'Someone', lines: p.lines, share: lines ? Math.round((p.lines / lines) * 100) : 0, lastChange: p.last })),
            busFactor: lines ? busFactor : 0,
            ...(ranked.length ? { lastChange: Math.max(...ranked.map(([, p]) => p.last)) } : {}),
        };
        this.owned.set(key, result);
        return result;
    }

    /** A node's main owner, for the Ownership lens. */
    owner(key: string): NodeOwner | undefined {
        const o = this.ownership(key);
        const top = o?.owners[0];
        return o && top ? { name: top.name, share: top.share, people: o.people, busFactor: o.busFactor } : undefined;
    }

    describe(key: string): NodeAuthorship | undefined {
        const i = this.index.indexOf(key);
        if (i === undefined) return undefined;
        const nodes = this.index.hierarchy.nodes;
        const node = nodes[i]!;
        const byAgent: Record<string, number> = {};
        const files: Array<{ path: string; ai: number; lines: number }> = [];
        const weeks = new Map<number, number>();
        const perCommit = new Map<string, number>();
        for (let j = node.tin; j <= node.tout; j++) {
            const m = nodes[j]!;
            if (m.kind !== 'module') continue;
            const ranges = this.data.ranges.get(m.path);
            if (!ranges?.length) continue;
            let ai = 0;
            for (const r of ranges) {
                const len = r.end - r.start + 1;
                if (r.origin === 'ai' || r.origin === 'reviewed') {
                    if (r.agent) byAgent[r.agent] = (byAgent[r.agent] ?? 0) + len;
                    if (r.origin === 'ai') ai += len;
                }
                if (r.commit && this.data.commits.has(r.commit)) {
                    perCommit.set(r.commit, (perCommit.get(r.commit) ?? 0) + len);
                    if (r.origin === 'ai') {
                        const t = this.data.commits.get(r.commit)!.time;
                        const week = weekOf(t);
                        weeks.set(week, (weeks.get(week) ?? 0) + len);
                    }
                }
            }
            if (ai) files.push({ path: m.path, ai, lines: total(this.fileCounts(m.path)) });
        }
        const commits: AuthorshipCommit[] = [...perCommit]
            .sort((a, b) => b[1] - a[1] || this.data.commits.get(b[0])!.time - this.data.commits.get(a[0])!.time)
            .slice(0, 8)
            .map(([hash, lines]) => {
                const c = this.data.commits.get(hash)!;
                return { hash, agent: c.agent, time: c.time, subject: c.subject, evidence: c.evidence, lines };
            });
        return {
            key,
            counts: this.counts(key)!,
            byAgent,
            topFiles: node.kind === 'module' ? [] : files.sort((a, b) => b.ai - a.ai || (a.path < b.path ? -1 : 1)).slice(0, 10),
            weekly: [...weeks].sort((a, b) => a[0] - b[0]).map(([week, ai]) => ({ week, ai })),
            commits,
            ...(node.kind === 'module' ? { ranges: this.data.ranges.get(node.path) ?? [] } : {}),
            ...(this.data.owners ? { ownership: this.ownership(key)! } : {}),
        };
    }
}

export function total(c: AuthorshipCounts): number {
    return c.ai + c.reviewed + c.human + c.unknown;
}

/** Monday 00:00 UTC of the week containing `t`. */
export function weekOf(t: number): number {
    const d = new Date(t);
    const day = (d.getUTCDay() + 6) % 7; // Monday = 0
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}

/**
 * Blame runs (`start`, `count`, `commit`) → attributed ranges: lines whose
 * last change is an AI commit are `ai` (declared, commit-granular); the rest
 * stay `unknown` and are left out. Adjacent runs of one commit merge.
 */
export function rangesFromBlame(runs: Array<{ start: number; count: number; commit: string }>, commits: ReadonlyMap<string, AttributedCommit>): AuthorshipRange[] {
    const out: AuthorshipRange[] = [];
    for (const r of [...runs].sort((a, b) => a.start - b.start)) {
        const c = commits.get(r.commit);
        if (!c || r.count <= 0) continue;
        const prev = out[out.length - 1];
        if (prev && prev.commit === r.commit && prev.end + 1 === r.start) prev.end += r.count;
        else out.push({ start: r.start, end: r.start + r.count - 1, origin: 'ai', agent: c.agent, confidence: 'declared', commit: r.commit });
    }
    return out;
}
