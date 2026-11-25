/**
 * The data model comes from @codearchy/protocol (shared by every host and the
 * UI). The v1 webview message protocol below is specific to this extension and
 * is replaced by the typed RPC protocol later in Phase 1.
 */
export * from '@codearchy/protocol';

export interface WebviewMessage {
    type: WebviewMessageType;
    payload: unknown;
}

export enum WebviewMessageType {
    Ready = 'ready',
    /** New UI ↔ engine: { id, method, params } / { id, result?, error? }. */
    EngineRequest = 'engineRequest',
    EngineResponse = 'engineResponse',
    /** Open a workspace-relative file: { path, line? }. */
    OpenWorkspaceFile = 'openWorkspaceFile',
    /** Switch between the new Map and the classic views: { ui: 'map' | 'classic' }. */
    SetUi = 'setUi',
    /** Host → new UI: show this node on the Map: { key }. */
    RevealNode = 'revealNode',
    /** New UI ↔ settings: { id, method: 'get' | 'update' | 'open', params } / { id, result?, error? }. */
    SettingsRequest = 'settingsRequest',
    SettingsResponse = 'settingsResponse',
    /** Host → new UI: a codearchy.* setting changed (anywhere): refresh the Settings panel. */
    SettingsChanged = 'settingsChanged',
    /** New UI ↔ AI host: { id, method, params } / { id, result?, error? } (AiClient methods). */
    AiRequest = 'aiRequest',
    AiResponse = 'aiResponse',
    /** New UI → AI host: ask in a conversation: { conversation, question, selection? }. */
    AiAsk = 'aiAsk',
    /** AI host → new UI: one chat event: { conversation, event }. */
    AiChatEvent = 'aiChatEvent',
    /** AI host → new UI: state changes, new cards, previews: { event }. */
    AiEvent = 'aiEvent',
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
