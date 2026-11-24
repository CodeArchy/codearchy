/**
 * Authorship in the editor (Phase 5b, doc 07 §4):
 *
 *   Capture   editor changes, classified by shape and timing, feed the ledger:
 *             typing and pastes are a person's (and a person changing AI lines
 *             reviews them); a large insertion in the focused editor that isn't
 *             a paste is an AI tool's (inferred: VS Code doesn't say which
 *             extension made an edit); undo/redo, reloads and formatter bursts
 *             only move ranges.
 *   Gutter    a thin bar beside AI-written and reviewed lines; the hover says
 *             which tool, when, and on what evidence.
 *   Commands  "Mark as reviewed" and "Correct authorship" for the selection.
 *
 * Everything stays on this machine: the ledger lives in workspace storage.
 */
import * as vscode from 'vscode';
import { agentName, type AuthorshipOrigin, type AuthorshipRange } from '@codearchy/protocol';
import type { LineEdit } from '@codearchy/core';
import { breaks, lineEditOf } from './lineEdit';

export interface AuthorshipEditorDeps {
    /** Workspace-relative path of a file in the workspace, else undefined. */
    relative(fsPath: string): string | undefined;
    recordEdit(rel: string, edit: LineEdit): void;
    reconcile(rel: string, text: string): void;
    mark(rel: string, start: number, end: number, as: 'reviewed' | AuthorshipOrigin): Promise<{ marked: number }>;
    ranges(rel: string): Array<AuthorshipRange & { time?: number; subject?: string }>;
}

/** An insertion this large (characters, or lines) in the focused editor is a candidate AI insertion. */
const AI_MIN_CHARS = 30;
const AI_MIN_LINES = 2;
/** More changes than this in one event is a tool at work (formatter, refactoring, multi-cursor). */
const TOOL_BURST = 3;

const config = () => vscode.workspace.getConfiguration('codearchy');
const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** A thin bar for the gutter, as a data URI (no files to ship). */
function bar(color: string): vscode.Uri {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="6" height="20"><rect x="1" y="0" width="3" height="20" rx="1" fill="${color}"/></svg>`;
    return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

/** The tool most likely behind an AI insertion in this editor (inferred). */
function guessAgent(): string {
    const app = vscode.env.appName.toLowerCase();
    if (app.includes('cursor')) return 'cursor';
    if (app.includes('windsurf')) return 'windsurf';
    if (vscode.extensions.getExtension('GitHub.copilot')?.isActive || vscode.extensions.getExtension('GitHub.copilot-chat')?.isActive) return 'copilot';
    return 'unknown-ai';
}

export class AuthorshipEditor implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];
    private readonly queues = new Map<string, Promise<void>>();
    private readonly aiDecoration = vscode.window.createTextEditorDecorationType({ gutterIconPath: bar('#dd6230'), gutterIconSize: 'contain', overviewRulerColor: '#dd6230', overviewRulerLane: vscode.OverviewRulerLane.Left });
    private readonly reviewedDecoration = vscode.window.createTextEditorDecorationType({ gutterIconPath: bar('#2a78d6'), gutterIconSize: 'contain', overviewRulerColor: '#2a78d6', overviewRulerLane: vscode.OverviewRulerLane.Left });

    constructor(private readonly deps: AuthorshipEditorDeps) {
        this.disposables.push(
            this.aiDecoration,
            this.reviewedDecoration,
            vscode.workspace.onDidChangeTextDocument((e) => this.onChange(e)),
            vscode.workspace.onDidSaveTextDocument((doc) => {
                const rel = this.rel(doc);
                if (rel) this.deps.reconcile(rel, doc.getText());
            }),
            vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()),
            vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('codearchy.authorship') && this.refresh()),
            // From the palette or menus: the selection. From a gutter hover: that range ([rel, start, end]).
            vscode.commands.registerCommand('codearchy.authorship.markReviewed', (rel?: unknown, start?: unknown, end?: unknown) => this.markSelection(rangeArgs(rel, start, end))),
            vscode.commands.registerCommand('codearchy.authorship.correct', (rel?: unknown, start?: unknown, end?: unknown) => this.correctSelection(rangeArgs(rel, start, end)))
        );
        this.refresh();
    }

    /** Redraws the gutter in every visible editor (after authorship or the ledger changed). */
    refresh(): void {
        const show = config().get<boolean>('authorship.enabled', true) && config().get<boolean>('authorship.gutter', true);
        for (const editor of vscode.window.visibleTextEditors) {
            const rel = show ? this.rel(editor.document) : undefined;
            const ranges = rel ? this.deps.ranges(rel) : [];
            const lines = editor.document.lineCount;
            const toDecoration = (r: AuthorshipRange & { time?: number; subject?: string }): vscode.DecorationOptions => ({
                range: new vscode.Range(Math.min(r.start, lines) - 1, 0, Math.min(r.end, lines) - 1, 0),
                hoverMessage: hover(rel!, r),
            });
            editor.setDecorations(this.aiDecoration, ranges.filter((r) => r.origin === 'ai' && r.start <= lines).map(toDecoration));
            editor.setDecorations(this.reviewedDecoration, ranges.filter((r) => r.origin === 'reviewed' && r.start <= lines).map(toDecoration));
        }
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
    }

    private rel(doc: vscode.TextDocument): string | undefined {
        return doc.uri.scheme === 'file' ? this.deps.relative(doc.uri.fsPath) : undefined;
    }

    private onChange(e: vscode.TextDocumentChangeEvent): void {
        if (!e.contentChanges.length || !config().get<boolean>('authorship.enabled', true) || !config().get<boolean>('authorship.capture', true)) return;
        const rel = this.rel(e.document);
        if (!rel) return;
        const focused = vscode.window.activeTextEditor?.document === e.document && vscode.window.state.focused;
        const tool = e.reason !== undefined || !focused || e.contentChanges.length > TOOL_BURST;
        // Bottom-up, so each change's old line numbers are still right when it's applied.
        const changes = [...e.contentChanges].sort((a, b) => b.range.start.line - a.range.start.line || b.range.start.character - a.range.start.character);
        const key = e.document.uri.toString();
        const run = (this.queues.get(key) ?? Promise.resolve()).then(async () => {
            for (const c of changes) {
                const edit = lineEditOf(c);
                let by: LineEdit['by'] = tool ? 'unknown' : 'human';
                const big = c.text.trim().length > 0 && (c.text.length >= AI_MIN_CHARS || breaks(c.text) >= AI_MIN_LINES);
                if (!tool && big) {
                    // A paste is the person's; anything else this large is an AI insertion.
                    const clip = await vscode.env.clipboard.readText().then((t) => t, () => '');
                    by = clip && clip.trim() === c.text.trim() ? 'human' : 'ai';
                }
                this.deps.recordEdit(rel, by === 'ai' ? { ...edit, by, agent: guessAgent(), confidence: 'inferred' } : { ...edit, by });
            }
        });
        this.queues.set(key, run.catch(() => undefined));
    }

    private selection(): { rel: string; start: number; end: number } | undefined {
        const editor = vscode.window.activeTextEditor;
        const rel = editor ? this.rel(editor.document) : undefined;
        if (!editor || !rel) {
            void vscode.window.showInformationMessage('Open a workspace file and select the lines first.');
            return undefined;
        }
        const s = editor.selection;
        const endLine = s.end.character === 0 && s.end.line > s.start.line ? s.end.line - 1 : s.end.line;
        return { rel, start: s.start.line + 1, end: endLine + 1 };
    }

    private async markSelection(given?: { rel: string; start: number; end: number }): Promise<void> {
        const sel = given ?? this.selection();
        if (!sel) return;
        const { marked } = await this.deps.mark(sel.rel, sel.start, sel.end, 'reviewed');
        void vscode.window.showInformationMessage(marked ? `Marked ${marked} AI-written line${marked === 1 ? '' : 's'} as reviewed.` : 'No AI-written lines in the selection.');
        this.refresh();
    }

    private async correctSelection(given?: { rel: string; start: number; end: number }): Promise<void> {
        const sel = given ?? this.selection();
        if (!sel) return;
        const pick = await vscode.window.showQuickPick(
            [
                { label: 'Written by a person', origin: 'human' as const },
                { label: 'Written by an AI tool', origin: 'ai' as const },
                { label: 'Unknown', description: 'forget what was recorded for these lines', origin: 'unknown' as const },
            ],
            { title: `Authorship of lines ${sel.start}–${sel.end}`, placeHolder: 'Who wrote these lines?' }
        );
        if (!pick) return;
        await this.deps.mark(sel.rel, sel.start, sel.end, pick.origin);
        this.refresh();
    }
}

/** Command arguments from a hover link, validated (anything else means "the selection"). */
function rangeArgs(rel: unknown, start: unknown, end: unknown): { rel: string; start: number; end: number } | undefined {
    return typeof rel === 'string' && Number.isInteger(start) && Number.isInteger(end) ? { rel, start: start as number, end: end as number } : undefined;
}

function hover(rel: string, r: AuthorshipRange & { time?: number; subject?: string }): vscode.MarkdownString {
    const who = agentName(r.agent ?? 'unknown-ai');
    const when = r.time ? ` · ${dateFmt.format(r.time)}` : '';
    const evidence = r.commit
        ? `from commit \`${r.commit.slice(0, 7)}\`${r.subject ? ` (${r.subject})` : ''}, ${r.confidence ?? 'declared'}`
        : r.confidence === 'declared'
          ? 'recorded by a person'
          : 'captured in the editor, inferred';
    const state = r.origin === 'reviewed' ? 'changed or reviewed by a person since' : 'not changed since';
    const args = encodeURIComponent(JSON.stringify([rel, r.start, r.end]));
    const review = r.origin === 'ai' ? `[Mark as reviewed](command:codearchy.authorship.markReviewed?${args}) · ` : '';
    const md = new vscode.MarkdownString(`**${who}**${when} · ${evidence} · ${state}\n\n${review}[Correct](command:codearchy.authorship.correct?${args})`);
    md.isTrusted = { enabledCommands: ['codearchy.authorship.markReviewed', 'codearchy.authorship.correct'] };
    return md;
}
