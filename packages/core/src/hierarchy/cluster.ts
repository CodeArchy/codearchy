/**
 * Community detection for splitting wide directories into virtual components.
 *
 * Louvain modularity optimisation (local moving + aggregation) with the
 * Leiden refinement guarantee that matters here: every community is
 * connected (a community that falls apart is split into its connected
 * pieces before aggregating). Fully deterministic: nodes are visited in
 * index order and ties go to the lowest community id, so the same graph
 * always yields the same partition on every platform.
 */

/** Undirected weighted edge between node indexes. */
export type WeightedEdge = [a: number, b: number, weight: number];

/** Community id per node (0..k-1, numbered by first member), maximising modularity. */
export function detectCommunities(n: number, edges: WeightedEdge[], maxLevels = 10): number[] {
    let membership = Array.from({ length: n }, (_, i) => i);
    let graph = toAdjacency(n, edges);
    for (let level = 0; level < maxLevels; level++) {
        const local = refineConnected(graph, moveNodes(graph));
        const count = Math.max(-1, ...local) + 1;
        if (count === graph.n) break; // no merge happened: converged
        membership = membership.map((c) => local[c]);
        graph = aggregate(graph, local, count);
    }
    return renumber(membership);
}

interface Adjacency {
    n: number;
    /** Neighbour → weight, per node (self loops allowed after aggregation). */
    adj: Array<Map<number, number>>;
    /** Weighted degree (self loops count twice). */
    degree: number[];
    /** Sum of all degrees (2m). */
    total: number;
}

function toAdjacency(n: number, edges: WeightedEdge[]): Adjacency {
    const adj = Array.from({ length: n }, () => new Map<number, number>());
    for (const [a, b, w] of edges) {
        if (a === b || w <= 0) continue;
        adj[a].set(b, (adj[a].get(b) ?? 0) + w);
        adj[b].set(a, (adj[b].get(a) ?? 0) + w);
    }
    return withDegrees(n, adj);
}

function withDegrees(n: number, adj: Array<Map<number, number>>): Adjacency {
    const degree = adj.map((m, i) => {
        let d = 0;
        for (const [j, w] of m) d += j === i ? 2 * w : w;
        return d;
    });
    return { n, adj, degree, total: degree.reduce((s, d) => s + d, 0) };
}

/** Louvain local moving phase. */
function moveNodes(g: Adjacency): number[] {
    const community = Array.from({ length: g.n }, (_, i) => i);
    if (g.total === 0) return community;
    const tot = [...g.degree];
    for (let pass = 0; pass < 50; pass++) {
        let moved = false;
        for (let i = 0; i < g.n; i++) {
            const own = community[i];
            const ki = g.degree[i];
            const links = new Map<number, number>();
            for (const [j, w] of g.adj[i]) {
                if (j === i) continue;
                links.set(community[j], (links.get(community[j]) ?? 0) + w);
            }
            tot[own] -= ki;
            const gain = (c: number) => (links.get(c) ?? 0) - (tot[c] * ki) / g.total;
            let best = own;
            let bestGain = gain(own);
            for (const c of [...links.keys()].sort((a, b) => a - b)) {
                const value = gain(c);
                if (value > bestGain + 1e-12) {
                    best = c;
                    bestGain = value;
                }
            }
            tot[best] += ki;
            if (best !== own) {
                community[i] = best;
                moved = true;
            }
        }
        if (!moved) break;
    }
    return renumber(community);
}

/** Splits communities that aren't connected into their connected pieces. */
function refineConnected(g: Adjacency, community: number[]): number[] {
    const out = new Array<number>(g.n).fill(-1);
    let next = 0;
    for (let start = 0; start < g.n; start++) {
        if (out[start] !== -1) continue;
        const id = next++;
        out[start] = id;
        const queue = [start];
        while (queue.length) {
            const v = queue.pop()!;
            for (const u of g.adj[v].keys()) {
                if (out[u] === -1 && community[u] === community[start]) {
                    out[u] = id;
                    queue.push(u);
                }
            }
        }
    }
    return out;
}

function aggregate(g: Adjacency, community: number[], count: number): Adjacency {
    const adj = Array.from({ length: count }, () => new Map<number, number>());
    for (let i = 0; i < g.n; i++) {
        for (const [j, w] of g.adj[i]) {
            if (j < i) continue; // each undirected edge once
            const a = community[i];
            const b = community[j];
            if (a === b) {
                adj[a].set(a, (adj[a].get(a) ?? 0) + w);
            } else {
                adj[a].set(b, (adj[a].get(b) ?? 0) + w);
                adj[b].set(a, (adj[b].get(a) ?? 0) + w);
            }
        }
    }
    return withDegrees(count, adj);
}

/** Renumbers ids 0..k-1 in order of first appearance. */
function renumber(ids: number[]): number[] {
    const map = new Map<number, number>();
    return ids.map((c) => {
        let r = map.get(c);
        if (r === undefined) {
            r = map.size;
            map.set(c, r);
        }
        return r;
    });
}
