/**
 * @codearchy/core — the CodeArchy engine. Pure TypeScript behind ports: no
 * Node, DOM or vscode dependency (enforced by this package's compiler
 * settings). Hosts wire it up with platform adapters.
 */
export * from './ports.js';
export {
    Analyzer,
    AnalysisCancelledError,
    readManifests,
    type AnalyzerOptions,
    type AnalyzeAllOptions,
    type AnalyzeProgress,
    type AnalyzeJob,
    type AnalyzeResult,
    type FileState,
} from './analyzer.js';
export { IndexStore, FACTS_VERSION, SCHEMA_VERSION, type StoredFileState, type SymbolHit } from './index/store.js';
export { Indexer, LocalExecutor, type AnalyzeExecutor, type ExecutorOptions, type IndexProgress, type IndexResult, type IndexRunOptions, type IndexStats, type IndexerOptions } from './index/indexer.js';
export { contentHash } from './util/hash.js';
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
export { buildGraph, MAX_EDGE_EVIDENCE, type BuildOptions, type EdgeEvidence } from './graph/builder.js';
export { buildHierarchy, type HierarchyOptions } from './hierarchy/build.js';
export { HierarchyIndex, neighbourhood, DEFAULT_VIEW_BUDGET } from './hierarchy/project.js';
export { computeMetrics, tarjan, HUB_DEGREE, type HierarchyMetrics, type ModuleFacts } from './hierarchy/metrics.js';
export { detectCommunities, type WeightedEdge } from './hierarchy/cluster.js';
export { roleOfComponent, roleOfModule, roleOfName } from './hierarchy/roles.js';
export { ArchitectureInference, heuristicGroupForPath, tokenizeSegment } from './graph/inference.js';
export { classifyFiles, isManifest, isPackageMarker, isTourFile, TOURS_DIR, DEFAULT_EXCLUDE_PATTERNS, MANIFEST_FILES, type DiscoveryOptions, type DiscoveryResult } from './discovery/classify.js';
export { FlowIndex, FLOW_LIMITS, lastSegment } from './flows/trace.js';
export { displayName, generateStartHere, START_HERE_ID, type StartHereOptions } from './tours/startHere.js';
export { classifyCommit, subjectOf, type AuthorshipRule, type CommitAttribution, type CommitInfo } from './authorship/commits.js';
export { AuthorshipIndex, emptyCounts, rangesFromBlame, total as authorshipTotal, weekOf, type AttributedCommit, type AuthorshipData, type FileOwner } from './authorship/index.js';
export { lineCount } from './flows/enrich.js';
export { addCounts, countLines, newDependencies, partLabel, partOf, renderBranchReport } from './authorship/report.js';
export { NOTES_REF, NOTE_VERSION, parseNote, projectNotes, serializeNote, type AuthorshipNote, type BlameRun, type NoteRange } from './authorship/notes.js';
export { matchEdits, parseAider, parseApplyPatch, parseClaudeCode, parseCodex, type AgentEdit, type AgentId, type ParseResult } from './authorship/agentLogs.js';
export { AuthorshipLedger, markLines, overlayRanges, withLedger, LEDGER_VERSION, type LedgerFile, type LedgerRange, type LedgerSource, type LineEdit } from './authorship/ledger.js';
export { TourIndex, anchorFor, anchorTour, parseTour, serializeTour, slugify, tourSlug, type TourParse, type TourSources } from './tours/tours.js';
export { detectEntryPoints, isTestPath, blockEnd } from './flows/entrypoints.js';
export { extractCalls } from './flows/calls.js';
export { enrich } from './flows/enrich.js';
export { compileGlobs, globToRegExp } from './util/glob.js';
export * as posixPath from './util/posixPath.js';
export { architectureCandidates, buildArchitecture, type ArchitectureCandidate, type ArchitectureFlows } from './architecture.js';
