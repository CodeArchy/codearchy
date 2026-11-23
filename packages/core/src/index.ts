/**
 * @codearchy/core — the CodeArchy engine. Pure TypeScript behind ports: no
 * Node, DOM or vscode dependency (enforced by this package's compiler
 * settings). Hosts wire it up with platform adapters.
 */
export * from './ports.js';
export { Analyzer, AnalysisCancelledError, readManifests, type AnalyzerOptions, type AnalyzeAllOptions, type AnalyzeProgress } from './analyzer.js';
export { TreeSitterExtractor } from './extract/treeSitter.js';
export { analyzeWithRegex, hasRegexFallback } from './extract/regex.js';
export {
    LANGUAGE_PACKS,
    DEFAULT_LANGUAGE_IDS,
    LANGUAGE_EXTENSIONS,
    getPackForExtension,
    getPackById,
    getLanguageFromExtension,
    grammarFor,
    expandRustUse,
} from './languages/index.js';
export { ImportResolver, parseJsonc } from './resolve/resolver.js';
export { buildGraph, type BuildOptions } from './graph/builder.js';
export { ArchitectureInference, heuristicGroupForPath, tokenizeSegment } from './graph/inference.js';
export { classifyFiles, isManifest, DEFAULT_EXCLUDE_PATTERNS, MANIFEST_FILES, type DiscoveryOptions, type DiscoveryResult } from './discovery/classify.js';
export { compileGlobs, globToRegExp } from './util/glob.js';
export * as posixPath from './util/posixPath.js';
