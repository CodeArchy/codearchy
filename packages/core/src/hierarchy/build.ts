/**
 * Builds the architecture hierarchy from the file graph:
 *
 *   System   the workspace
 *   Package  directories holding a package marker (package.json, go.mod,
 *            Cargo.toml, pom.xml, *.csproj, ...); omitted when the only
 *            package is the workspace root. Many packages are grouped by
 *            their parent folder first (grp:packages, grp:apps, ...)
 *   Component directory subtrees, shaped for a 5–15 fan-out:
 *            · single-child folder chains are compressed (src/main/java/com/acme)
 *            · folders with fewer than 2 files are folded into their parent
 *            · containers with more than `maxChildren` children are split into
 *              virtual components by community detection on their dependencies;
 *              loose files are grouped first, so named folders stay visible
 *   Module   files
 *   Symbol   classes, functions, methods (nested under their container)
 *
 * Keys are derived from paths (and, for virtual components, from their
 * members), so they stay stable across re-indexes and machines. The output is
 * deterministic for a given graph, whatever order the analyses arrived in.
 */
import type { ArchitectureGraph, ComponentRole, Hierarchy, HierarchyEdge, HierarchyKind, HierarchyNode, RoleAssignment, SymbolInfo } from '@codearchy/protocol';
import { contentHash } from '../util/hash.js';
import { basename, dirname, isWithin, join } from '../util/posixPath.js';
import { detectCommunities, type WeightedEdge } from './cluster.js';
import { roleOfComponent, roleOfModule } from './roles.js';

export interface HierarchyOptions {
    /** Display name of the System node (the workspace folder name). */
    systemName: string;
    /** From discovery: files that mark package roots. */
    packageMarkers?: string[];
    /** Manifest contents (path → text), used for package names. */
    manifests?: Map<string, string>;
    /** Containers with more children than this are split into virtual components (default 20). */
    maxChildren?: number;
}

/** Most virtual components one split produces (the rest share an "other" group). */
const MAX_GROUPS = 15;
/** Size of the alphabetical fallback groups' count target. */
const FALLBACK_GROUPS = 12;

interface Draft {
    key: string;
    kind: HierarchyKind;
    name: string;
    path: string;
    children: Draft[];
    role?: RoleAssignment;
    virtual?: boolean;
    language?: string;
    symbol?: SymbolInfo;
    /** Module files in the subtree (memoised). */
    files?: string[];
}

export function buildHierarchy(graph: ArchitectureGraph, options: HierarchyOptions): Hierarchy {
    const maxChildren = options.maxChildren ?? 20;
    const files = [...graph.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const adjacency = undirectedWeights(graph);

    // ── packages ────────────────────────────────────────────────────────────
    const roots = [...new Set((options.packageMarkers ?? []).map(dirname))].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
    const filesByRoot = new Map<string, typeof files>();
    for (const f of files) {
        const root = roots.find((r) => isWithin(f.id, r)) ?? '';
        const list = filesByRoot.get(root) ?? [];
        list.push(f);
        filesByRoot.set(root, list);
    }

    const moduleDraft = (f: (typeof files)[number]): Draft => ({
        key: `mod:${f.id}`,
        kind: 'module',
        name: basename(f.id),
        path: f.id,
        children: symbolDrafts(f.id, f.symbols),
        role: roleOfModule(f.id),
        language: typeof f.metadata.language === 'string' ? f.metadata.language : undefined,
        files: [f.id],
    });

    /** Components and modules for the files under `dirPath` (paths relative to `base`). */
    const itemsFor = (list: typeof files, base: string, parentKey: string): Draft[] => {
        const tree = newDir();
        for (const f of list) {
            const rel = base ? f.id.slice(base.length + 1) : f.id;
            const segments = rel.split('/');
            let d = tree;
            for (const seg of segments.slice(0, -1)) {
                let next = d.dirs.get(seg);
                if (!next) d.dirs.set(seg, (next = newDir()));
                d = next;
            }
            d.files.push(f);
        }
        const walk = (dir: Dir, dirPath: string): Draft[] => {
            const items: Draft[] = [];
            for (const name of [...dir.dirs.keys()].sort(byName)) {
                let d = dir.dirs.get(name)!;
                let label = name;
                let path = join(dirPath, name) ?? name;
                // Compress chains: a folder with no files and one sub-folder is merged into it.
                while (d.files.length === 0 && d.dirs.size === 1) {
                    const [childName, child] = [...d.dirs][0];
                    label = `${label}/${childName}`;
                    path = `${path}/${childName}`;
                    d = child;
                }
                const key = `dir:${path}`;
                const children = walk(d, path);
                if (countFiles(children) < 2) {
                    items.push(...children); // fold tiny folders into their parent
                } else {
                    items.push({ key, kind: 'component', name: label, path, children: shape(children, key) });
                }
            }
            for (const f of [...dir.files].sort((a, b) => byName(basename(a.id), basename(b.id)))) items.push(moduleDraft(f));
            return items;
        };
        return shape(walk(tree, base), parentKey);
    };

    /** Splits a container's children into virtual components when there are too many. */
    const shape = (items: Draft[], parentKey: string): Draft[] => {
        if (items.length <= maxChildren) return items;
        // Named folders are the authors' own structure: group the loose files
        // first, and cluster folders only when they alone are too many.
        const folders = items.filter((i) => i.kind !== 'module');
        const files = items.filter((i) => i.kind === 'module');
        if (files.length > 0 && folders.length < maxChildren) {
            return [...folders, ...splitWide(files, parentKey, adjacency, maxChildren, maxChildren - folders.length)];
        }
        return splitWide(items, parentKey, adjacency, maxChildren);
    };

    const usedRoots = [...filesByRoot.keys()].sort(byName);
    let systemChildren: Draft[];
    if (usedRoots.length === 1 && usedRoots[0] === '') {
        systemChildren = itemsFor(filesByRoot.get('')!, '', 'sys:root');
    } else {
        const names = new Map(usedRoots.map((r) => [r, packageName(r, options)]));
        const counts = new Map<string, number>();
        for (const n of names.values()) counts.set(n, (counts.get(n) ?? 0) + 1);
        const packages: Draft[] = usedRoots.map((root) => {
            const key = `pkg:${root || '.'}`;
            const name = names.get(root)!;
            return {
                key,
                kind: 'package' as const,
                name: counts.get(name)! > 1 ? `${name} (${root || '.'})` : name,
                path: root,
                children: itemsFor(filesByRoot.get(root)!, root, key),
            };
        });
        systemChildren = shape(packages.length > maxChildren ? groupPackagesByFolder(packages, shape) : packages, 'sys:root');
    }
    const system: Draft = { key: 'sys:root', kind: 'system', name: options.systemName, path: '', children: systemChildren };
    assignRoles(system);

    // ── flatten in DFS pre-order (Euler tour) ───────────────────────────────
    const nodes: HierarchyNode[] = [];
    const indexOfModule = new Map<string, number>();
    const emit = (d: Draft, parent: number, depth: number): void => {
        const index = nodes.length;
        const node: HierarchyNode = { key: d.key, kind: d.kind, parent, name: d.name, path: d.path, tin: index, tout: index, depth, modules: countFiles([d]) };
        if (d.role) node.role = d.role;
        if (d.virtual) node.virtual = true;
        if (d.language) node.language = d.language;
        if (d.symbol) {
            node.symbolKind = d.symbol.kind;
            node.exported = d.symbol.exported;
            node.startLine = d.symbol.startLine;
            node.endLine = d.symbol.endLine;
        }
        nodes.push(node);
        if (d.kind === 'module') indexOfModule.set(d.path, index);
        for (const child of orderChildren(d.children)) emit(child, index, depth + 1);
        node.tout = nodes.length - 1;
    };
    emit(system, -1, 0);

    // ── base edges between modules ──────────────────────────────────────────
    const edges: HierarchyEdge[] = [];
    for (const e of graph.edges) {
        const src = indexOfModule.get(e.source);
        const dst = indexOfModule.get(e.target);
        if (src === undefined || dst === undefined || src === dst) continue;
        const evidence = Array.isArray(e.metadata.evidence)
            ? (e.metadata.evidence as Array<{ source: string; line?: number }>)
            : [{ source: String(e.metadata.importSource ?? '') }];
        edges.push({ src, dst, weight: e.weight, evidence, ...(e.metadata.implicit ? { implicit: true } : {}) });
    }
    edges.sort((a, b) => a.src - b.src || a.dst - b.dst);
    return { nodes, edges };
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Monorepos: packages sharing a parent folder (packages/*, apps/*, sample/*)
 * become one group component (`grp:<folder>`), the grouping the authors chose.
 */
function groupPackagesByFolder(packages: Draft[], shape: (items: Draft[], parentKey: string) => Draft[]): Draft[] {
    const byFolder = new Map<string, Draft[]>();
    for (const p of packages) {
        const folder = p.path ? dirname(p.path) : '';
        const list = byFolder.get(folder) ?? [];
        list.push(p);
        byFolder.set(folder, list);
    }
    const out: Draft[] = [];
    for (const [folder, members] of byFolder) {
        if (folder === '' || members.length < 2) {
            out.push(...members);
            continue;
        }
        const key = `grp:${folder}`;
        out.push({ key, kind: 'component', name: folder, path: folder, children: shape(members, key) });
    }
    return out;
}

interface Dir {
    dirs: Map<string, Dir>;
    files: ArchitectureGraph['nodes'];
}

const newDir = (): Dir => ({ dirs: new Map(), files: [] });

/** Case-insensitive, then exact: a stable order for names. */
function byName(a: string, b: string): number {
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : a < b ? -1 : a > b ? 1 : 0;
}

const KIND_ORDER: Record<HierarchyKind, number> = { system: 0, package: 1, component: 1, module: 2, symbol: 3 };

/** Packages and components together (A–Z), then modules (A–Z), then symbols in source order. */
function orderChildren(children: Draft[]): Draft[] {
    return [...children].sort((a, b) => {
        const k = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
        if (k !== 0) return k;
        if (a.kind === 'symbol') return a.symbol!.startLine - b.symbol!.startLine || byName(a.name, b.name);
        return byName(a.name, b.name);
    });
}

function countFiles(drafts: Draft[]): number {
    let n = 0;
    for (const d of drafts) n += filesOf(d).length;
    return n;
}

function filesOf(d: Draft): string[] {
    if (!d.files) d.files = d.children.flatMap(filesOf);
    return d.files;
}

/** Undirected weights between files (both directions summed). */
function undirectedWeights(graph: ArchitectureGraph): Map<string, Map<string, number>> {
    const adj = new Map<string, Map<string, number>>();
    const add = (a: string, b: string, w: number) => {
        let m = adj.get(a);
        if (!m) adj.set(a, (m = new Map()));
        m.set(b, (m.get(b) ?? 0) + w);
    };
    for (const e of graph.edges) {
        if (e.source === e.target) continue;
        add(e.source, e.target, e.weight);
        add(e.target, e.source, e.weight);
    }
    return adj;
}

/**
 * Groups `items` into at most `slots` children (default MAX_GROUPS):
 * communities of the dependency graph between them become virtual
 * components; when the graph gives no useful split (no edges, or one big
 * community) the items are grouped alphabetically instead.
 */
function splitWide(items: Draft[], parentKey: string, adjacency: Map<string, Map<string, number>>, maxChildren: number, slots = Math.min(MAX_GROUPS, maxChildren)): Draft[] {
    const owner = new Map<string, number>();
    items.forEach((item, i) => {
        for (const f of filesOf(item)) owner.set(f, i);
    });
    const weights = new Map<string, number>();
    const degree = new Array<number>(items.length).fill(0);
    items.forEach((item, i) => {
        for (const f of filesOf(item)) {
            for (const [g, w] of adjacency.get(f) ?? []) {
                const j = owner.get(g);
                if (j === undefined || j <= i) continue;
                const key = `${i}:${j}`;
                weights.set(key, (weights.get(key) ?? 0) + w);
                degree[i] += w;
                degree[j] += w;
            }
        }
    });
    const edges: WeightedEdge[] = [...weights].map(([k, w]) => {
        const [a, b] = k.split(':').map(Number);
        return [a, b, w];
    });
    const membership = detectCommunities(items.length, edges);

    const groups: number[][] = [];
    membership.forEach((c, i) => (groups[c] ??= []).push(i));
    // No usable structure (no edges, or everything in one community): alphabetical.
    if (groups.length <= 1 || groups.every((g) => g.length === 1)) return alphabetical(items, parentKey, maxChildren, Math.min(FALLBACK_GROUPS, slots));

    // Largest communities first; past the cap, the remainder (mostly loosely
    // connected files) shares one "Other" group rather than a misleading name.
    groups.sort((a, b) => b.length - a.length || a[0] - b[0]);
    const cap = Math.max(1, Math.min(MAX_GROUPS, slots));
    const kept = groups.length > cap ? groups.slice(0, cap - 1) : groups;
    const rest = groups.length > cap ? groups.slice(cap - 1).flat().sort((a, b) => a - b) : [];

    const out: Draft[] = kept.map((g) => {
        if (g.length === 1) return items[g[0]];
        const members = g.map((i) => items[i]);
        const hub = g.reduce((best, i) => (degree[i] > degree[best] || (degree[i] === degree[best] && byName(items[i].name, items[best].name) < 0) ? i : best), g[0]);
        const key = clusterKey(parentKey, members);
        const children = members.length > maxChildren ? splitWide(members, key, adjacency, maxChildren) : members;
        return { key, kind: 'component' as const, name: `${items[hub].name} & ${members.length - 1} more`, path: commonDir(members), children, virtual: true };
    });
    if (rest.length > 0) {
        const members = rest.map((i) => items[i]);
        const key = clusterKey(parentKey, members);
        const children = members.length > maxChildren ? alphabetical(members, key, maxChildren) : members;
        const onlyFiles = members.every((m) => m.kind === 'module');
        const name = onlyFiles ? `${members.length} ${kept.length ? 'other ' : ''}files` : `Other (${members.length})`;
        out.push({ key, kind: 'component', name, path: commonDir(members), children, virtual: true });
    }
    return out;
}

function alphabetical(items: Draft[], parentKey: string, maxChildren: number, slots = FALLBACK_GROUPS): Draft[] {
    const sorted = [...items].sort((a, b) => byName(a.name, b.name));
    const size = Math.max(2, Math.ceil(sorted.length / Math.max(1, slots)));
    const out: Draft[] = [];
    for (let i = 0; i < sorted.length; i += size) {
        const members = sorted.slice(i, i + size);
        if (members.length === 1) {
            out.push(members[0]);
            continue;
        }
        const key = clusterKey(parentKey, members);
        const children = members.length > maxChildren ? alphabetical(members, key, maxChildren) : members;
        out.push({ key, kind: 'component', name: `${members[0].name} … ${members[members.length - 1].name}`, path: commonDir(members), children, virtual: true });
    }
    return out;
}

/** `cl:<parent>:<hash of the first five member keys>`: stable while the group's leading members are. */
function clusterKey(parentKey: string, members: Draft[]): string {
    const keys = members.map((m) => m.key).sort();
    return `cl:${parentKey}:${contentHash(keys.slice(0, 5).join('|'))}`;
}

function commonDir(members: Draft[]): string {
    const dirs = members.map((m) => (m.kind === 'module' ? dirname(m.path) : m.path));
    let prefix = dirs[0];
    for (const d of dirs) while (prefix && !isWithin(d, prefix)) prefix = dirname(prefix);
    return prefix;
}

function symbolDrafts(path: string, symbols: SymbolInfo[]): Draft[] {
    const ordered = [...symbols].sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine || byName(a.name, b.name));
    const top: Draft[] = [];
    const byName_ = new Map<string, Draft>();
    const qualified = new Map<Draft, string>();
    const used = new Map<string, number>();
    for (const s of ordered) {
        const parent = s.container ? byName_.get(s.container) : undefined;
        const name = s.container && !parent ? `${s.container}.${s.name}` : s.name;
        const q = parent ? `${qualified.get(parent)}.${s.name}` : name;
        const n = (used.get(q) ?? 0) + 1;
        used.set(q, n);
        const draft: Draft = { key: `sym:${path}#${q}${n > 1 ? `~${n}` : ''}`, kind: 'symbol', name, path, children: [], symbol: s, files: [] };
        qualified.set(draft, q);
        if (!byName_.has(s.name)) byName_.set(s.name, draft);
        (parent ? parent.children : top).push(draft);
    }
    return top;
}

function assignRoles(d: Draft): ComponentRole | undefined {
    if (d.kind === 'symbol') return undefined;
    if (d.kind === 'module') return d.role?.role;
    const memberRoles: Array<ComponentRole | undefined> = [];
    const collect = (x: Draft) => {
        // Only a file's own evidence counts (its name, or a test path): a role it
        // inherited from a folder above would just echo that folder.
        if (x.kind === 'module') memberRoles.push(x.role && x.role.confidence >= 0.8 ? x.role.role : undefined);
        else if (x.kind !== 'symbol') x.children.forEach(collect);
    };
    for (const c of d.children) {
        assignRoles(c);
        collect(c);
    }
    if (d.kind === 'component' || d.kind === 'package') {
        const own = d.virtual ? '' : d.kind === 'package' ? basename(d.path) : d.name;
        const role = roleOfComponent(own, memberRoles);
        if (role) d.role = role;
    }
    return d.role?.role;
}

/** Package display name from its manifest, else its folder name. */
function packageName(root: string, options: HierarchyOptions): string {
    const read = (file: string) => options.manifests?.get(root ? `${root}/${file}` : file);
    const pkgJson = read('package.json') ?? read('composer.json');
    if (pkgJson) {
        try {
            const name = (JSON.parse(pkgJson) as { name?: unknown }).name;
            if (typeof name === 'string' && name.trim()) return name.trim();
        } catch {
            // not JSON: fall through
        }
    }
    const goMod = read('go.mod');
    if (goMod) {
        for (const line of goMod.split('\n')) {
            const t = line.trim();
            if (t.startsWith('module ')) return basename(t.slice(7).trim());
        }
    }
    const cargo = read('Cargo.toml');
    if (cargo) {
        let section = '';
        for (const line of cargo.split('\n')) {
            const t = line.trim();
            if (t.startsWith('[')) section = t;
            else if (section === '[package]' && t.startsWith('name')) {
                const eq = t.indexOf('=');
                const value = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
                if (eq > 0 && value) return value;
            }
        }
    }
    return root ? basename(root) : options.systemName;
}
