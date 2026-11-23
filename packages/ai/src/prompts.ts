/**
 * Versioned prompts. Changing a prompt's wording means bumping its version:
 * the version is part of every card's cache key, so old cards are replaced.
 *
 * System prompts are fixed text (no dates, no ids), so providers with prompt
 * caching reuse them across the thousands of calls a crawl makes.
 */
import type { ContainerFacts, Facts, ModuleFacts } from './facts.js';

export const PROMPT_VERSION = { module: 'module.v1', container: 'container.v1' } as const;

const RULES = `Rules:
- Use only the facts given. Do not guess at behaviour the facts don't show.
- Cite parts only with the refs given (for example "S2" or "C1"), exactly as written.
- Name risks only when the facts show them (cycles, hubs, missing tests, very wide parts).
- Lower "confidence" when the facts are thin (few docs, generic names).
- Plain, specific language for an engineer new to the codebase. No marketing words.
- Reply with the JSON object only.`;

export const MODULE_SYSTEM = `You write short summary cards for source files in a software architecture map.
You are given one file's facts: its path, role, header doc, declared symbols (with signatures and doc comments) and the files it depends on and that depend on it. You never see the code bodies.

Return JSON with:
- "title": a short descriptive name for the file's purpose (at most 6 words)
- "purpose": one or two sentences on what the file is for
- "responsibilities": up to 5 short phrases
- "keyNodes": up to 5 refs of the most important symbols
- "risks": up to 3, only if the facts show them
- "confidence": 0 to 1

${RULES}`;

export const CONTAINER_SYSTEM = `You write short summary cards for the parts of a software system in an architecture map: the system itself, its packages and its components.
You are given one part's facts: its name, path and role, a README or manifest description if there is one, its child parts (each with its own summary), the dependencies between those children, and what it depends on and is used by outside.

Return JSON with:
- "title": a short descriptive name (at most 6 words)
- "purpose": one or two sentences on what this part is for, and how its children work together
- "responsibilities": up to 5 short phrases
- "keyNodes": up to 5 refs of the most important children
- "risks": up to 3, only if the facts show them
- "confidence": 0 to 1

${RULES}`;

export function systemPrompt(facts: Facts): string {
    return facts.level === 'module' ? MODULE_SYSTEM : CONTAINER_SYSTEM;
}

export function promptVersion(facts: Facts): string {
    return facts.level === 'module' ? PROMPT_VERSION.module : PROMPT_VERSION.container;
}

/** Output caps: a card is small. */
export function maxOutput(facts: Facts): number {
    return facts.level === 'module' ? 500 : 700;
}

/** The facts as compact, readable text. */
export function renderFacts(facts: Facts): string {
    return facts.level === 'module' ? renderModule(facts) : renderContainer(facts);
}

const neighbours = (title: string, list: Array<{ name: string; weight: number }>) =>
    list.length ? [`${title}: ${list.map((l) => `${l.name} (${l.weight})`).join(', ')}`] : [];

function renderModule(f: ModuleFacts): string {
    const out = [`File: ${f.path}`];
    if (f.language) out.push(`Language: ${f.language}`);
    if (f.role) out.push(`Role: ${f.role}`);
    if (f.flags.length) out.push(`Notes: ${f.flags.join('; ')}`);
    if (f.doc) out.push(`Header doc: ${f.doc}`);
    if (f.symbols.length) {
        out.push('Symbols:');
        for (const s of f.symbols) {
            const head = `${s.nested ? '    ' : '  '}${s.ref} ${s.exported ? 'exported ' : ''}${s.kind} ${s.name}`;
            const sig = s.signature && s.signature !== s.name ? ` — \`${s.signature}\`` : '';
            out.push(`${head}${sig}${s.doc ? `\n${s.nested ? '      ' : '    '}doc: ${s.doc}` : ''}`);
        }
        if (f.moreSymbols) out.push(`  (+${f.moreSymbols} more symbols)`);
    } else {
        out.push('Symbols: none found');
    }
    out.push(...neighbours('Depends on', f.dependsOn), ...neighbours('Used by', f.usedBy));
    return out.join('\n');
}

function renderContainer(f: ContainerFacts): string {
    const out = [`${capitalise(f.kind)}: ${f.name || '(root)'}${f.path ? ` at ${f.path}` : ''} — ${f.modules} files`];
    if (f.role) out.push(`Role: ${f.role}`);
    if (f.doc) out.push(`Description: ${f.doc}`);
    if (f.risks.length) out.push(`Notes: ${f.risks.join('; ')}`);
    out.push('Children:');
    for (const c of f.children) {
        out.push(`  ${c.ref} ${c.kind} ${c.name} (${c.modules} files${c.role ? `, ${c.role}` : ''})${c.title !== c.name ? ` — ${c.title}` : ''}`);
        if (c.purpose) out.push(`      ${c.deterministic ? 'auto-summary' : 'summary'}: ${c.purpose}`);
        if (c.responsibilities.length) out.push(`      does: ${c.responsibilities.join('; ')}`);
    }
    if (f.moreChildren) out.push(`  (+${f.moreChildren} smaller children)`);
    if (f.links.length) out.push(`Dependencies between children (weight): ${f.links.map((l) => `${l.from}→${l.to} (${l.weight})`).join(', ')}`);
    out.push(...neighbours('Depends on outside', f.dependsOn), ...neighbours('Used from outside', f.usedBy));
    return out.join('\n');
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
