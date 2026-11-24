/**
 * @codearchy/ui — CodeArchy's shared UI. Hosts render <CodeArchyMap> with an
 * EngineClient (their transport to the engine) and import
 * `@codearchy/ui/styles.css`.
 */
export { CodeArchyMap, type CodeArchyMapProps } from './CodeArchyMap.js';
export type { EngineClient, HostActions, SearchResult } from './client.js';
export { buildMapModel, neighbourhood, strokeWidthFor, visibleEdges, DEFAULT_EDGE_LIMIT, lensBadge, matrixOrder, heatStep, flowRoles, revealPlan, LENSES, AUTHORSHIP_ORIGINS, agentName, authorshipShares, type FlowRoles, type LensId, type LensBadge, type MatrixOrder, externalId, keyOfExternal, type MapModel, type MapNode, type MapEdge } from './model.js';
export { LayoutEngine, toElkGraph, fromElkGraph, type Layout, type Box } from './layout.js';
export { AiSettingsPanel, Answer, CardSection, ChatPanel, PreviewDialog, type AnswerLinks, type ChatPanelProps } from './ai.js';
export { parseAnswer, parseInline, type Block, type Inline } from './answer.js';
export type { AiCard, AiClient, AiHostEvent, AiProviderInfo, AiSettings, AiState, CanvasAction, ChatCitation, ChatEvent, SendPreview } from '@codearchy/protocol';
export { Icon, type IconName } from './icons.js';
export { FlowsView, type FlowsViewProps } from './Flows.js';
export { AuthorshipSection, type AuthorshipSource } from './Authorship.js';
export { FLOW_KINDS, flowModules, flowRows, groupFlows, splitLabel, type FlowGroup, type FlowRow } from './flowModel.js';
export { AddToTourDialog, Menu, TourEditor, ToursList, TourPlayer, type AddToTourProps, type ToursListProps, type TourPlayerProps } from './Tours.js';
export { addToDraft, draftFrom, firstUndone, moveStep, removeFromDraft, stepView, tourFile, tourFromFlow, tourToSave, updateStep, type DraftTour, type StepCapture } from './tourModel.js';
export { VoiceSettingsPanel, SpeakingBars, formatBytes, kokoroLabel, speechText, useVoiceState } from './voice.js';
export type { KokoroState, SpeakOptions, VoiceClient, VoiceEngineId, VoiceEngineInfo, VoiceOption, VoiceState } from '@codearchy/protocol';
export { Resizer, usePanelSize, type PanelSize, type ResizerProps } from './Resizer.js';
export { matrixCell } from './Matrix.js';
