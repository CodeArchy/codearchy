/**
 * Authorship: which code an AI wrote, from evidence (doc 07). Every line is
 * `ai` (inserted by an agent and unchanged since), `reviewed` (AI-inserted,
 * later changed by a human), `human` (positive evidence of a person), or
 * `unknown` (no evidence either way: the honest default for old history).
 *
 * Aggregates only: nothing here names a person.
 */

export type AuthorshipOrigin = 'ai' | 'reviewed' | 'human' | 'unknown';

/** How sure an attribution is: from a log or live capture, declared by a commit, or inferred. */
export type AuthorshipConfidence = 'verified' | 'declared' | 'inferred' | 'heuristic';

/** Lines per origin. */
export interface AuthorshipCounts {
    ai: number;
    reviewed: number;
    human: number;
    unknown: number;
}

/** A run of lines with one attribution (1-based, inclusive). */
export interface AuthorshipRange {
    start: number;
    end: number;
    origin: AuthorshipOrigin;
    /** The AI tool: claude-code, copilot, cursor, codex, gemini-cli, aider, devin… */
    agent?: string;
    confidence?: AuthorshipConfidence;
    /** The commit the evidence comes from (full hash). */
    commit?: string;
}

/** An AI commit behind some of a node's lines. */
export interface AuthorshipCommit {
    hash: string;
    agent: string;
    /** Commit time, ms since the epoch. */
    time: number;
    /** First line of the message. */
    subject: string;
    /** How the commit was recognised: `Co-authored-by: Claude`, `bot author`… */
    evidence: string;
    /** Lines in this node still attributed to it. */
    lines: number;
}

/** The Inspector's Authorship section, and the per-file gutter's source. */
export interface NodeAuthorship {
    key: string;
    counts: AuthorshipCounts;
    /** AI and reviewed lines per agent. */
    byAgent: Record<string, number>;
    /** Files with the most AI lines (for containers). */
    topFiles: Array<{ path: string; ai: number; lines: number }>;
    /** AI lines still present, by the week their commit landed (oldest first, ms of each week's Monday). */
    weekly: Array<{ week: number; ai: number }>;
    commits: AuthorshipCommit[];
    /** A module: its ranges (only the attributed ones; the rest are unknown). */
    ranges?: AuthorshipRange[];
}

/** What the engine knows about authorship in this workspace. */
export interface AuthorshipStatus {
    state: 'ready' | 'computing' | 'unavailable';
    /** Why it's unavailable (no git history here, git missing…). */
    reason?: string;
    /** Commits read, and how many carried AI markers. */
    commits?: number;
    aiCommits?: number;
    /** Files whose lines were traced to commits (only files AI commits touched need it). */
    blamedFiles?: number;
    /** Commits with a CodeArchy authorship note (refs/notes/codearchy-authorship). */
    notedCommits?: number;
    /** Whole-workspace counts. */
    counts?: AuthorshipCounts;
}

/** Display names for the tool ids authorship records. */
export const AGENT_NAMES: Readonly<Record<string, string>> = {
    'claude-code': 'Claude Code',
    copilot: 'GitHub Copilot',
    cursor: 'Cursor',
    codex: 'OpenAI Codex',
    'gemini-cli': 'Gemini',
    aider: 'Aider',
    devin: 'Devin',
    jules: 'Jules',
    windsurf: 'Windsurf',
    openhands: 'OpenHands',
    'amazon-q': 'Amazon Q',
    cline: 'Cline',
    'unknown-ai': 'an AI tool',
};

/** `claude-code` → `Claude Code` (unknown ids as they are). */
export function agentName(id: string): string {
    return AGENT_NAMES[id] ?? id;
}

/** "What this branch adds, and who wrote it": lines added since the branch left its base. */
export interface BranchReport {
    /** The ref compared against, and the commit where the branch left it. */
    base: string;
    mergeBase: string;
    head: string;
    /** Commits on the branch. */
    commits: number;
    /** Added lines (committed on the branch, or not committed yet) by origin. */
    added: AuthorshipCounts;
    /** Of those, not committed yet. */
    uncommitted: number;
    /** AI and reviewed lines per tool. */
    byAgent: Record<string, number>;
    /** Per part of the system (nearest component or package), most added first. */
    byPart: Array<{ key: string; name: string; added: AuthorshipCounts }>;
    /** Per file, most added first. */
    files: Array<{ path: string; added: AuthorshipCounts; status: 'added' | 'modified' }>;
    /** Dependencies between parts that the branch introduces. */
    newDependencies: Array<{ from: string; to: string; fromName: string; toName: string; via: Array<{ from: string; to: string }> }>;
    /** Files removed on the branch. */
    deleted: string[];
}
