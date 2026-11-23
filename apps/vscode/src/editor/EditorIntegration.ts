/**
 * Meets developers in the editor (the HostPort side of the new UI):
 *
 *   Status bar   "package › component" for the active file; click to reveal it on the Map
 *   CodeLens     at the top of each indexed file: where it sits, what it uses / is used by,
 *                and whether it's in a dependency cycle (codearchy.codeLens)
 *   Command      codearchy.revealInMap (editor title, editor and Explorer context menus)
 *
 * All of it reads the hierarchy through AnalysisPipeline.locate(); nothing
 * here runs unless a graph exists.
 */
import * as vscode from 'vscode';
import type { NodeDetails } from '@codearchy/protocol';

export interface EditorIntegrationDeps {
    /** Hierarchy details for a file on disk, or undefined when it isn't indexed. */
    locate(fsPath: string): NodeDetails | undefined;
    /** Opens the panel and shows a hierarchy key on the Map. */
    reveal(key: string): Promise<void>;
}

/** "poly › web/src": the file's ancestors below the system, last three at most. */
export function locationLabel(d: NodeDetails): string {
    const parts = d.breadcrumb.slice(1, -1).map((b) => b.name);
    return (parts.length > 3 ? ['…', ...parts.slice(-3)] : parts).join(' › ') || d.breadcrumb[0]?.name || '';
}

export function codeLensTitle(d: NodeDetails): string {
    const bits = [`$(type-hierarchy) ${locationLabel(d)}`, `uses ${d.dependsOn.length}`, `used by ${d.usedBy.length}`];
    if (d.metrics.cyclicModules) bits.push('⟳ in a dependency cycle');
    return bits.join(' · ');
}

export class EditorIntegration implements vscode.Disposable {
    private readonly status: vscode.StatusBarItem;
    private readonly changed = new vscode.EventEmitter<void>();
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly deps: EditorIntegrationDeps) {
        this.status = vscode.window.createStatusBarItem('codearchy.location', vscode.StatusBarAlignment.Left, 99);
        this.status.name = 'CodeArchy: location';

        this.disposables.push(
            this.status,
            this.changed,
            vscode.window.onDidChangeActiveTextEditor(() => this.refreshStatus()),
            vscode.languages.registerCodeLensProvider({ scheme: 'file' }, {
                onDidChangeCodeLenses: this.changed.event,
                provideCodeLenses: (doc) => this.codeLenses(doc),
            }),
            vscode.commands.registerCommand('codearchy.revealInMap', async (uri?: vscode.Uri) => {
                const target = uri ?? vscode.window.activeTextEditor?.document.uri;
                const d = target ? this.deps.locate(target.fsPath) : undefined;
                if (!d) {
                    void vscode.window.showInformationMessage('CodeArchy: this file is not in the analysed workspace (or analysis has not run yet).');
                    return;
                }
                await this.deps.reveal(d.key);
            }),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('codearchy.codeLens')) this.changed.fire();
            })
        );
        this.refreshStatus();
    }

    /** Call after every graph change. */
    graphChanged(): void {
        this.refreshStatus();
        this.changed.fire();
    }

    private refreshStatus(): void {
        const doc = vscode.window.activeTextEditor?.document;
        const d = doc?.uri.scheme === 'file' ? this.deps.locate(doc.uri.fsPath) : undefined;
        if (!d) {
            this.status.hide();
            return;
        }
        this.status.text = `$(type-hierarchy) ${locationLabel(d)}`;
        const tip = new vscode.MarkdownString(`**CodeArchy** · you are in ${d.breadcrumb.map((b) => b.name).join(' › ')}\n\nUses ${d.dependsOn.length}, used by ${d.usedBy.length}. Click to reveal on the Map.`);
        tip.isTrusted = false;
        this.status.tooltip = tip;
        this.status.command = { command: 'codearchy.revealInMap', title: 'CodeArchy: Reveal in Map', arguments: [doc!.uri] };
        this.status.show();
    }

    private codeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
        if (!vscode.workspace.getConfiguration('codearchy').get<boolean>('codeLens', true)) return [];
        const d = this.deps.locate(doc.uri.fsPath);
        if (!d) return [];
        return [
            new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
                title: codeLensTitle(d),
                tooltip: 'Reveal this file on the CodeArchy Map',
                command: 'codearchy.revealInMap',
                arguments: [doc.uri],
            }),
        ];
    }

    dispose(): void {
        this.disposables.forEach((x) => x.dispose());
    }
}
