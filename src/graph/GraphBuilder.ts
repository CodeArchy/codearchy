import * as path from 'path';
import {
    FileAnalysis,
    GraphNode,
    GraphEdge,
    NodeType,
    EdgeType,
    ArchitectureGraph,
    GraphMetadata,
} from '../model';
import { ImportResolver, toPosix } from '../analysis/resolver';

export class GraphBuilder {
    constructor(private readonly workspaceRoot: string) {}

    /**
     * Builds the file graph. Node ids are workspace-relative POSIX paths on
     * every OS, so they're stable across machines.
     */
    build(analyses: Iterable<FileAnalysis>, manifests: Map<string, string> = new Map()): ArchitectureGraph {
        const list = [...analyses];
        const resolver = new ImportResolver(this.workspaceRoot, list, manifests);
        const nodes = list.map((a) => this.buildNode(a));
        const edges = this.buildEdges(list, resolver);

        const parserStats = { treeSitter: 0, regex: 0, skipped: 0 };
        for (const a of list) {
            if (a.parser === 'tree-sitter') parserStats.treeSitter++;
            else parserStats.regex++;
        }

        const metadata: GraphMetadata = {
            analyzedAt: Date.now(),
            fileCount: list.length,
            totalSymbols: list.reduce((sum, a) => sum + a.symbols.length, 0),
            totalEdges: edges.length,
            languages: [...new Set(list.map((a) => a.language))],
            parserStats,
        };

        return { nodes, edges, subsystems: [], metadata };
    }

    relativeId(filePath: string): string {
        return toPosix(path.relative(this.workspaceRoot, filePath));
    }

    private buildNode(analysis: FileAnalysis): GraphNode {
        const id = this.relativeId(analysis.filePath);
        return {
            id,
            label: fileLabel(id),
            filePath: analysis.filePath,
            type: NodeType.File,
            symbols: analysis.symbols,
            metadata: {
                language: analysis.language,
                symbolCount: analysis.symbols.length,
                exportCount: analysis.exports.length,
                importCount: analysis.imports.length,
                ...(analysis.namespace ? { namespace: analysis.namespace } : {}),
                parser: analysis.parser,
            },
        };
    }

    private buildEdges(analyses: FileAnalysis[], resolver: ImportResolver): GraphEdge[] {
        const edges = new Map<string, GraphEdge>();

        const add = (source: string, target: string, weight: number, metadata: Record<string, unknown>) => {
            if (source === target) return;
            const key = `${source}:${target}`;
            const existing = edges.get(key);
            if (existing) {
                existing.weight += weight;
                return;
            }
            edges.set(key, { id: key, source, target, type: EdgeType.Import, weight, metadata });
        };

        for (const analysis of analyses) {
            const sourceId = this.relativeId(analysis.filePath);
            for (const imp of analysis.imports) {
                for (const target of resolver.resolve(imp, analysis)) {
                    add(sourceId, this.relativeId(target), imp.specifiers.length || 1, {
                        specifiers: imp.specifiers,
                        importSource: imp.source,
                    });
                }
            }
            for (const target of resolver.implicitDependencies(analysis)) {
                add(sourceId, this.relativeId(target), 1, {
                    specifiers: [],
                    importSource: analysis.namespace ? `(same package ${analysis.namespace})` : '(same package)',
                    implicit: true,
                });
            }
        }
        return [...edges.values()];
    }
}

function fileLabel(relativeId: string): string {
    const parts = relativeId.split('/');
    return parts.length <= 2 ? relativeId : `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}
