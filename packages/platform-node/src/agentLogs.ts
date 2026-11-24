/**
 * Reads coding agents' session logs on this machine (doc 07 §5) and records
 * the lines they wrote in the authorship ledger. Opt-in per agent: the logs
 * hold people's prompts and conversations, so only derived ranges (which
 * lines, which agent, when) are kept, never their text.
 *
 *   claude-code   ~/.claude/projects/<workspace path, encoded>/*.jsonl (CLAUDE_CONFIG_DIR)
 *   codex         ~/.codex/sessions/**\/*.jsonl whose session cwd is in the workspace (CODEX_HOME)
 *   aider         <workspace>/.aider.chat.history.md
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { matchEdits, parseAider, parseClaudeCode, parseCodex, type AgentEdit, type AgentId, type AuthorshipLedger, type ParseResult } from '@codearchy/core';
import { toPosix } from './index.js';

export const AGENT_IDS: AgentId[] = ['claude-code', 'codex', 'aider'];

/** Logs larger than this are skipped (a diagnostic says so). */
const MAX_LOG_BYTES = 200 * 1024 * 1024;

export interface AgentLogOptions {
    agents: AgentId[];
    /** Defaults to the user's home (tests point it elsewhere). */
    home?: string;
    env?: NodeJS.ProcessEnv;
}

export interface AgentLogReport {
    agent: AgentId;
    /** Log files read. */
    logs: number;
    /** Edits to files in this workspace. */
    edits: number;
    /** Entries that looked like edits but couldn't be read (the log format may have changed). */
    skipped: number;
    /** Workspace files with lines placed. */
    files: number;
    /** Logs too large to read. */
    tooLarge: number;
}

interface Cached {
    stamp: string;
    result: ParseResult;
}

export class AgentLogIngester {
    private readonly cache = new Map<string, Cached>();
    /** Workspace files that had log ranges last time (they're cleared if the logs stop mentioning them). */
    private previous = new Set<string>();

    constructor(
        private readonly root: string,
        private readonly options: AgentLogOptions
    ) {}

    /** Reads the enabled agents' logs, places their edits in today's files and records them in the ledger. */
    async run(ledger: AuthorshipLedger, read: (rel: string) => Promise<string | undefined>): Promise<AgentLogReport[]> {
        const reports: AgentLogReport[] = [];
        const byFile = new Map<string, AgentEdit[]>();
        for (const agent of this.options.agents) {
            const report: AgentLogReport = { agent, logs: 0, edits: 0, skipped: 0, files: 0, tooLarge: 0 };
            for (const { file, parse, base } of this.logsOf(agent)) {
                const parsed = this.parse(file, parse, report);
                if (!parsed) continue;
                report.logs++;
                report.skipped += parsed.skipped;
                // Codex paths are relative to the session's directory; Aider's to the repository (the workspace).
                const from = agent === 'codex' ? parsed.cwd : base;
                if (agent === 'codex' && (!from || !this.inside(from))) continue;
                for (const e of parsed.edits) {
                    const abs = path.isAbsolute(e.file) ? e.file : path.resolve(from ?? this.root, e.file);
                    if (!this.inside(abs)) continue;
                    const rel = toPosix(this.root, abs);
                    if (!rel) continue;
                    report.edits++;
                    const list = byFile.get(rel);
                    if (list) list.push(e);
                    else byFile.set(rel, [e]);
                }
            }
            reports.push(report);
        }
        const now = new Set<string>();
        for (const [rel, edits] of byFile) {
            const text = await read(rel);
            if (text === undefined) continue;
            const ranges = matchEdits(text, edits);
            ledger.recordLog(rel, ranges, text);
            if (ranges.length) {
                now.add(rel);
                const r = reports.find((x) => x.agent === edits[0]!.agent);
                if (r) r.files++;
            }
        }
        for (const rel of this.previous) if (!now.has(rel) && !byFile.has(rel)) ledger.recordLog(rel, []);
        this.previous = now;
        return reports;
    }

    private inside(abs: string): boolean {
        const rel = path.relative(this.root, abs);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    }

    private home(): string {
        return this.options.home ?? os.homedir();
    }

    /** The log files for an agent that may concern this workspace. */
    private logsOf(agent: AgentId): Array<{ file: string; parse: (text: string) => ParseResult; base: string }> {
        const env = this.options.env ?? process.env;
        if (agent === 'claude-code') {
            const projects = path.join(env.CLAUDE_CONFIG_DIR ?? path.join(this.home(), '.claude'), 'projects');
            // Claude Code names a project's folder after its path, every other character as '-'.
            // Sessions started in this folder, below it, or above it (editing files in here) all count.
            const encode = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');
            const prefix = encode(path.resolve(this.root));
            const ancestors = new Set<string>();
            for (let p = path.dirname(path.resolve(this.root)); p !== path.dirname(p); p = path.dirname(p)) ancestors.add(encode(p));
            return dirs(projects)
                .filter((d) => d === prefix || d.startsWith(`${prefix}-`) || ancestors.has(d))
                .flatMap((d) => files(path.join(projects, d), '.jsonl', 3)) // sessions, and their subagents' transcripts
                .map((file) => ({ file, parse: parseClaudeCode, base: this.root }));
        }
        if (agent === 'codex') {
            const sessions = path.join(env.CODEX_HOME ?? path.join(this.home(), '.codex'), 'sessions');
            return files(sessions, '.jsonl', 5).map((file) => ({ file, parse: parseCodex, base: this.root }));
        }
        const history = path.join(this.root, '.aider.chat.history.md');
        return fs.existsSync(history) ? [{ file: history, parse: parseAider, base: this.root }] : [];
    }

    private parse(file: string, parse: (text: string) => ParseResult, report: AgentLogReport): ParseResult | undefined {
        let st: fs.Stats;
        try {
            st = fs.statSync(file);
        } catch {
            return undefined;
        }
        if (st.size > MAX_LOG_BYTES) {
            report.tooLarge++;
            return undefined;
        }
        const stamp = `${st.size}:${st.mtimeMs}`;
        const hit = this.cache.get(file);
        if (hit?.stamp === stamp) return hit.result;
        let result: ParseResult;
        try {
            result = parse(fs.readFileSync(file, 'utf8'));
        } catch {
            return undefined;
        }
        this.cache.set(file, { stamp, result });
        return result;
    }
}

function dirs(dir: string): string[] {
    try {
        return fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name);
    } catch {
        return [];
    }
}

/** Files with an extension under `dir`, down to `depth` levels. */
function files(dir: string, ext: string, depth: number): string[] {
    const out: string[] = [];
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isFile() && e.name.endsWith(ext)) out.push(p);
        else if (e.isDirectory() && depth > 1) out.push(...files(p, ext, depth - 1));
    }
    return out;
}
