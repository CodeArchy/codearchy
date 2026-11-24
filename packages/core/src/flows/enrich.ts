/**
 * Adds the flow facts (entrypoints and call sites) to a file's analysis.
 * Text-based, so they come out the same whichever extractor produced the
 * symbols.
 */
import type { FileAnalysis } from '@codearchy/protocol';
import { extractCalls } from './calls.js';
import { detectEntryPoints } from './entrypoints.js';

export function enrich(analysis: FileAnalysis, source: string): FileAnalysis {
    const calls = extractCalls(source, analysis.language, analysis.symbols);
    const entrypoints = detectEntryPoints(source, analysis);
    return {
        ...analysis,
        ...(entrypoints.length ? { entrypoints } : {}),
        ...(calls.length ? { calls } : {}),
    };
}
