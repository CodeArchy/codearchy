import * as assert from 'assert';
import * as path from 'path';
import { Analyzer } from '../../analysis/Analyzer';
import { FileAnalysis, SymbolInfo } from '../../model';

export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
export const GRAMMAR_DIR = path.join(REPO_ROOT, 'parsers');
export const FIXTURES = path.join(REPO_ROOT, 'test-fixtures');

let analyzer: Promise<Analyzer> | undefined;

export function getAnalyzer(): Promise<Analyzer> {
    analyzer ??= Analyzer.create({ grammarDir: GRAMMAR_DIR, maxFileSize: 1_000_000 });
    return analyzer;
}

export async function analyzeSource(fileName: string, source: string): Promise<FileAnalysis> {
    const a = await getAnalyzer();
    const result = await a.analyzeFile(path.join('/virtual', fileName), source);
    if (!result) throw new Error(`no analysis for ${fileName}`);
    return result;
}

/** Compact, order-independent view of symbols: `kind name[@container][*]` (* = exported). */
export function describeSymbols(symbols: SymbolInfo[]): string[] {
    return symbols
        .map((s) => `${s.kind} ${s.container ? `${s.container}.` : ''}${s.name}${s.exported ? '*' : ''}`)
        .sort();
}

export function assertSymbols(analysis: FileAnalysis, expected: string[]): void {
    assert.deepStrictEqual(describeSymbols(analysis.symbols), [...expected].sort());
}
