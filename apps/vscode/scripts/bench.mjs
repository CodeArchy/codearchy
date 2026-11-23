#!/usr/bin/env node
/**
 * Benchmarks the analysis core on repositories, outside VS Code.
 *
 *   pnpm --filter codearchy run bench -- <repo-path> [<repo-path>...] [--json] [--unresolved]
 *
 * Reports discovery/parse/graph timings, parser coverage, and how many
 * imports resolved to workspace files (by language). Uses the same packages
 * as the extension (@codearchy/core + @codearchy/platform-node); build them
 * first with `pnpm build`.
 */
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ArchitectureInference, buildGraph, DEFAULT_EXCLUDE_PATTERNS, DEFAULT_LANGUAGE_IDS, ImportResolver, readManifests } from '@codearchy/core';
import { createNodeAnalyzer, discover, fromPosix } from '@codearchy/platform-node';

const args = process.argv.slice(2);
const json = args.includes('--json');
const showUnresolved = args.includes('--unresolved');
const repos = args.filter((a) => !a.startsWith('--'));

async function benchRepo(repo) {
    const root = path.resolve(repo);
    const t0 = performance.now();
    const discovery = await discover(root, { languages: DEFAULT_LANGUAGE_IDS, excludePatterns: DEFAULT_EXCLUDE_PATTERNS, maxFiles: 0 });
    const t1 = performance.now();
    const { analyzer, fs } = await createNodeAnalyzer({ root, maxFileSize: 500_000 });
    const t2 = performance.now();
    const analyses = await analyzer.analyzeAll(discovery.sourceFiles);
    const t3 = performance.now();
    const manifests = await readManifests(fs, discovery.manifests);
    let graph = buildGraph(analyses.values(), manifests, { toHostPath: (p) => fromPosix(root, p) });
    graph = new ArchitectureInference().inferSubsystems(graph);
    const t4 = performance.now();

    const resolver = new ImportResolver(analyses.values(), manifests);
    const perLanguage = {};
    for (const a of analyses.values()) {
        const s = (perLanguage[a.language] ??= { files: 0, symbols: 0, imports: 0, resolved: 0, unresolved: {} });
        s.files++;
        s.symbols += a.symbols.length;
        for (const imp of a.imports) {
            s.imports++;
            if (resolver.resolve(imp, a).length) s.resolved++;
            else s.unresolved[imp.source] = (s.unresolved[imp.source] ?? 0) + 1;
        }
    }
    analyzer.dispose();
    return {
        repo: path.basename(root),
        method: discovery.method,
        files: discovery.sourceFiles.length,
        analyzed: analyses.size,
        parser: graph.metadata.parserStats,
        symbols: graph.metadata.totalSymbols,
        edges: graph.edges.length,
        subsystems: graph.subsystems.length,
        ms: { discovery: Math.round(t1 - t0), init: Math.round(t2 - t1), parse: Math.round(t3 - t2), graph: Math.round(t4 - t3), total: Math.round(t4 - t0) },
        msPerFile: +((t3 - t2) / Math.max(1, analyses.size)).toFixed(2),
        rssMB: Math.round(process.memoryUsage().rss / 1e6),
        perLanguage,
    };
}

function printReport(r) {
    console.log(`\n${r.repo}  (${r.method}, ${r.files} files → ${r.analyzed} analyzed)`);
    console.log(`  parser    tree-sitter ${r.parser.treeSitter}, regex ${r.parser.regex}`);
    console.log(`  time      discovery ${r.ms.discovery}ms · init ${r.ms.init}ms · parse ${r.ms.parse}ms (${r.msPerFile} ms/file) · graph ${r.ms.graph}ms · total ${r.ms.total}ms`);
    console.log(`  graph     ${r.symbols} symbols · ${r.edges} edges · ${r.subsystems} subsystems · rss ${r.rssMB} MB`);
    for (const [lang, s] of Object.entries(r.perLanguage).sort((a, b) => b[1].files - a[1].files)) {
        const pct = s.imports ? ((100 * s.resolved) / s.imports).toFixed(0) : '–';
        console.log(`  ${lang.padEnd(10)} ${String(s.files).padStart(6)} files · ${String(s.symbols).padStart(7)} symbols · imports resolved ${s.resolved}/${s.imports} (${pct}%)`);
        if (showUnresolved) {
            for (const [src, n] of Object.entries(s.unresolved).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`      unresolved ×${n}  ${src}`);
        }
    }
}

if (repos.length === 0) {
    console.error('usage: pnpm --filter codearchy run bench -- <repo-path> [...] [--json] [--unresolved]');
    process.exit(2);
}
const results = [];
for (const repo of repos) results.push(await benchRepo(repo));
if (json) console.log(JSON.stringify(results.map((r) => ({ ...r, perLanguage: Object.fromEntries(Object.entries(r.perLanguage).map(([k, v]) => [k, { ...v, unresolved: undefined }])) })), null, 2));
else results.forEach(printReport);
