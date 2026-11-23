/**
 * Builds the file dependency graph from per-file analyses. Node ids are the
 * workspace-relative POSIX paths, so they're stable across machines and OSes.
 */
import { EdgeType, NodeType, type ArchitectureGraph, type FileAnalysis, type GraphEdge, type GraphMetadata, type GraphNode } from '@codearchy/protocol';
import { ImportResolver } from '../resolve/resolver.js';

export interface BuildOptions {
    /** Maps a workspace path to the host's path for "open file" (default: identity). */
    toHostPath?: (path: string) => string;
}

export function buildGraph(
    analyses: Iterable<FileAnalysis>,
    manifests: Map<string, string> = new Map(),
    options: BuildOptions = {}
): ArchitectureGraph {
    const list = [...analyses];
    const toHostPath = options.toHostPath ?? ((p: string) => p);
    const resolver = new ImportResolver(list, manifests);
    const nodes = list.map((a) => buildNode(a, toHostPath));
    const edges = buildEdges(list, resolver);

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

function buildNode(a: FileAnalysis, toHostPath: (p: string) => string): GraphNode {
    return {
        id: a.filePath,
        label: fileLabel(a.filePath),
        filePath: toHostPath(a.filePath),
        type: NodeType.File,
        symbols: a.symbols,
        metadata: {
            language: a.language,
            symbolCount: a.symbols.length,
            exportCount: a.exports.length,
            importCount: a.imports.length,
            ...(a.namespace ? { namespace: a.namespace } : {}),
            parser: a.parser,
        },
    };
}

function buildEdges(analyses: FileAnalysis[], resolver: ImportResolver): GraphEdge[] {
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
    for (const a of analyses) {
        for (const imp of a.imports) {
            for (const target of resolver.resolve(imp, a)) {
                add(a.filePath, target, imp.specifiers.length || 1, { specifiers: imp.specifiers, importSource: imp.source });
            }
        }
        for (const target of resolver.implicitDependencies(a)) {
            add(a.filePath, target, 1, {
                specifiers: [],
                importSource: a.namespace ? `(same package ${a.namespace})` : '(same package)',
                implicit: true,
            });
        }
    }
    return [...edges.values()];
}

function fileLabel(id: string): string {
    const parts = id.split('/');
    return parts.length <= 2 ? id : `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}
