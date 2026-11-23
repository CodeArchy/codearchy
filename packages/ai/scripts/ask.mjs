#!/usr/bin/env node
/**
 * Manual check (never run in CI): index a folder and ask the grounded chat a
 * question with a real model, printing the status lines, the answer and its
 * citations.
 *
 *   OLLAMA_MODEL=… node packages/ai/scripts/ask.mjs <folder> "question" [tier]
 *   ANTHROPIC_API_KEY=… ANTHROPIC_MODEL=… node packages/ai/scripts/ask.mjs <folder> "question" excerpts
 *
 * Build first: pnpm --filter "@codearchy/ai..." build
 */
import * as path from 'node:path';
import { readFile } from 'node:fs/promises';
import { buildGraph, buildHierarchy, classifyFiles, DEFAULT_EXCLUDE_PATTERNS, DEFAULT_LANGUAGE_IDS, HierarchyIndex, readManifests } from '@codearchy/core';
import { createNodeAnalyzer, fromPosix, walkFiles } from '@codearchy/platform-node';
import { anthropic, ollama, ProviderRegistry } from '@codearchy/providers';
import { GroundedChat, NodeSearch, Summarizer } from '../dist/index.js';

const [, , folder = '.', question = 'What are the main parts of this codebase?', tier = 'structure'] = process.argv;
const root = path.resolve(folder);
const env = process.env;
const adapters = [];
if (env.OLLAMA_MODEL) adapters.push(ollama({ baseUrl: env.OLLAMA_HOST }));
if (env.ANTHROPIC_API_KEY) adapters.push(anthropic({ apiKey: env.ANTHROPIC_API_KEY }));
if (!adapters.length) {
    console.log('Set OLLAMA_MODEL or ANTHROPIC_API_KEY (see the header of this file).');
    process.exit(0);
}

const discovery = classifyFiles(await walkFiles(root), { languages: DEFAULT_LANGUAGE_IDS, excludePatterns: DEFAULT_EXCLUDE_PATTERNS, maxFiles: 0 }, 'walk');
const { analyzer, fs } = await createNodeAnalyzer({ root, maxFileSize: 1_000_000 });
const analyses = await analyzer.analyzeAll(discovery.sourceFiles);
const graph = buildGraph(analyses.values(), await readManifests(fs, discovery.manifests), { toHostPath: (p) => fromPosix(root, p) });
const index = new HierarchyIndex(buildHierarchy(graph, { systemName: path.basename(root) }));
const read = (p) => readFile(fromPosix(root, p), 'utf8').catch(() => undefined);

const registry = new ProviderRegistry(adapters, { policy: { tier }, defaults: { ollama: env.OLLAMA_MODEL, anthropic: env.ANTHROPIC_MODEL } });
await registry.refresh();
const target = registry.resolve('chat');
console.log(`chat: ${target.ok ? `${target.provider} · ${target.model}` : target.reason}; tier ${tier}\n`);

// Deterministic cards only (no AI calls) give the chat summaries to work from.
const cards = new Summarizer({ index, readFile: read });
const cardFor = (k) => cards.card(k);
const chat = new GroundedChat({ index, readFile: read, registry, cards: cardFor, search: await NodeSearch.withCards(index, cardFor) });
const t = Date.now();
for await (const e of chat.ask(question)) {
    if (e.type === 'status') console.log(`  … ${e.text}`);
    else if (e.type === 'action') console.log(`  [Show me: ${e.action.action} ${e.action.keys.join(', ')}]`);
    else if (e.type === 'error') console.log(`✗ ${e.error.code}: ${e.error.message}`);
    else if (e.type === 'done') {
        console.log(`\n${e.answer}\n`);
        console.log(`citations: ${e.citations.map((c) => (c.type === 'node' ? c.key : `${c.path}${c.startLine ? `#L${c.startLine}` : ''}`)).join(', ') || 'none'}; invalid: ${e.invalidCitations}`);
        console.log(`${e.mode}, ${e.rounds} rounds, ${e.usage.inputTokens} in / ${e.usage.outputTokens} out, ${((Date.now() - t) / 1000).toFixed(1)} s`);
    }
}
