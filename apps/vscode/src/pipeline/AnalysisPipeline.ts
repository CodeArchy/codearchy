import * as vscode from 'vscode';
import * as path from 'path';
import { AnalysisProgress, ArchitectureGraph, ExtensionConfig, FileAnalysis, getConfig } from '../types';
import { Analyzer, AnalysisCancelledError, readManifests } from '../analysis/Analyzer';
import { classifyFiles, discoverWithGit, DiscoveryResult, gitIgnoredPaths, isManifest } from '../analysis/discovery';
import { compileGlobs } from '../analysis/glob';
import { getPackForExtension } from '../analysis/languages';
import { toPosix } from '../analysis/resolver';
import { GraphBuilder } from '../graph/GraphBuilder';
import { ArchitectureInference } from '../inference/ArchitectureInference';

/** Per-workspace state kept between analyses so file changes are incremental. */
interface WorkspaceState {
    root: string;
    analyses: Map<string, FileAnalysis>;
    manifests: Map<string, string>;
    discovery: DiscoveryResult;
}

export class AnalysisPipeline {
    private analyzer: Analyzer | undefined;
    private analyzerPromise: Promise<Analyzer> | undefined;
    private readonly inference = new ArchitectureInference();
    private state: WorkspaceState | undefined;

    constructor(
        private readonly extensionPath: string,
        private readonly output?: vscode.OutputChannel
    ) {}

    async initParser(): Promise<void> {
        await this.getAnalyzer();
    }

    isTreeSitterAvailable(): boolean {
        return this.analyzer?.treeSitterAvailable ?? false;
    }

    /** Parser health, for diagnostics and the extension's smoke tests. */
    async parserStatus(): Promise<{ treeSitter: boolean; grammars: string[] }> {
        const analyzer = await this.getAnalyzer();
        return { treeSitter: analyzer.treeSitterAvailable, grammars: analyzer.availableGrammars() };
    }

    async analyze(
        workspaceUri: vscode.Uri,
        onProgress: (progress: AnalysisProgress) => void,
        token: vscode.CancellationToken
    ): Promise<ArchitectureGraph> {
        const config = getConfig();
        const root = workspaceUri.fsPath;
        const analyzer = await this.getAnalyzer();

        onProgress({ phase: 'discovery', current: 0, total: 1, message: 'Discovering files...' });
        const discovery = await this.discover(workspaceUri, config);
        if (token.isCancellationRequested) throw new vscode.CancellationError();
        this.log(
            `discovery (${discovery.method}): ${discovery.sourceFiles.length} source files` +
                (discovery.truncated ? ` of ${discovery.discovered} (limited by codearchy.maxFiles)` : '') +
                `, ${discovery.manifests.length} manifests`
        );

        const manifests = await readManifests(discovery.manifests);
        let analyses: Map<string, FileAnalysis>;
        try {
            analyses = await analyzer.analyzeAll(discovery.sourceFiles, {
                isCancelled: () => token.isCancellationRequested,
                onProgress: ({ current, total, file }) => {
                    // Reporting every file floods the progress UI; every 1% is plenty.
                    if (current === total || current % Math.max(1, Math.floor(total / 100)) === 0) {
                        onProgress({ phase: 'parsing', current, total, message: `Parsing: ${path.relative(root, file)}` });
                    }
                },
            });
        } catch (err) {
            if (err instanceof AnalysisCancelledError) throw new vscode.CancellationError();
            throw err;
        }

        this.state = { root, analyses, manifests, discovery };
        onProgress({ phase: 'graphing', current: 0, total: 1, message: 'Building dependency graph...' });
        const graph = this.buildGraph();
        onProgress({ phase: 'complete', current: 1, total: 1, message: 'Analysis complete.' });
        return graph;
    }

    /**
     * Applies created/changed/deleted files (from saves, agents, `git pull`...)
     * and rebuilds the graph, edges included. Returns undefined when nothing
     * relevant changed or no analysis has run yet.
     */
    async applyChanges(changed: vscode.Uri[], deleted: vscode.Uri[]): Promise<ArchitectureGraph | undefined> {
        const state = this.state;
        if (!state) return undefined;
        const config = getConfig();
        const languages = new Set(config.includedLanguages);
        const isExcluded = compileGlobs(config.excludePatterns);
        const analyzer = await this.getAnalyzer();
        let dirty = false;

        const relevant = (uri: vscode.Uri): 'source' | 'manifest' | undefined => {
            const rel = toPosix(path.relative(state.root, uri.fsPath));
            if (rel.startsWith('..') || path.isAbsolute(rel) || isExcluded(rel) || rel.split('/').includes('.git')) return undefined;
            if (isManifest(path.basename(uri.fsPath))) return 'manifest';
            const pack = getPackForExtension(path.extname(uri.fsPath));
            return pack && languages.has(pack.id) ? 'source' : undefined;
        };

        for (const uri of deleted) {
            const file = uri.fsPath;
            if (state.analyses.delete(file) || state.manifests.delete(file)) {
                dirty = true;
                continue;
            }
            // Not a known file: maybe a deleted directory, which arrives as one event.
            const prefix = file + path.sep;
            for (const key of [...state.analyses.keys()]) {
                if (key.startsWith(prefix)) {
                    state.analyses.delete(key);
                    dirty = true;
                }
            }
        }

        // Full discovery honours .gitignore; apply the same rule to files that
        // appear later (build output, generated code), or they'd leak in.
        const fresh = changed.filter((u) => !state.analyses.has(u.fsPath) && relevant(u) === 'source');
        const ignored =
            state.discovery.method === 'git' && fresh.length > 0
                ? await gitIgnoredPaths(state.root, fresh.map((u) => toPosix(path.relative(state.root, u.fsPath))))
                : new Set<string>();

        for (const uri of changed) {
            const kind = relevant(uri);
            if (!kind) continue;
            if (ignored.has(toPosix(path.relative(state.root, uri.fsPath)))) continue;
            if (kind === 'manifest') {
                const read = await readManifests([uri.fsPath]);
                const text = read.get(uri.fsPath);
                if (text !== undefined) state.manifests.set(uri.fsPath, text);
                dirty = true;
                continue;
            }
            const isNew = !state.analyses.has(uri.fsPath);
            if (isNew && config.maxFiles > 0 && state.analyses.size >= config.maxFiles) continue;
            const analysis = await analyzer.analyzeFile(uri.fsPath);
            if (analysis) {
                state.analyses.set(uri.fsPath, analysis);
                dirty = true;
            } else if (state.analyses.delete(uri.fsPath)) {
                dirty = true;
            }
        }

        return dirty ? this.buildGraph() : undefined;
    }

    dispose(): void {
        this.analyzer?.dispose();
        this.state = undefined;
    }

    private buildGraph(): ArchitectureGraph {
        const state = this.state!;
        let graph = new GraphBuilder(state.root).build(state.analyses.values(), state.manifests);
        graph = this.inference.inferSubsystems(graph);
        graph.metadata = {
            ...graph.metadata,
            projectId: state.root,
            projectName: path.basename(state.root),
            projectPath: state.root,
            discoveredFiles: state.discovery.discovered,
            ...(state.discovery.truncated ? { truncatedAt: state.discovery.sourceFiles.length } : {}),
        };
        const stats = graph.metadata.parserStats;
        if (stats) stats.skipped = Math.max(0, state.discovery.sourceFiles.length - state.analyses.size);
        return graph;
    }

    private async discover(workspaceUri: vscode.Uri, config: ExtensionConfig): Promise<DiscoveryResult> {
        const options = {
            languages: config.includedLanguages,
            excludePatterns: config.excludePatterns,
            maxFiles: config.maxFiles,
        };
        const viaGit = await discoverWithGit(workspaceUri.fsPath, options);
        if (viaGit) return viaGit;

        // Not a git repo (or no git): let VS Code walk the tree, without a cap.
        const exclude = config.excludePatterns.length > 0 ? `{${config.excludePatterns.join(',')}}` : undefined;
        const uris = await vscode.workspace.findFiles(
            new vscode.RelativePattern(workspaceUri, '**/*'),
            exclude ? new vscode.RelativePattern(workspaceUri, exclude) : undefined
        );
        const relative = uris.map((u) => path.relative(workspaceUri.fsPath, u.fsPath));
        return classifyFiles(workspaceUri.fsPath, relative, options, 'walk');
    }

    private getAnalyzer(): Promise<Analyzer> {
        if (this.analyzer) return Promise.resolve(this.analyzer);
        if (!this.analyzerPromise) {
            this.analyzerPromise = Analyzer.create({
                grammarDir: path.join(this.extensionPath, 'parsers'),
                maxFileSize: getConfig().maxFileSize,
                log: (m) => this.log(m),
            }).then((a) => {
                this.analyzer = a;
                this.log(
                    a.treeSitterAvailable
                        ? `tree-sitter ready; grammars: ${a.availableGrammars().join(', ') || 'none'}`
                        : 'tree-sitter unavailable; using regex fallback for all languages'
                );
                return a;
            });
        }
        return this.analyzerPromise;
    }

    private log(message: string) {
        this.output?.appendLine(`[${new Date().toISOString()}] ${message}`);
    }
}
