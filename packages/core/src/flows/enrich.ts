/**
 * Adds the flow facts (entrypoints and call sites) to a file's analysis.
 * Text-based, so they come out the same whichever extractor produced the
 * symbols.
 */
import type { FileAnalysis } from '@codearchy/protocol';
import { extractCalls } from './calls.js';
import { detectEntryPoints } from './entrypoints.js';

/** Lines as an editor counts them (a trailing newline doesn't start another line). */
export function lineCount(source: string): number {
    if (!source) return 0;
    let n = 1;
    for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) n++;
    return source.charCodeAt(source.length - 1) === 10 ? n - 1 : n;
}

export function enrich(analysis: FileAnalysis, source: string): FileAnalysis {
    const calls = extractCalls(source, analysis.language, analysis.symbols);
    const entrypoints = detectEntryPoints(source, analysis);
    return {
        ...analysis,
        ...(entrypoints.length ? { entrypoints } : {}),
        ...(calls.length ? { calls } : {}),
        lines: lineCount(source),
    };
}
