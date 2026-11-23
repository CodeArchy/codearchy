/**
 * VS Code composition root for the engine: wires @codearchy/core to the
 * Node adapters (@codearchy/platform-node), maps vscode URIs to the core's
 * workspace-relative POSIX paths, and keeps per-file results so changes on
 * disk are applied incrementally.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    Analyzer,
    AnalysisCancelledError,
    ArchitectureInference,
    buildGraph,
    classifyFiles,
    compileGlobs,
    getPackForExtension,
    isManifest,
    posixPath,
    readManifests,
    type DiscoveryResult,
    type ParserRuntime,
} from '@codearchy/core';
import {
    NodeFileSystem,
    createNodeParserRuntime,
    fromPosix,
    gitIgnoredPaths,
    gitListFiles,
    toPosix,
    yieldToNode,
} from '@codearchy/platform-node';
import { AnalysisProgress, ArchitectureGraph, ExtensionConfig, FileAnalysis, getConfig } from '../types';

/** Per-workspace state kept between analyses so file changes are incremental. Keys are POSIX paths. */
interface WorkspaceState {
    root: string;
    fs: NodeFileSystem;
    analyzer: Analyzer;
    analyses: Map<string, FileAnalysis>;
    manifests: Map<string, string>;
    discovery: DiscoveryResult;
}

export class AnalysisPipeline {
    private parser: ParserRuntime | undefined;
    private parserPromise: Promise<ParserRuntime | undefined> | undefined;
    private readonly inference = new ArchitectureInference();
    private state: WorkspaceState | undefined;
    private readonly parsersDir: string;

    constructor(
        extensionPath: string,
        private readonly output?: vscode.OutputChannel
    ) {
        this.parsersDir = path.join(extensionPath, 'parsers');
    }

    async initParser(): Promise<void> {
        await this.getParser();
    }

    isTreeSitterAvailable(): boolean {
        return !!this.parser;
    }

    /** Parser health, for diagnostics and the extension's smoke tests. */
    async parserStatus(): Promise<{ treeSitter: boolean; grammars: string[] }> {
        const parser = await this.getParser();
        return { treeSitter: !!parser, grammars: this.availableGrammars() };
    }

    async analyze(
        workspaceUri: vscode.Uri,
        onProgress: (progress: AnalysisProgress) => void,
        token: vscode.CancellationToken
    ): Promise<ArchitectureGraph> {
        const config = getConfig();
        const root = workspaceUri.fsPath;
        const fsPort = new NodeFileSystem(root);
        const analyzer = new Analyzer({
            fs: fsPort,
            parser: await this.getParser(),
            maxFileSize: config.maxFileSize,
            log: (m) => this.log(m),
            yieldToHost: yieldToNode,
        });

        onProgress({ phase: 'discovery', current: 0, total: 1, message: 'Discovering files...' });
        const discovery = await this.discover(workspaceUri, config);
        if (token.isCancellationRequested) throw new vscode.CancellationError();
        this.log(
            `discovery (${discovery.method}): ${discovery.sourceFiles.length} source files` +
                (discovery.truncated ? ` of ${discovery.discovered} (limited by codearchy.maxFiles)` : '') +
                `, ${discovery.manifests.length} manifests`
        );

        const manifests = await readManifests(fsPort, discovery.manifests);
        let analyses: Map<string, FileAnalysis>;
        try {
            analyses = await analyzer.analyzeAll(discovery.sourceFiles, {
                isCancelled: () => token.isCancellationRequested,
                onProgress: ({ current, total, file }) => {
                    // Reporting every file floods the progress UI; every 1% is plenty.
                    if (current === total || current % Math.max(1, Math.floor(total / 100)) === 0) {
                        onProgress({ phase: 'parsing', current, total, message: `Parsing: ${file}` });
                    }
                },
            });
        } catch (err) {
            if (err instanceof AnalysisCancelledError) throw new vscode.CancellationError();
            throw err;
        }

        this.state = { root, fs: fsPort, analyzer, analyses, manifests, discovery };
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
        let dirty = false;

        const rel = (uri: vscode.Uri): string | undefined => toPosix(state.root, uri.fsPath) || undefined;
        const relevant = (p: string): 'source' | 'manifest' | undefined => {
            if (isExcluded(p) || p.split('/').includes('.git')) return undefined;
            if (isManifest(posixPath.basename(p))) return 'manifest';
            const pack = getPackForExtension(posixPath.extname(p));
            return pack && languages.has(pack.id) ? 'source' : undefined;
        };

        for (const uri of deleted) {
            const p = rel(uri);
            if (!p) continue;
            if (state.analyses.delete(p) || state.manifests.delete(p)) {
                dirty = true;
                continue;
            }
            // Not a known file: maybe a deleted directory, which arrives as one event.
            for (const key of [...state.analyses.keys()]) {
                if (key.startsWith(`${p}/`)) {
                    state.analyses.delete(key);
                    dirty = true;
                }
            }
        }

        const changedPaths = changed.map(rel).filter((p): p is string => !!p);
        // Full discovery honours .gitignore; apply the same rule to files that
        // appear later (build output, generated code), or they'd leak in.
        const fresh = changedPaths.filter((p) => !state.analyses.has(p) && relevant(p) === 'source');
        const ignored =
            state.discovery.method === 'git' && fresh.length > 0 ? await gitIgnoredPaths(state.root, fresh) : new Set<string>();

        for (const p of changedPaths) {
            const kind = relevant(p);
            if (!kind || ignored.has(p)) continue;
            if (kind === 'manifest') {
                const text = (await readManifests(state.fs, [p])).get(p);
                if (text !== undefined) state.manifests.set(p, text);
                dirty = true;
                continue;
            }
            const isNew = !state.analyses.has(p);
            if (isNew && config.maxFiles > 0 && state.analyses.size >= config.maxFiles) continue;
            const analysis = await state.analyzer.analyzeFile(p);
            if (analysis) {
                state.analyses.set(p, analysis);
                dirty = true;
            } else if (state.analyses.delete(p)) {
                dirty = true;
            }
        }

        return dirty ? this.buildGraph() : undefined;
    }

    dispose(): void {
        this.parser?.dispose();
        this.parser = undefined;
        this.state = undefined;
    }

    private buildGraph(): ArchitectureGraph {
        const state = this.state!;
        let graph = buildGraph(state.analyses.values(), state.manifests, { toHostPath: (p) => fromPosix(state.root, p) });
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
        const root = workspaceUri.fsPath;
        const viaGit = await gitListFiles(root);
        if (viaGit) return classifyFiles(viaGit, options, 'git');

        // Not a git repo (or no git): let VS Code walk the tree, without a cap.
        const exclude = config.excludePatterns.length > 0 ? `{${config.excludePatterns.join(',')}}` : undefined;
        const uris = await vscode.workspace.findFiles(
            new vscode.RelativePattern(workspaceUri, '**/*'),
            exclude ? new vscode.RelativePattern(workspaceUri, exclude) : undefined
        );
        const relative = uris.map((u) => toPosix(root, u.fsPath)).filter((p): p is string => !!p);
        return classifyFiles(relative, options, 'walk');
    }

    /** The tree-sitter runtime + grammars bundled in parsers/ (shared by all workspaces). */
    private getParser(): Promise<ParserRuntime | undefined> {
        if (!this.parserPromise) {
            this.parserPromise = createNodeParserRuntime(
                {
                    grammarDir: this.parsersDir,
                    runtimeWasmPath: path.join(this.parsersDir, 'web-tree-sitter.wasm'),
                },
                (m) => this.log(m)
            ).then((parser) => {
                this.parser = parser;
                this.log(
                    parser
                        ? `tree-sitter ready; grammars: ${this.availableGrammars().join(', ') || 'none'}`
                        : 'tree-sitter unavailable; using regex fallback for all languages'
                );
                return parser;
            });
        }
        return this.parserPromise;
    }

    private availableGrammars(): string[] {
        try {
            return fs.readdirSync(this.parsersDir).filter((f) => f.startsWith('tree-sitter-') && f.endsWith('.wasm'));
        } catch {
            return [];
        }
    }

    private log(message: string) {
        this.output?.appendLine(`[${new Date().toISOString()}] ${message}`);
    }
}
