/**
 * The citation check for chat answers. Answers cite with markdown links:
 *
 *   [AuthService](node:dir:src/auth)        a node of the map
 *   [login.ts:42](file:src/auth/login.ts#L42)   a file, optionally a line or L10-L20
 *
 * Links to nodes or files that don't exist in the index are turned into plain
 * text, so the UI never offers a link the model made up.
 */
import type { HierarchyIndex } from '@codearchy/core';

export type Citation =
    | { type: 'node'; key: string; label: string }
    | { type: 'file'; path: string; label: string; startLine?: number; endLine?: number };

/** `[label](node:…)` or `[label](file:…)`; labels and targets are bounded so the scan stays linear. */
const LINK = /\[([^\]\n]{1,200})\]\((node|file):([^)\s]{1,500})\)/g;

/** A link with no scheme, e.g. `[x](src/a.ts#L3)`: a file link when the path is indexed. */
const BARE_LINK = /\[([^\]\n]{1,200})\]\(([^)\s:]{1,500})\)/g;

/** `` `name` `` outside links, bounded. */
const CODE_SPAN = /(^|[^\[`])`([^`\n]{1,120})`/g;

/**
 * Checks the answer's links, turning unknown ones into plain text. Then links
 * inline-code names that match exactly one file (by name or path) or symbol in
 * the index, since smaller models often name things without linking them.
 */
export function checkCitations(
    answer: string,
    index: HierarchyIndex,
): { answer: string; citations: Citation[]; invalid: number; autoLinked: number } {
    const citations: Citation[] = [];
    const modules = new Set<string>();
    const byName = new Map<string, string | null>(); // name → key, or null when ambiguous
    const note = (name: string, key: string) => byName.set(name, byName.has(name) && byName.get(name) !== key ? null : key);
    for (const n of index.hierarchy.nodes) {
        if (n.kind === 'module') {
            modules.add(n.path);
            note(n.name, n.key);
            note(n.path, n.key);
        } else if (n.kind === 'symbol') {
            note(n.name, n.key);
            note(`${n.name}()`, n.key);
        }
    }
    let invalid = 0;
    let autoLinked = 0;
    const seen = new Set<string>();
    const schemed = answer.replace(BARE_LINK, (whole, label: string, target: string) => {
        const hash = target.indexOf('#');
        return modules.has(hash >= 0 ? target.slice(0, hash) : target) ? `[${label}](file:${target})` : whole;
    });
    const linked = schemed.replace(CODE_SPAN, (whole, before: string, name: string) => {
        const key = byName.get(name.trim());
        if (!key) return whole;
        autoLinked++;
        return `${before}[\`${name}\`](node:${key})`;
    });
    const out = linked.replace(LINK, (whole, label: string, scheme: string, target: string) => {
        if (scheme === 'node') {
            if (!index.node(target)) {
                invalid++;
                return label;
            }
            if (!seen.has(`n:${target}`)) citations.push({ type: 'node', key: target, label });
            seen.add(`n:${target}`);
            return whole;
        }
        const hash = target.indexOf('#');
        const path = hash >= 0 ? target.slice(0, hash) : target;
        const lines = hash >= 0 ? /^L(\d{1,7})(?:-L?(\d{1,7}))?$/.exec(target.slice(hash + 1)) : null;
        if (!modules.has(path) || (hash >= 0 && !lines)) {
            invalid++;
            return label;
        }
        const startLine = lines ? Number(lines[1]) : undefined;
        const endLine = lines?.[2] ? Number(lines[2]) : undefined;
        const id = `f:${path}:${startLine ?? ''}:${endLine ?? ''}`;
        if (!seen.has(id)) citations.push({ type: 'file', path, label, ...(startLine ? { startLine } : {}), ...(endLine ? { endLine } : {}) });
        seen.add(id);
        return whole;
    });
    return { answer: out, citations, invalid, autoLinked };
}
