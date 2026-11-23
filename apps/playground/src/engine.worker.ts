/**
 * The playground's engine: the shared browser engine (runEngineWorker from
 * @codearchy/platform-browser/engine, the same one the web app runs) plus two
 * debug requests for the playground's tabs: `debug` (stats, files, edges,
 * unresolved imports, the hierarchy tree) and `file` (one file's details).
 */
import { runEngineWorker, type EngineWorkspace } from '@codearchy/platform-browser/engine';
import type { FileDetail, Summary, TreeRow, Unresolved } from './protocol.js';

/** Rows sent to the UI per list; the counts are always exact. */
const LIST_LIMIT = 20_000;

function dependentsOf(ws: EngineWorkspace): Map<string, string[]> {
    const dependents = new Map<string, string[]>();
    for (const e of ws.graph.edges) {
        const list = dependents.get(e.target) ?? [];
        list.push(e.source);
        dependents.set(e.target, list);
    }
    return dependents;
}

function debug(ws: EngineWorkspace): Summary {
    const out = new Map<string, number>();
    for (const e of ws.graph.edges) out.set(e.source, (out.get(e.source) ?? 0) + 1);
    const dependents = dependentsOf(ws);

    const unresolved: Unresolved[] = [];
    let unresolvedCount = 0;
    let importCount = 0;
    const languages: Record<string, number> = {};
    for (const a of ws.analyses.values()) {
        languages[a.language] = (languages[a.language] ?? 0) + 1;
        for (const imp of a.imports) {
            importCount++;
            if (ws.resolver.resolve(imp, a).length > 0) continue;
            unresolvedCount++;
            if (unresolved.length < LIST_LIMIT) unresolved.push({ file: a.filePath, source: imp.source, line: imp.line });
        }
    }

    const started = Date.now();
    const hierarchy = ws.hierarchy.hierarchy;
    const hierarchyMs = Date.now() - started;
    // Symbols are leaves, so dropping them keeps DFS pre-order; parents are re-indexed.
    const tree: TreeRow[] = [];
    const rowOf = new Map<number, number>();
    for (const n of hierarchy.nodes) {
        if (n.kind === 'symbol') continue;
        rowOf.set(n.tin, tree.length);
        tree.push({
            key: n.key,
            kind: n.kind,
            name: n.name,
            path: n.path,
            parent: n.parent < 0 ? -1 : rowOf.get(n.parent)!,
            modules: n.modules,
            // A file's role inherited from a folder above only repeats that folder: show own evidence only.
            ...(n.role && (n.kind !== 'module' || n.role.confidence >= 0.8) ? { role: n.role.role, roleReason: `${n.role.reason} (confidence ${n.role.confidence})` } : {}),
            ...(n.virtual ? { virtual: true } : {}),
        });
    }

    return {
        name: ws.name,
        storage: ws.storage,
        discovered: ws.discovery.discovered,
        stats: {
            files: ws.analyses.size,
            symbols: ws.graph.metadata.totalSymbols,
            edges: ws.graph.edges.length,
            imports: importCount,
            unresolved: unresolvedCount,
            components: tree.filter((r) => r.kind === 'component').length,
            hierarchyMs,
            parsed: ws.stats.parsed,
            reused: ws.stats.reused,
            unchanged: ws.stats.unchanged,
            removed: ws.stats.removed,
            workers: ws.workers,
            durationMs: ws.stats.durationMs,
        },
        languages,
        files: [...ws.analyses.values()].slice(0, LIST_LIMIT).map((a) => ({
            path: a.filePath,
            language: a.language,
            symbols: a.symbols.length,
            imports: a.imports.length,
            out: out.get(a.filePath) ?? 0,
            in: dependents.get(a.filePath)?.length ?? 0,
        })),
        edges: ws.graph.edges.slice(0, LIST_LIMIT).map((e): [string, string] => [e.source, e.target]),
        unresolved,
        tree,
    };
}

function fileDetail(ws: EngineWorkspace, path: string): FileDetail | undefined {
    const a = ws.analyses.get(path);
    if (!a) return undefined;
    return {
        path,
        language: a.language,
        parser: a.parser,
        namespace: a.namespace,
        symbols: a.symbols,
        imports: a.imports.map((imp) => ({ source: imp.source, line: imp.line, targets: ws.resolver.resolve(imp, a) })),
        implicit: ws.resolver.implicitDependencies(a),
        dependents: [...(dependentsOf(ws).get(path) ?? [])].sort(),
    };
}

runEngineWorker({
    parseWorkerUrl: new URL('parse.worker.js', self.location.href).href,
    poolName: 'codearchy-playground',
    handlers: {
        debug: (ws) => debug(ws),
        file: (ws, params) => fileDetail(ws, String(params.path ?? '')),
        // Smoke test for host events: streams the workspace name back as events, then answers.
        echoEvents: (ws, params, ctx) => {
            const n = Math.min(5, Number(params.count ?? 3));
            for (let i = 1; i <= n; i++) ctx.emit({ type: 'echo', i, workspace: ws.name });
            return { sent: n };
        },
    },
});
