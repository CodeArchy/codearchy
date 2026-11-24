/**
 * Agent session logs (doc 07 §5): the edits coding agents made, from their
 * own logs on this machine, matched to today's lines (confidence "verified").
 *
 *   Claude Code   JSONL transcripts: Write / Edit / MultiEdit tool calls (a
 *                 change the person edited before accepting is "reviewed")
 *   Codex CLI     JSONL sessions: apply_patch patches (added lines)
 *   Aider         .aider.chat.history.md: SEARCH/REPLACE blocks
 *
 * Rules: read-only; only edits to files inside the workspace; nothing from
 * the conversation is kept, only which lines an agent wrote and when.
 * Formats are undocumented and change, so parsing is tolerant: what isn't
 * recognised is skipped and counted, never guessed.
 */
import type { LedgerRange } from './ledger.js';

export type AgentId = 'claude-code' | 'codex' | 'aider';

/** One block of text an agent inserted into a file. */
export interface AgentEdit {
    agent: AgentId;
    /** Absolute path as the log has it (workspace-relative for Aider). */
    file: string;
    /** ms since the epoch (0 when the log has no time). */
    time: number;
    /** The inserted text, as lines. */
    lines: string[];
    /** The person changed the agent's proposal before accepting it. */
    reviewed?: boolean;
}

export interface ParseResult {
    edits: AgentEdit[];
    /** Entries that looked like edits but couldn't be read (format drift). */
    skipped: number;
    /** The working directory the log belongs to, when it says. */
    cwd?: string;
}

const splitLines = (s: string) => s.replace(/\r\n/g, '\n').split('\n');
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const timeOf = (v: unknown) => (typeof v === 'string' ? Date.parse(v) || 0 : typeof v === 'number' ? v : 0);

// ─── Claude Code ────────────────────────────────────────────────────────────

/** A Claude Code transcript (JSONL). Failed or rejected tool calls are left out. */
export function parseClaudeCode(jsonl: string): ParseResult {
    const pending = new Map<string, AgentEdit[]>();
    const failed = new Set<string>();
    const modified = new Set<string>();
    let skipped = 0;
    let cwd: string | undefined;
    for (const line of jsonl.split('\n')) {
        if (!line.trim()) continue;
        let o: unknown;
        try {
            o = JSON.parse(line);
        } catch {
            continue;
        }
        if (!isObject(o)) continue;
        if (typeof o.cwd === 'string') cwd ??= o.cwd;
        const content = isObject(o.message) && Array.isArray(o.message.content) ? o.message.content : [];
        const time = timeOf(o.timestamp);
        for (const b of content) {
            if (!isObject(b)) continue;
            if (b.type === 'tool_use' && typeof b.id === 'string' && isObject(b.input)) {
                const input = b.input;
                const file = typeof input.file_path === 'string' ? input.file_path : undefined;
                const texts: string[] = [];
                if (b.name === 'Write' && typeof input.content === 'string') texts.push(input.content);
                else if (b.name === 'Edit') {
                    const s = typeof input.new_string === 'string' ? input.new_string : typeof input.new_str === 'string' ? input.new_str : undefined;
                    if (s !== undefined) texts.push(s);
                } else if (b.name === 'MultiEdit' && Array.isArray(input.edits)) {
                    for (const e of input.edits) if (isObject(e) && typeof e.new_string === 'string') texts.push(e.new_string);
                } else continue;
                if (!file || texts.length === 0) {
                    skipped++;
                    continue;
                }
                pending.set(
                    b.id,
                    texts.map((t) => ({ agent: 'claude-code', file, time, lines: splitLines(t) }))
                );
            } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
                if (b.is_error === true) failed.add(b.tool_use_id);
                const result = isObject(o.toolUseResult) ? o.toolUseResult : undefined;
                if (result?.userModified === true) modified.add(b.tool_use_id);
            }
        }
    }
    const edits: AgentEdit[] = [];
    for (const [id, list] of pending) {
        if (failed.has(id)) continue;
        for (const e of list) edits.push(modified.has(id) ? { ...e, reviewed: true } : e);
    }
    return { edits, skipped, ...(cwd ? { cwd } : {}) };
}

// ─── Codex CLI ──────────────────────────────────────────────────────────────

/** Added lines per file from an apply_patch patch (`*** Add File` / `*** Update File`). */
export function parseApplyPatch(patch: string): Array<{ file: string; blocks: string[][] }> {
    const out: Array<{ file: string; blocks: string[][] }> = [];
    let current: { file: string; blocks: string[][] } | undefined;
    let block: string[] = [];
    const flush = () => {
        if (current && block.length) current.blocks.push(block);
        block = [];
    };
    for (const raw of splitLines(patch)) {
        const header = /^\*\*\* (Add|Update) File: (.+)$/.exec(raw);
        if (header) {
            flush();
            current = { file: header[2]!.trim(), blocks: [] };
            out.push(current);
            continue;
        }
        if (raw.startsWith('*** ')) {
            flush();
            if (!raw.startsWith('*** Move to: ')) current = undefined;
            continue;
        }
        if (!current) continue;
        if (raw.startsWith('+') && !raw.startsWith('+++')) block.push(raw.slice(1));
        else flush();
    }
    flush();
    return out.filter((f) => f.blocks.length);
}

/** Patch texts wherever a Codex log entry carries one (function or custom tool calls, shell commands). */
function patchesIn(v: unknown, found: string[], depth = 0): void {
    if (depth > 6) return;
    if (typeof v === 'string') {
        if (!v.includes('Begin Patch')) return;
        // Tool arguments often arrive as a JSON string: read it as JSON first (its escapes hide the newlines).
        const t = v.trimStart();
        if (t.startsWith('{') || t.startsWith('[')) {
            try {
                patchesIn(JSON.parse(t), found, depth + 1);
                return;
            } catch {
                // not JSON after all
            }
        }
        if (v.includes('*** Begin Patch')) found.push(v.slice(v.indexOf('*** Begin Patch')));
        return;
    }
    if (Array.isArray(v)) for (const x of v) patchesIn(x, found, depth + 1);
    else if (isObject(v)) for (const x of Object.values(v)) patchesIn(x, found, depth + 1);
}

/** A Codex CLI session (JSONL). Paths in patches are relative to the session's working directory. */
export function parseCodex(jsonl: string): ParseResult {
    const edits: AgentEdit[] = [];
    let skipped = 0;
    let cwd: string | undefined;
    for (const line of jsonl.split('\n')) {
        if (!line.trim()) continue;
        let o: unknown;
        try {
            o = JSON.parse(line);
        } catch {
            continue;
        }
        if (!isObject(o)) continue;
        const payload = isObject(o.payload) ? o.payload : o;
        if (typeof payload.cwd === 'string') cwd ??= payload.cwd;
        const kind = String(payload.type ?? '');
        if (!kind.includes('call') && !kind.includes('patch')) continue;
        const found: string[] = [];
        patchesIn(payload, found);
        const time = timeOf(o.timestamp ?? payload.timestamp);
        for (const patch of found) {
            const files = parseApplyPatch(patch);
            if (!files.length) skipped++;
            for (const f of files) for (const lines of f.blocks) edits.push({ agent: 'codex', file: f.file, time, lines });
        }
    }
    return { edits, skipped, ...(cwd ? { cwd } : {}) };
}

// ─── Aider ──────────────────────────────────────────────────────────────────

/** Aider's chat history: SEARCH/REPLACE blocks (the file name is the line above the block). */
export function parseAider(markdown: string): ParseResult {
    const edits: AgentEdit[] = [];
    let skipped = 0;
    let time = 0;
    const lines = splitLines(markdown);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const started = /^# aider chat started at (.+)$/.exec(line);
        if (started) {
            time = Date.parse(started[1]!.trim().replace(' ', 'T')) || time;
            continue;
        }
        if (!line.startsWith('<<<<<<< SEARCH')) continue;
        // The file name: the nearest line above that isn't a fence or blank.
        let file: string | undefined;
        for (let k = i - 1; k >= Math.max(0, i - 3); k--) {
            const t = lines[k]!.trim();
            if (!t || t.startsWith('```')) continue;
            file = t;
            break;
        }
        const sep = lines.indexOf('=======', i + 1);
        const end = lines.findIndex((l, idx) => idx > sep && l.startsWith('>>>>>>> REPLACE'));
        if (!file || sep < 0 || end < 0) {
            skipped++;
            continue;
        }
        const replacement = lines.slice(sep + 1, end);
        if (replacement.length) edits.push({ agent: 'aider', file, time, lines: replacement });
        i = end;
    }
    return { edits, skipped };
}

// ─── matching to today's lines ──────────────────────────────────────────────

/** Lines too generic to place an edit by: blank, braces, `end`, `return x;`… */
const significant = (s: string) => s.trim().replace(/[\s{}();,[\]]/g, '').length >= 4;
const MAX_LCS_CELLS = 4_000_000;

/**
 * Where the agent's blocks are in today's file, as ledger ranges (1-based):
 * an exact run of the block's lines is `ai`; otherwise the longest common
 * subsequence places it, matched lines `ai` and changed lines inside the
 * span `reviewed` (a person rewrote them). Blocks too small or too changed
 * to place reliably are left out. Later edits win over earlier ones.
 */
export function matchEdits(fileText: string, edits: AgentEdit[]): LedgerRange[] {
    const file = splitLines(fileText).map((l) => l.trimEnd());
    const perLine: Array<LedgerRange | undefined> = new Array(file.length + 1);
    for (const e of [...edits].sort((a, b) => a.time - b.time)) {
        const block = e.lines.map((l) => l.trimEnd());
        while (block.length && !block[block.length - 1]!.trim()) block.pop();
        while (block.length && !block[0]!.trim()) block.shift();
        const sigLines = block.filter(significant);
        const sig = sigLines.length;
        // Too little to place reliably: one short line (`return x;`) could be anyone's.
        if (sig === 0 || (sig < 2 && sigLines.join('').trim().length < 20)) continue;
        const range = (origin: 'ai' | 'reviewed'): LedgerRange => ({ start: 0, end: 0, origin: e.reviewed && origin === 'ai' ? 'reviewed' : origin, agent: e.agent, confidence: 'verified', time: e.time, source: 'log' });
        const exact = findRun(file, block);
        if (exact > 0) {
            for (let n = exact; n < exact + block.length; n++) perLine[n] = range('ai');
            continue;
        }
        if (block.length < 3 || block.length * file.length > MAX_LCS_CELLS) continue;
        const pairs = lcs(block, file);
        const matchedSig = pairs.filter(([b]) => significant(block[b]!)).length;
        if (!pairs.length || matchedSig / sig < 0.5) continue;
        const first = pairs[0]![1];
        const last = pairs[pairs.length - 1]![1];
        if (last - first + 1 > block.length * 2) continue; // too scattered to be this block
        const matched = new Set(pairs.map(([, f]) => f));
        for (let f = first; f <= last; f++) perLine[f + 1] = range(matched.has(f) ? 'ai' : 'reviewed');
    }
    // Lines → ranges.
    const out: LedgerRange[] = [];
    for (let n = 1; n <= file.length; n++) {
        const r = perLine[n];
        if (!r) continue;
        const prev = out[out.length - 1];
        if (prev && prev.end === n - 1 && prev.origin === r.origin && prev.agent === r.agent && prev.time === r.time) prev.end = n;
        else out.push({ ...r, start: n, end: n });
    }
    return out;
}

/** 1-based start of the first exact run of `block` in `file`, or 0. */
function findRun(file: string[], block: string[]): number {
    outer: for (let i = 0; i + block.length <= file.length; i++) {
        for (let j = 0; j < block.length; j++) if (file[i + j] !== block[j]) continue outer;
        return i + 1;
    }
    return 0;
}

/** Longest common subsequence of lines (trimmed), as [blockIndex, fileIndex] pairs in order. */
function lcs(a: string[], b: string[]): Array<[number, number]> {
    const ta = a.map((s) => s.trim());
    const tb = b.map((s) => s.trim());
    const n = ta.length;
    const m = tb.length;
    const dp = new Uint16Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i * (m + 1) + j] = ta[i] === tb[j] && ta[i] !== '' ? dp[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(dp[(i + 1) * (m + 1) + j]!, dp[i * (m + 1) + j + 1]!);
        }
    }
    const pairs: Array<[number, number]> = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (ta[i] === tb[j] && ta[i] !== '') {
            pairs.push([i, j]);
            i++;
            j++;
        } else if (dp[(i + 1) * (m + 1) + j]! >= dp[i * (m + 1) + j + 1]!) i++;
        else j++;
    }
    return pairs;
}
