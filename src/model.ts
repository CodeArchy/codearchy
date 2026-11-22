/**
 * Host-agnostic data model shared by the analysis core, the extension host and
 * (by hand, for now) the webview. Must not import `vscode` so the analysis core
 * can run and be tested in plain Node.
 */

export interface SymbolInfo {
    name: string;
    kind: SymbolKind;
    filePath: string;
    startLine: number;
    endLine: number;
    exported: boolean;
    /** Enclosing type for members (e.g. the class that owns a method). */
    container?: string;
}

export enum SymbolKind {
    Function = 'function',
    Class = 'class',
    Interface = 'interface',
    Variable = 'variable',
    Type = 'type',
    Enum = 'enum',
    Module = 'module',
    Method = 'method',
}

export interface ImportInfo {
    source: string;
    specifiers: string[];
    isDefault: boolean;
    isNamespace: boolean;
    filePath: string;
    /** 0-based line of the import statement, when known. */
    line?: number;
}

export interface FileAnalysis {
    filePath: string;
    language: string;
    symbols: SymbolInfo[];
    imports: ImportInfo[];
    exports: string[];
    /** Package / namespace the file declares (Java, Kotlin, C#, PHP, Go). */
    namespace?: string;
    /** Distinct identifiers referenced in the file. Used to narrow package-level
     *  imports (Java wildcards, C# usings, Go packages) to the files actually used. */
    references?: string[];
    /** Which extractor produced this analysis. */
    parser?: 'tree-sitter' | 'regex';
}

export interface GraphNode {
    id: string;
    label: string;
    filePath: string;
    type: NodeType;
    symbols: SymbolInfo[];
    group?: string;
    metadata: Record<string, unknown>;
}

export enum NodeType {
    File = 'file',
    Module = 'module',
    Subsystem = 'subsystem',
}

export interface GraphEdge {
    id: string;
    source: string;
    target: string;
    type: EdgeType;
    weight: number;
    metadata: Record<string, unknown>;
}

export enum EdgeType {
    Import = 'import',
    Export = 'export',
    Dependency = 'dependency',
    Composition = 'composition',
}

export interface ArchitectureGraph {
    nodes: GraphNode[];
    edges: GraphEdge[];
    subsystems: SubsystemInfo[];
    metadata: GraphMetadata;
}

export interface SubsystemInfo {
    id: string;
    name: string;
    description: string;
    nodeIds: string[];
    color: string;
}

export interface GraphMetadata {
    analyzedAt: number;
    fileCount: number;
    totalSymbols: number;
    totalEdges: number;
    languages: string[];
    /** Stable identity for persistence (workspace absolute path). */
    projectId?: string;
    /** Display name for the project (usually folder basename). */
    projectName?: string;
    /** Absolute filesystem path of the workspace root. */
    projectPath?: string;
    /** How many files each extractor handled. */
    parserStats?: { treeSitter: number; regex: number; skipped: number };
    /** Set when discovery stopped at `codearchy.maxFiles`. */
    truncatedAt?: number;
    /** Total matching files found before any truncation. */
    discoveredFiles?: number;
}

export interface WebviewMessage {
    type: WebviewMessageType;
    payload: unknown;
}

export enum WebviewMessageType {
    Ready = 'ready',
    GraphData = 'graphData',
    NodeSelected = 'nodeSelected',
    RefreshRequest = 'refreshRequest',
    AnalysisProgress = 'analysisProgress',
    AnalysisComplete = 'analysisComplete',
    Error = 'error',
    NavigateToFile = 'navigateToFile',
    FilterChanged = 'filterChanged',
    ExportSVG = 'exportSVG',
    ExportPNG = 'exportPNG',
    ExportResult = 'exportResult',
    SwitchView = 'switchView',
    // AI Model & System Architecture
    RequestModelStatus = 'requestModelStatus',
    ModelStatus = 'modelStatus',
    SelectModel = 'selectModel',
    GenerateSystemArch = 'generateSystemArch',
    SystemArchData = 'systemArchData',
    SystemArchProgress = 'systemArchProgress',
    /** Host → webview: raw model output streamed token-by-token while the
     *  architecture is being generated. Surfaces progress to the user. */
    SystemArchStream = 'systemArchStream',
    /** Webview → host: switch the AI processing tier (fast/moderate/indepth). */
    SetProcessingMode = 'setProcessingMode',
    // Model pull / delete management
    /** Webview → host: begin downloading a model via `ollama pull`. */
    PullModel = 'pullModel',
    /** Host → webview: streaming download progress. */
    PullModelProgress = 'pullModelProgress',
    /** Host → webview: pull completed (success or failure). */
    PullModelComplete = 'pullModelComplete',
    /** Webview → host: abort an in-progress download. */
    CancelPull = 'cancelPull',
    /** Webview → host: remove an installed model from Ollama. */
    DeleteModel = 'deleteModel',
    /** Host → webview: result of a model deletion. */
    DeleteModelResult = 'deleteModelResult',
    // Chat / Conversation
    ChatMessage = 'chatMessage',
    ChatResponse = 'chatResponse',
    ChatChunk = 'chatChunk',
    ChatThinking = 'chatThinking',
    ClearChat = 'clearChat',
    /** Webview → host: replace the host-side conversation history so the LLM
     *  context window matches the persisted DexieJS store after a delete. */
    SyncChatHistory = 'syncChatHistory',
    /** Webview → host: push a cached system architecture (loaded from IndexedDB)
     *  to the extension host so the chat context is correct even after a
     *  webview reload — without needing to re-run AI generation. */
    SyncSystemArch = 'syncSystemArch',
    // Voice input (extension-host capture)
    StartVoiceRecording = 'startVoiceRecording',
    StopVoiceRecording = 'stopVoiceRecording',
    VoiceRecordingState = 'voiceRecordingState',
    VoiceTranscript = 'voiceTranscript',
    // Narrator (story-player timeline generation)
    /** Webview → host: silently produce a narrator timeline for the given
     *  assistant response. The host streams back a NarratorGenerated payload
     *  when ready — never blocking the chat UI. */
    GenerateNarrator = 'generateNarrator',
    NarratorGenerated = 'narratorGenerated',
    /** Webview → host: persist voice configuration (e.g. kokoroActivated) in
     *  extension-host globalState so it survives full webview reloads. */
    VoiceConfigPersist = 'voiceConfigPersist',
    // GPU model on-demand download (model.onnx, ~310 MB FP32 WebGPU)
    /** Webview → host: GPU detected but model.onnx absent — begin download. */
    DownloadGpuModel = 'downloadGpuModel',
    /** Host → webview: streaming byte-level download progress. */
    GpuModelDownloadProgress = 'gpuModelDownloadProgress',
    /** Host → webview: download finished (success or failure). */
    GpuModelDownloadComplete = 'gpuModelDownloadComplete',
    /** Webview → host: user cancelled an in-progress GPU model download. */
    CancelGpuModelDownload = 'cancelGpuModelDownload',
    /** Webview → host: Kokoro engine loaded successfully — persist flag so next
     *  VS Code session can auto-start without the activation prompt. */
    PersistKokoroActivated = 'persistKokoroActivated',
}

export interface AnalysisProgress {
    phase: string;
    current: number;
    total: number;
    message: string;
}
