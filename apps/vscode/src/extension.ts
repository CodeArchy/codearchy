import * as vscode from 'vscode';
import { createVscodeAiHost } from './ai/vscodeAi';
import { ArchitecturePanel, configuredUi } from './webview/ArchitecturePanel';
import { AuthorshipEditor } from './authorship/AuthorshipEditor';
import { EditorIntegration } from './editor/EditorIntegration';
import { AnalysisPipeline } from './pipeline/AnalysisPipeline';
import { ModulesTreeProvider } from './views/ModulesTreeProvider';
import { CommandsTreeProvider } from './views/CommandsTreeProvider';
import { ArchitectureGraph } from './types';

let currentGraph: ArchitectureGraph | undefined;
let authorshipEditor: AuthorshipEditor | undefined;
let pipeline: AnalysisPipeline | undefined;
let modulesTreeProvider: ModulesTreeProvider;
let commandsTreeProvider: CommandsTreeProvider;
let output: vscode.OutputChannel;
let editorIntegration: EditorIntegration | undefined;

/** Batch file-system events: editors, agents and `git pull` emit bursts. */
const CHANGE_DEBOUNCE_MS = 400;

/** Minimal API returned from activate(); used by diagnostics and tests. */
export interface CodeArchyApi {
    parserStatus(): Promise<{ treeSitter: boolean; grammars: string[] }>;
    /** The latest analysed graph (kept up to date by the file watcher). */
    getGraph(): ArchitectureGraph | undefined;
    /** What the new UI asks through the panel (view, children, describe, explain, search). */
    engine(method: string, params: Record<string, unknown>): unknown;
    /** Where a file sits in the hierarchy (status bar, CodeLens). */
    locate(fsPath: string): unknown;
    /** The AI host's AiClient methods (state, updateSettings, setKey, card, audit…). */
    ai(method: string, params: Record<string, unknown>): Promise<unknown>;
    /** Asks the grounded chat once; resolves with every event. */
    aiAsk(question: string, selection?: string): Promise<unknown[]>;
}

export function activate(context: vscode.ExtensionContext): CodeArchyApi {
    output = vscode.window.createOutputChannel('CodeArchy');
    pipeline = new AnalysisPipeline(context.extensionPath, output, context.storageUri?.fsPath);
    // Authorship arrives after indexing (git log + blame in the background): refresh the panel then.
    pipeline.onAuthorshipChange = () => {
        if (currentGraph) ArchitecturePanel.update(currentGraph);
        authorshipEditor?.refresh();
    };
    pipeline.initParser().catch((err) => {
        output.appendLine(`Parser init failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    modulesTreeProvider = new ModulesTreeProvider();

    // The new UI asks the engine through the panel; the editor shows where files sit.
    ArchitecturePanel.engineHost = {
        request: (method, params) => pipeline?.engine(method as Parameters<AnalysisPipeline['engine']>[0], params),
        toAbsolute: (rel) => pipeline?.toAbsolute(rel),
    };
    // AI (chat, summary cards, providers): runs here, beside the index; the panel talks to it over postMessage.
    ArchitecturePanel.aiHost = createVscodeAiHost(
        context,
        { index: () => pipeline?.currentIndex(), flows: () => pipeline?.currentFlows(), readFile: async (rel) => pipeline?.readWorkspaceFile(rel) },
        (event) => ArchitecturePanel.postAiEvent(event),
    );
    // Authorship in the editor: capture into the ledger, the gutter, Mark as reviewed / Correct.
    authorshipEditor = new AuthorshipEditor({
        relative: (fsPath) => pipeline?.relativePath(fsPath),
        recordEdit: (rel, edit) => pipeline?.recordEdit(rel, edit),
        reconcile: (rel, text) => pipeline?.reconcile(rel, text),
        mark: async (rel, start, end, as) => (await pipeline?.mark(rel, start, end, as)) ?? { marked: 0 },
        ranges: (rel) => pipeline?.fileAuthorship(rel) ?? [],
    });
    editorIntegration = new EditorIntegration({
        locate: (fsPath) => pipeline?.locate(fsPath),
        reveal: async (key) => {
            if (!currentGraph) await runAnalysis(context);
            if (!currentGraph) return;
            if (configuredUi() !== 'map') {
                const pick = await vscode.window.showInformationMessage('Revealing a file needs the new Map view. Switch to it?', 'Switch to the Map');
                if (pick !== 'Switch to the Map') return;
                await vscode.workspace.getConfiguration('codearchy').update('ui', 'map', vscode.ConfigurationTarget.Global);
            }
            ArchitecturePanel.reveal(context, currentGraph, key);
        },
    });
    const switchUiCmd = vscode.commands.registerCommand('codearchy.switchUi', async () => {
        const next = configuredUi() === 'map' ? 'classic' : 'map';
        await vscode.workspace.getConfiguration('codearchy').update('ui', next, vscode.ConfigurationTarget.Global);
        void vscode.window.showInformationMessage(next === 'map' ? 'CodeArchy: showing the new Map.' : 'CodeArchy: showing the classic views (System, Flow, Dense).');
    });
    const uiConfigListener = vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('codearchy.ui')) ArchitecturePanel.reload();
    });

    const extensionVersion =
        (context.extension?.packageJSON?.version as string | undefined) ?? '0.0.0';
    commandsTreeProvider = new CommandsTreeProvider(extensionVersion);

    const commandsView = vscode.window.createTreeView('codearchy.commandsView', {
        treeDataProvider: commandsTreeProvider,
        showCollapseAll: false,
    });

    const treeView = vscode.window.createTreeView('codearchy.modulesView', {
        treeDataProvider: modulesTreeProvider,
        showCollapseAll: true,
    });

    const showArchitectureCmd = vscode.commands.registerCommand(
        'codearchy.showArchitecture',
        async () => {
            if (!currentGraph) {
                await runAnalysis(context);
            }
            if (currentGraph) {
                ArchitecturePanel.createOrShow(context, currentGraph);
            }
        }
    );

    const analyzeWorkspaceCmd = vscode.commands.registerCommand(
        'codearchy.analyzeWorkspace',
        async () => {
            await runAnalysis(context);
            return currentGraph?.metadata;
        }
    );

    const refreshViewCmd = vscode.commands.registerCommand(
        'codearchy.refreshView',
        async () => {
            await runAnalysis(context);
            if (currentGraph) {
                ArchitecturePanel.update(currentGraph);
            }
        }
    );

    const exportSVGCmd = vscode.commands.registerCommand(
        'codearchy.exportSVG',
        () => {
            ArchitecturePanel.triggerExport('svg');
        }
    );

    const exportPNGCmd = vscode.commands.registerCommand(
        'codearchy.exportPNG',
        () => {
            ArchitecturePanel.triggerExport('png');
        }
    );

    const openSidebarCmd = vscode.commands.registerCommand(
        'codearchy.openSidebar',
        async () => {
            await vscode.commands.executeCommand('workbench.view.extension.codearch-explorer');
        }
    );

    // Status bar entry: clickable CodeArchy branding that opens the sidebar.
    const statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        100
    );
    statusBarItem.text = '$(type-hierarchy) CodeArchy';
    statusBarItem.tooltip = 'Open CodeArchy — offline architecture visualizer';
    statusBarItem.command = 'codearchy.openSidebar';
    statusBarItem.show();

    // Watches every change on disk (saves, creates, deletes, renames, edits made
    // by agents or git), not just editor saves.
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const changed = new Map<string, vscode.Uri>();
    const deleted = new Map<string, vscode.Uri>();
    let flushTimer: NodeJS.Timeout | undefined;
    let flushing: Promise<void> = Promise.resolve();

    const flush = () => {
        flushTimer = undefined;
        const changedUris = [...changed.values()];
        const deletedUris = [...deleted.values()];
        changed.clear();
        deleted.clear();
        flushing = flushing.then(async () => {
            if (!pipeline || !currentGraph) return;
            try {
                const updated = await pipeline.applyChanges(changedUris, deletedUris);
                if (updated) {
                    currentGraph = updated;
                    editorIntegration?.graphChanged();
                    modulesTreeProvider.refresh(currentGraph);
                    ArchitecturePanel.update(currentGraph);
                }
            } catch (err) {
                output.appendLine(`Incremental update failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        });
    };
    const schedule = () => {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = setTimeout(flush, CHANGE_DEBOUNCE_MS);
    };
    const onChanged = (uri: vscode.Uri) => {
        if (!currentGraph) return;
        deleted.delete(uri.fsPath);
        changed.set(uri.fsPath, uri);
        schedule();
    };
    const onDeleted = (uri: vscode.Uri) => {
        if (!currentGraph) return;
        changed.delete(uri.fsPath);
        deleted.set(uri.fsPath, uri);
        schedule();
    };
    const fsSubscriptions = [watcher.onDidCreate(onChanged), watcher.onDidChange(onChanged), watcher.onDidDelete(onDeleted)];
    const watcherDisposable = new vscode.Disposable(() => {
        if (flushTimer) clearTimeout(flushTimer);
        fsSubscriptions.forEach((d) => d.dispose());
        watcher.dispose();
    });

    context.subscriptions.push(
        authorshipEditor,
        editorIntegration,
        switchUiCmd,
        uiConfigListener,
        commandsView,
        treeView,
        statusBarItem,
        showArchitectureCmd,
        analyzeWorkspaceCmd,
        refreshViewCmd,
        exportSVGCmd,
        exportPNGCmd,
        openSidebarCmd,
        watcherDisposable,
        output
    );

    return {
        parserStatus: () => pipeline?.parserStatus() ?? Promise.resolve({ treeSitter: false, grammars: [] }),
        getGraph: () => currentGraph,
        engine: (method, params) => pipeline?.engine(method as Parameters<AnalysisPipeline['engine']>[0], params),
        locate: (fsPath) => pipeline?.locate(fsPath),
        ai: async (method, params) => ArchitecturePanel.aiHost?.handle(method, params),
        aiAsk: async (question, selection) => {
            const events: unknown[] = [];
            await ArchitecturePanel.aiHost?.ask(`api-${Date.now()}`, question, { selection }, (e) => events.push(e));
            return events;
        },
    };
}

async function runAnalysis(context: vscode.ExtensionContext): Promise<void> {
    if (!pipeline) {
        return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showWarningMessage('CodeArchy: No workspace folder open.');
        return;
    }

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'CodeArchy: Analyzing workspace...',
            cancellable: true,
        },
        async (progress, token) => {
            // `increment` is cumulative, so report the delta since the last update.
            let reported = 0;
            const started = Date.now();
            try {
                currentGraph = await pipeline!.analyze(
                    workspaceFolders[0].uri,
                    (p) => {
                        const pct = p.phase === 'parsing' ? (p.current / Math.max(1, p.total)) * 90 : p.phase === 'complete' ? 100 : reported;
                        progress.report({ message: p.message, increment: Math.max(0, pct - reported) });
                        reported = Math.max(reported, pct);
                    },
                    token
                );
                modulesTreeProvider.refresh(currentGraph);
                editorIntegration?.graphChanged();
                const meta = currentGraph.metadata;
                const seconds = ((Date.now() - started) / 1000).toFixed(1);
                output.appendLine(
                    `Analysis: ${currentGraph.nodes.length} files, ${currentGraph.edges.length} dependencies, ` +
                        `${meta.totalSymbols} symbols in ${seconds}s (tree-sitter ${meta.parserStats?.treeSitter ?? 0}, ` +
                        `regex ${meta.parserStats?.regex ?? 0}, skipped ${meta.parserStats?.skipped ?? 0})`
                );
                if (meta.truncatedAt) {
                    const choice = await vscode.window.showWarningMessage(
                        `CodeArchy analyzed the first ${meta.truncatedAt} of ${meta.discoveredFiles} files ` +
                            '(codearchy.maxFiles). Raise the limit or narrow codearchy.excludePatterns to include the rest.',
                        'Open Settings'
                    );
                    if (choice === 'Open Settings') {
                        void vscode.commands.executeCommand('workbench.action.openSettings', 'codearchy.maxFiles');
                    }
                } else {
                    vscode.window.showInformationMessage(
                        `CodeArchy: Analysis complete — ${currentGraph.nodes.length} modules, ${currentGraph.edges.length} dependencies (${seconds}s).`
                    );
                }
            } catch (err) {
                if (err instanceof vscode.CancellationError) {
                    return;
                }
                const message = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`CodeArchy: Analysis failed — ${message}`);
            }
        }
    );
}

export function deactivate() {
    ArchitecturePanel.dispose();
    currentGraph = undefined;
    pipeline?.dispose();
    pipeline = undefined;
}
