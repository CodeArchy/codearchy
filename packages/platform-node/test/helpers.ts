import * as assert from 'node:assert';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Analyzer } from '@codearchy/core';
import type { FileAnalysis, SymbolInfo } from '@codearchy/protocol';
import { createNodeAnalyzer } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(here, '..', '..', '..', 'fixtures');

let analyzer: Promise<Analyzer> | undefined;

/** One shared analyzer (tree-sitter runtime + grammars load once). */
export function getAnalyzer(): Promise<Analyzer> {
    analyzer ??= createNodeAnalyzer({ root: FIXTURES, maxFileSize: 1_000_000 }).then((r) => r.analyzer);
    return analyzer;
}

export async function analyzeSource(fileName: string, source: string): Promise<FileAnalysis> {
    const result = await (await getAnalyzer()).analyzeFile(`virtual/${fileName}`, source);
    if (!result) throw new Error(`no analysis for ${fileName}`);
    return result;
}

/** Compact, order-independent view of symbols: `kind name[@container][*]` (* = exported). */
export function describeSymbols(symbols: SymbolInfo[]): string[] {
    return symbols.map((s) => `${s.kind} ${s.container ? `${s.container}.` : ''}${s.name}${s.exported ? '*' : ''}`).sort();
}

export function assertSymbols(analysis: FileAnalysis, expected: string[]): void {
    assert.deepStrictEqual(describeSymbols(analysis.symbols), [...expected].sort());
}
