/**
 * Which commits an AI tool made or co-authored, from the evidence AI tools
 * leave in commit metadata (doc 07 §3, source 4, confidence "declared"):
 *
 *   - `Co-authored-by:` trailers naming an AI tool (by its account or email),
 *   - bot authors of coding agents (`…[bot]` accounts),
 *   - tool-added message markers ("Generated with Claude Code", Aider's `aider:` prefix).
 *
 * Cautious by design: names that are also people's names (Claude, Devin,
 * Jules) only count with the vendor's email or a bot account, so a colleague
 * called Claude is never mistaken for an AI. No regular expressions: commit
 * messages are untrusted input.
 */

export interface CommitInfo {
    hash: string;
    /** Commit time, ms since the epoch. */
    time: number;
    authorName: string;
    authorEmail: string;
    /** The full message. */
    message: string;
}

export interface CommitAttribution {
    agent: string;
    /** Human-readable: which marker matched. */
    evidence: string;
}

/** A rule an organisation can add (e.g. an in-house agent's co-author line). */
export interface AuthorshipRule {
    agent: string;
    /** Matched case-insensitively against co-author trailers, the author and the message. */
    contains: string;
}

interface Agent {
    id: string;
    /** Distinct tool names: matched as words in a co-author's or bot's name. */
    names: string[];
    /** Email domains only the tool uses (vendor no-reply addresses). */
    domains?: string[];
    /** The name is also a person's name: require the vendor domain or a bot account. */
    ambiguous?: boolean;
}

const AGENTS: Agent[] = [
    { id: 'claude-code', names: ['claude'], domains: ['anthropic.com'], ambiguous: true },
    { id: 'copilot', names: ['copilot', 'copilot-swe-agent'] },
    { id: 'cursor', names: ['cursor agent', 'cursoragent', 'cursor'], domains: ['cursor.com', 'cursor.sh'] },
    { id: 'codex', names: ['codex', 'chatgpt-codex-connector'] },
    { id: 'gemini-cli', names: ['gemini', 'gemini-code-assist', 'gemini cli'] },
    { id: 'aider', names: ['aider'], domains: ['aider.chat'] },
    { id: 'devin', names: ['devin', 'devin-ai-integration'], ambiguous: true },
    { id: 'jules', names: ['jules', 'google-labs-jules'], ambiguous: true },
    { id: 'windsurf', names: ['windsurf', 'cascade'], domains: ['windsurf.com', 'codeium.com'] },
    { id: 'openhands', names: ['openhands', 'openhands-agent'], domains: ['all-hands.dev'] },
    { id: 'amazon-q', names: ['amazon q', 'amazon-q-developer'] },
    { id: 'cline', names: ['cline'], domains: ['cline.bot'] },
];

/** `Name <email>` → its parts. */
function person(text: string): { name: string; email: string } {
    const lt = text.indexOf('<');
    const gt = text.indexOf('>', lt + 1);
    if (lt < 0 || gt < 0) return { name: text.trim().toLowerCase(), email: '' };
    return { name: text.slice(0, lt).trim().toLowerCase(), email: text.slice(lt + 1, gt).trim().toLowerCase() };
}

const isBot = (p: { name: string; email: string }) => p.name.includes('[bot]') || p.email.includes('[bot]');

/** `name` contains `word` as a whole word (or the whole name). */
function hasWord(name: string, word: string): boolean {
    let at = name.indexOf(word);
    while (at >= 0) {
        const before = at === 0 ? ' ' : name[at - 1]!;
        const after = at + word.length >= name.length ? ' ' : name[at + word.length]!;
        const boundary = (c: string) => !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'));
        if (boundary(before) && boundary(after)) return true;
        at = name.indexOf(word, at + 1);
    }
    return false;
}

function agentOf(p: { name: string; email: string }): Agent | undefined {
    const domain = p.email.slice(p.email.lastIndexOf('@') + 1);
    for (const a of AGENTS) {
        const byDomain = !!a.domains?.some((d) => domain === d || domain.endsWith(`.${d}`));
        const byName = a.names.some((n) => hasWord(p.name, n) || hasWord(p.email.split('@')[0] ?? '', n));
        if (byDomain && (byName || !a.ambiguous)) return a;
        if (byName && (isBot(p) || !a.ambiguous)) return a;
    }
    return undefined;
}

/** The AI tool behind a commit, if its metadata says so. */
export function classifyCommit(c: Pick<CommitInfo, 'authorName' | 'authorEmail' | 'message'>, rules: AuthorshipRule[] = []): CommitAttribution | undefined {
    const lines = c.message.split('\n');
    // 1. Co-author trailers.
    for (const raw of lines) {
        const line = raw.trim();
        if (!line.toLowerCase().startsWith('co-authored-by:')) continue;
        const p = person(line.slice('co-authored-by:'.length));
        const a = agentOf(p);
        if (a) return { agent: a.id, evidence: `Co-authored-by: ${line.slice('co-authored-by:'.length).trim().slice(0, 80)}` };
        for (const r of rules) if (r.contains && line.toLowerCase().includes(r.contains.toLowerCase())) return { agent: r.agent, evidence: `Co-authored-by matches "${r.contains}"` };
    }
    // 2. A coding agent's bot account as the author.
    const author = { name: c.authorName.toLowerCase(), email: c.authorEmail.toLowerCase() };
    if (isBot(author)) {
        const a = agentOf(author);
        if (a) return { agent: a.id, evidence: `authored by ${c.authorName.slice(0, 60)}` };
    }
    // 3. Markers tools add to the message.
    const lower = c.message.toLowerCase();
    if (lower.includes('generated with [claude code]') || lower.includes('generated with claude code')) return { agent: 'claude-code', evidence: '"Generated with Claude Code" in the message' };
    if (lower.startsWith('aider: ')) return { agent: 'aider', evidence: 'Aider\'s "aider:" commit prefix' };
    for (const r of rules) {
        const needle = r.contains.toLowerCase();
        if (needle && (lower.includes(needle) || author.name.includes(needle) || author.email.includes(needle))) return { agent: r.agent, evidence: `matches "${r.contains}"` };
    }
    return undefined;
}

/** The first line of a commit message. */
export function subjectOf(message: string): string {
    const nl = message.indexOf('\n');
    return (nl < 0 ? message : message.slice(0, nl)).trim().slice(0, 120);
}
