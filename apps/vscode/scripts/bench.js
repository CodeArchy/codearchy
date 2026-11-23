#!/usr/bin/env node
/**
 * Benchmarks the analysis core on a repository, outside VS Code.
 *
 *   npm run bench -- <repo-path> [<repo-path>...] [--json] [--unresolved]
 *
 * Reports discovery/parse/graph timings, parser coverage, and how many
 * imports resolved to workspace files (by language). Requires a prior
 * `npm run compile` and `npm run grammars`.
 */
'use strict';

const path = require('path');
const { performance } = require('perf_hooks');

const ROOT = path.join(__dirname, '..');
const out = (p) => require(path.join(ROOT, 'out', p));

let json = false;

async function benchRepo(repo) {
    const { Analyzer, readManifests } = out('analysis/Analyzer');
    const { discoverWithGit, classifyFiles, DEFAULT_EXCLUDE_PATTERNS } = out('analysis/discovery');
    const { DEFAULT_LANGUAGE_IDS } = out('analysis/languages');
    const { ImportResolver } = out('analysis/resolver');
    const { GraphBuilder } = out('graph/GraphBuilder');
    const { ArchitectureInference } = out('inference/ArchitectureInference');

    const root = path.resolve(repo);
    const options = { languages: DEFAULT_LANGUAGE_IDS, excludePatterns: DEFAULT_EXCLUDE_PATTERNS, maxFiles: 0 };
    const t0 = performance.now();
    let discovery = await discoverWithGit(root, options);
    if (!discovery) {
        const fs = require('fs');
        const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
            e.name === '.git' ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.relative(root, path.join(d, e.name))]);
        discovery = classifyFiles(root, walk(root), options, 'walk');
    }
    const t1 = performance.now();

    const analyzer = await Analyzer.create({ grammarDir: path.join(ROOT, 'parsers'), maxFileSize: 500_000 });
    const t2 = performance.now();
    const analyses = await analyzer.analyzeAll(discovery.sourceFiles);
    const t3 = performance.now();
    const manifests = await readManifests(discovery.manifests);
    let graph = new GraphBuilder(root).build(analyses.values(), manifests);
    graph = new ArchitectureInference().inferSubsystems(graph);
    const t4 = performance.now();

    // Import resolution rate per language. "Local" excludes obvious externals
    // (bare npm names, stdlib-looking Go paths) only where that's knowable.
    const resolver = new ImportResolver(root, analyses.values(), manifests);
    const perLang = {};
    for (const a of analyses.values()) {
        const s = (perLang[a.language] ??= { files: 0, symbols: 0, imports: 0, resolved: 0, unresolved: {} });
        s.files++;
        s.symbols += a.symbols.length;
        for (const imp of a.imports) {
            s.imports++;
            if (resolver.resolve(imp, a).length) s.resolved++;
            else s.unresolved[imp.source] = (s.unresolved[imp.source] ?? 0) + 1;
        }
    }

    analyzer.dispose();
    const mem = process.memoryUsage();
    return {
        repo: path.basename(root),
        method: discovery.method,
        files: discovery.sourceFiles.length,
        analyzed: analyses.size,
        parser: graph.metadata.parserStats,
        symbols: graph.metadata.totalSymbols,
        edges: graph.edges.length,
        subsystems: graph.subsystems.length,
        ms: {
            discovery: Math.round(t1 - t0),
            init: Math.round(t2 - t1),
            parse: Math.round(t3 - t2),
            graph: Math.round(t4 - t3),
            total: Math.round(t4 - t0),
        },
        msPerFile: +((t3 - t2) / Math.max(1, analyses.size)).toFixed(2),
        rssMB: Math.round(mem.rss / 1e6),
        perLanguage: Object.fromEntries(
            Object.entries(perLang).map(([k, v]) => [k, json ? { ...v, unresolved: undefined } : v])
        ),
    };
}

let showUnresolved = false;

function printReport(r) {
    console.log(`\n${r.repo}  (${r.method}, ${r.files} files → ${r.analyzed} analyzed)`);
    console.log(`  parser    tree-sitter ${r.parser.treeSitter}, regex ${r.parser.regex}`);
    console.log(`  time      discovery ${r.ms.discovery}ms · init ${r.ms.init}ms · parse ${r.ms.parse}ms (${r.msPerFile} ms/file) · graph ${r.ms.graph}ms · total ${r.ms.total}ms`);
    console.log(`  graph     ${r.symbols} symbols · ${r.edges} edges · ${r.subsystems} subsystems · rss ${r.rssMB} MB`);
    for (const [lang, s] of Object.entries(r.perLanguage).sort((a, b) => b[1].files - a[1].files)) {
        const pct = s.imports ? ((100 * s.resolved) / s.imports).toFixed(0) : '–';
        console.log(`  ${lang.padEnd(10)} ${String(s.files).padStart(6)} files · ${String(s.symbols).padStart(7)} symbols · imports resolved ${s.resolved}/${s.imports} (${pct}%)`);
        if (showUnresolved) {
            const top = Object.entries(s.unresolved).sort((a, b) => b[1] - a[1]).slice(0, 12);
            for (const [src, n] of top) console.log(`      unresolved ×${n}  ${src}`);
        }
    }
}

async function main() {
    const args = process.argv.slice(2);
    json = args.includes('--json');
    showUnresolved = args.includes('--unresolved');
    const repos = args.filter((a) => !a.startsWith('--'));
    if (repos.length === 0) {
        console.error('usage: npm run bench -- <repo-path> [...] [--json]');
        process.exit(2);
    }
    const results = [];
    for (const repo of repos) results.push(await benchRepo(repo));
    if (json) console.log(JSON.stringify(results, null, 2));
    else results.forEach(printReport);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
