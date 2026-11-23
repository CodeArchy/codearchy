#!/usr/bin/env node
/**
 * Manual check (never run in CI): index a folder, then write summary cards for
 * it with a real model and print them, children before parents.
 *
 *   OLLAMA_MODEL=gemma4:e2b node packages/ai/scripts/live.mjs <folder> [maxCalls]
 *   ANTHROPIC_API_KEY=… ANTHROPIC_MODEL=… node packages/ai/scripts/live.mjs <folder>
 *
 * Build first: pnpm --filter @codearchy/ai... build
 */
import * as path from 'node:path';
import { readFile } from 'node:fs/promises';
import { buildGraph, buildHierarchy, classifyFiles, DEFAULT_EXCLUDE_PATTERNS, DEFAULT_LANGUAGE_IDS, HierarchyIndex, readManifests } from '@codearchy/core';
import { createNodeAnalyzer, fromPosix, walkFiles } from '@codearchy/platform-node';
import { anthropic, ollama, ProviderRegistry } from '@codearchy/providers';
import { Summarizer } from '../dist/index.js';

const root = path.resolve(process.argv[2] ?? '.');
const maxCalls = Number(process.argv[3] ?? 60);
const env = process.env;
const adapters = [];
if (env.OLLAMA_MODEL) adapters.push(ollama({ baseUrl: env.OLLAMA_HOST }));
if (env.ANTHROPIC_API_KEY) adapters.push(anthropic({ apiKey: env.ANTHROPIC_API_KEY }));
if (!adapters.length) {
    console.log('Set OLLAMA_MODEL or ANTHROPIC_API_KEY (see the header of this file).');
    process.exit(0);
}
const defaults = { ollama: env.OLLAMA_MODEL, anthropic: env.ANTHROPIC_MODEL };

const discovery = classifyFiles(await walkFiles(root), { languages: DEFAULT_LANGUAGE_IDS, excludePatterns: DEFAULT_EXCLUDE_PATTERNS, maxFiles: 0 }, 'walk');
const { analyzer, fs } = await createNodeAnalyzer({ root, maxFileSize: 1_000_000 });
const analyses = await analyzer.analyzeAll(discovery.sourceFiles);
const graph = buildGraph(analyses.values(), await readManifests(fs, discovery.manifests), { toHostPath: (p) => fromPosix(root, p) });
const index = new HierarchyIndex(buildHierarchy(graph, { systemName: path.basename(root) }));

const registry = new ProviderRegistry(adapters, { policy: { tier: 'structure' }, defaults });
await registry.refresh();
for (const role of ['summarizer', 'architect']) {
    const r = registry.resolve(role);
    console.log(`${role}: ${r.ok ? `${r.provider} · ${r.model} (${r.why})` : r.reason}`);
}

const summarizer = new Summarizer({
    index,
    registry,
    readFile: (p) => readFile(fromPosix(root, p), 'utf8').catch(() => undefined),
});
const t = Date.now();
const result = await summarizer.crawl(['sys:root'], {
    maxCalls,
    onCard: (c) => {
        const node = index.node(c.key);
        console.log(`\n${'  '.repeat(node.depth)}${c.key}  [${c.source}${c.model ? ` ${c.model}` : ''}, ${c.confidence}]`);
        console.log(`${'  '.repeat(node.depth)}  ${c.title} — ${c.purpose}`);
        if (c.risks.length) console.log(`${'  '.repeat(node.depth)}  risks: ${c.risks.join('; ')}`);
        if (c.note) console.log(`${'  '.repeat(node.depth)}  note: ${c.note}`);
    },
});
console.log(`\n${JSON.stringify(result)} in ${((Date.now() - t) / 1000).toFixed(1)} s; audit: ${(await registry.auditLog().entries()).length} entries`);
