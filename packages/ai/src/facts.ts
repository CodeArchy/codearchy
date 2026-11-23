/**
 * The facts a card is written from, and the deterministic card that needs no
 * AI. Every fact list is capped, so a prompt's size depends on fan-out, never
 * on the size of the repository.
 *
 * Children and symbols are shown to the model as short refs (S1, C2); the
 * model cites those, and the citation guard maps them back to node keys.
 */
import type { HierarchyIndex } from '@codearchy/core';
import type { ComponentRole, HierarchyNode } from '@codearchy/protocol';
import type { Card, CardDraft } from './card.js';
import { fileDoc, signature, symbolDoc, tidy } from './docs.js';

export const ROLE_LABEL: Record<ComponentRole, string> = {
    api: 'API',
    ui: 'UI',
    domain: 'Domain logic',
    data: 'Data access',
    infra: 'Infrastructure',
    config: 'Configuration',
    test: 'Tests',
    util: 'Utilities',
};

const MAX_SYMBOLS = 30;
const MAX_CHILDREN = 30;
const MAX_LINKS = 25;
const MAX_NEIGHBOURS = 12;

export interface SymbolFact {
    ref: string;
    name: string;
    kind: string;
    exported: boolean;
    nested: boolean;
    signature?: string;
    doc?: string;
}

export interface ModuleFacts {
    level: 'module';
    path: string;
    language?: string;
    role?: string;
    doc?: string;
    flags: string[];
    symbols: SymbolFact[];
    /** Symbols not shown (beyond the cap). */
    moreSymbols: number;
    dependsOn: Array<{ name: string; weight: number }>;
    usedBy: Array<{ name: string; weight: number }>;
}

export interface ChildFact {
    ref: string;
    name: string;
    kind: string;
    modules: number;
    role?: string;
    title: string;
    purpose: string;
    responsibilities: string[];
    /** The child's card was written without AI. */
    deterministic: boolean;
}

export interface ContainerFacts {
    level: 'container';
    kind: string;
    name: string;
    path: string;
    modules: number;
    role?: string;
    doc?: string;
    risks: string[];
    children: ChildFact[];
    moreChildren: number;
    links: Array<{ from: string; to: string; weight: number }>;
    dependsOn: Array<{ name: string; weight: number }>;
    usedBy: Array<{ name: string; weight: number }>;
}

export type Facts = ModuleFacts | ContainerFacts;

export interface Prepared {
    facts: Facts;
    /** Ref → node key, for the citation guard. */
    refs: Map<string, string>;
    /** Ref → the part's name, to turn refs in the model's prose back into names. */
    labels: Map<string, string>;
    deterministic: CardDraft;
}

const roleText = (n: HierarchyNode) => (n.role ? `${ROLE_LABEL[n.role.role]} (${n.role.reason})` : undefined);

/** Module facts from the index and the file's text (undefined text: names and structure only). */
export function moduleFacts(index: HierarchyIndex, i: number, text: string | undefined): Prepared {
    const nodes = index.hierarchy.nodes;
    const node = nodes[i]!;
    const lines = text?.split('\n');
    const details = index.describe(node.key);
    const m = index.metrics.modules.get(i);

    const all: Array<{ n: HierarchyNode; nested: boolean }> = [];
    for (let j = node.tin + 1; j <= node.tout; j++) {
        const s = nodes[j]!;
        if (s.kind === 'symbol') all.push({ n: s, nested: s.depth > node.depth + 1 });
    }
    // Keep the most informative symbols: exported top-level, other top-level, then nested; shown in source order.
    const rank = (x: { n: HierarchyNode; nested: boolean }) => (x.nested ? 2 : 0) + (x.n.exported ? 0 : 1);
    const kept = new Set([...all].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_SYMBOLS).map((x) => x.n.key));
    const refs = new Map<string, string>();
    const symbols: SymbolFact[] = [];
    for (const { n, nested } of all) {
        if (!kept.has(n.key)) continue;
        const ref = `S${symbols.length + 1}`;
        refs.set(ref, n.key);
        symbols.push({
            ref,
            name: n.name,
            kind: n.symbolKind ?? 'symbol',
            exported: !!n.exported,
            nested,
            ...(lines && n.startLine !== undefined
                ? { signature: signature(lines, n.startLine, n.endLine ?? n.startLine), doc: symbolDoc(lines, n.startLine) }
                : {}),
        });
    }

    const flags: string[] = [];
    if (m?.test) flags.push('test file');
    if (m?.cyclic) flags.push('in a dependency cycle');
    if (m?.hub) flags.push('highly connected (hub)');
    if (m?.orphan) flags.push('no dependencies either way');
    if (m && !m.test && m.tested) flags.push('covered by tests');

    const neighbours = (links: Array<{ name: string; weight: number }> | undefined) =>
        [...(links ?? [])].sort((a, b) => b.weight - a.weight).slice(0, MAX_NEIGHBOURS).map((l) => ({ name: l.name, weight: l.weight }));

    const facts: ModuleFacts = {
        level: 'module',
        path: node.path,
        ...(node.language ? { language: node.language } : {}),
        ...(roleText(node) ? { role: roleText(node) } : {}),
        ...(text ? (fileDoc(text) ? { doc: fileDoc(text) } : {}) : {}),
        flags,
        symbols,
        moreSymbols: all.length - symbols.length,
        dependsOn: neighbours(details?.dependsOn),
        usedBy: neighbours(details?.usedBy),
    };

    // Deterministic card: the header doc if there is one, else what the file declares.
    const exported = symbols.filter((s) => s.exported && !s.nested);
    const shown = (exported.length ? exported : symbols.filter((s) => !s.nested)).slice(0, 4);
    const declares = shown.length ? `defining ${shown.map((s) => s.name).join(', ')}${all.length > shown.length ? ', …' : ''}` : 'with no top-level declarations';
    const label = node.role ? ROLE_LABEL[node.role.role] : 'A';
    // No header doc? The doc of the first documented top-level symbol often describes the file (Ruby, Python).
    const leadDoc = facts.doc ?? symbols.find((s) => !s.nested && s.doc)?.doc;
    const purpose = leadDoc ? firstSentence(leadDoc) : `${label === 'A' ? 'A' : `${label}:`} ${node.language ?? ''} module ${declares}.`.replace(/\s+/g, ' ');
    const risks: string[] = [];
    if (m?.cyclic) risks.push('Part of a dependency cycle');
    if (m?.hub) risks.push('Many modules depend on it or it on them (a hub)');
    return {
        facts,
        refs,
        labels: new Map(symbols.map((s) => [s.ref, s.name])),
        deterministic: {
            title: node.name,
            purpose,
            responsibilities: shown.slice(0, 3).map((s) => s.signature ?? `${s.kind} ${s.name}`),
            keyNodes: shown.slice(0, 3).map((s) => refs.get(s.ref)!),
            risks,
            confidence: facts.doc ? 0.35 : leadDoc ? 0.3 : 0.2,
        },
    };
}

/** Container facts from the children's cards, the view at this scope and an optional README/manifest description. */
export function containerFacts(index: HierarchyIndex, i: number, childCards: ReadonlyMap<string, Card>, doc: string | undefined): Prepared {
    const nodes = index.hierarchy.nodes;
    const node = nodes[i]!;
    const kids = index.childrenOf(i).map((c) => nodes[c]!);
    const ordered = [...kids].sort((a, b) => b.modules - a.modules || a.name.localeCompare(b.name, 'en'));
    const shownKids = ordered.slice(0, MAX_CHILDREN);
    const refs = new Map<string, string>();
    const refOf = new Map<string, string>();
    const children: ChildFact[] = shownKids.map((k, n) => {
        const ref = `C${n + 1}`;
        refs.set(ref, k.key);
        refOf.set(k.key, ref);
        const card = childCards.get(k.key);
        return {
            ref,
            name: k.name,
            kind: k.kind,
            modules: k.modules,
            ...(k.role ? { role: ROLE_LABEL[k.role.role] } : {}),
            title: card?.title ?? k.name,
            purpose: card?.purpose ?? '',
            responsibilities: (card?.responsibilities ?? []).slice(0, 3),
            deterministic: card?.source !== 'ai',
        };
    });

    const view = index.project({ scope: node.key, budget: 10_000 });
    const links = view.edges
        .filter((e) => refOf.has(e.source) && refOf.has(e.target))
        .sort((a, b) => b.weight - a.weight)
        .slice(0, MAX_LINKS)
        .map((e) => ({ from: refOf.get(e.source)!, to: refOf.get(e.target)!, weight: e.weight }));
    const outside = (direction: 'out' | 'in') => {
        const sum = new Map<string, number>();
        for (const p of view.ports) if (p.direction === direction) sum.set(p.externalName, (sum.get(p.externalName) ?? 0) + p.weight);
        return [...sum]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en'))
            .slice(0, MAX_NEIGHBOURS)
            .map(([name, weight]) => ({ name, weight }));
    };

    const metrics = index.metrics.nodes[i];
    const risks: string[] = [];
    if (metrics?.cyclicModules) risks.push(`${metrics.cyclicModules} module${metrics.cyclicModules === 1 ? ' is' : 's are'} in dependency cycles`);
    if (metrics && metrics.codeModules > 0 && metrics.testedModules === 0 && metrics.testModules === 0) risks.push('No tests cover it');

    const facts: ContainerFacts = {
        level: 'container',
        kind: node.kind,
        name: node.name,
        path: node.path,
        modules: node.modules,
        ...(roleText(node) ? { role: roleText(node) } : {}),
        ...(doc ? { doc } : {}),
        risks,
        children,
        moreChildren: kids.length - shownKids.length,
        links,
        dependsOn: outside('out'),
        usedBy: outside('in'),
    };

    const top = children.slice(0, 4);
    const label = node.role ? `${ROLE_LABEL[node.role.role]}: ` : '';
    return {
        facts,
        refs,
        labels: new Map(children.map((c) => [c.ref, c.name])),
        deterministic: {
            title: node.kind === 'system' ? node.name || 'System' : node.name,
            purpose: doc ? firstSentence(doc) : `${label}${top.map((c) => c.name).join(', ')}${kids.length > top.length ? ` and ${kids.length - top.length} more` : ''}.`,
            responsibilities: top
                .slice(0, 3)
                .filter((c) => c.purpose)
                .map((c) => tidy(`${c.name}: ${c.purpose}`, 140)),
            keyNodes: top.slice(0, 3).map((c) => refs.get(c.ref)!),
            risks,
            confidence: doc ? 0.3 : 0.15,
        },
    };
}

/** A README's first real paragraph, or a manifest's description. */
export function readmeSummary(text: string): string | undefined {
    const paragraphs = text.split(/\n[ \t]*\n/);
    for (const p of paragraphs.slice(0, 20)) {
        const t = p.trim();
        if (!t || t.startsWith('#') || t.startsWith('<') || t.startsWith('![') || t.startsWith('[![') || t.startsWith('```') || t.startsWith('|')) continue;
        if (t.startsWith('---')) continue;
        return tidy(t.replace(/\[([^\]]{1,200})\]\([^)]{1,500}\)/g, '$1').replace(/[*_`]/g, ''), 400);
    }
    return undefined;
}

/** `description` from package.json / composer.json, or a `description = "…"` line in pyproject.toml / Cargo.toml. */
export function manifestDescription(file: string, text: string): string | undefined {
    if (file.endsWith('.json')) {
        try {
            const d = (JSON.parse(text) as { description?: unknown }).description;
            return typeof d === 'string' && d.trim() ? tidy(d, 300) : undefined;
        } catch {
            return undefined;
        }
    }
    const m = /^description[ \t]{0,8}=[ \t]{0,8}["']([^"'\n]{1,300})["']/m.exec(text);
    return m ? tidy(m[1]!, 300) : undefined;
}

function firstSentence(text: string): string {
    const m = /^(.{20,280}?[.!?])(\s|$)/.exec(text);
    return m ? m[1]! : tidy(text, 280);
}
