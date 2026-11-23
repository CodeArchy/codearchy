/**
 * @codearchy/ai: AI orchestration over the architecture hierarchy, built on
 * @codearchy/providers. 3.3: bottom-up summary cards.
 */
export { CARD_SCHEMA, CardFormatError, extractJson, validate, type Card, type CardDraft } from './card.js';
export { fileDoc, signature, symbolDoc, tidy } from './docs.js';
export {
    containerFacts,
    manifestDescription,
    moduleFacts,
    readmeSummary,
    ROLE_LABEL,
    type ChildFact,
    type ContainerFacts,
    type Facts,
    type ModuleFacts,
    type Prepared,
    type SymbolFact,
} from './facts.js';
export { CONTAINER_SYSTEM, MODULE_SYSTEM, PROMPT_VERSION, renderFacts } from './prompts.js';
export {
    MemoryCardStore,
    promptTokens,
    Summarizer,
    type CardStore,
    type CrawlOptions,
    type CrawlResult,
    type SummarizerOptions,
} from './summarizer.js';

// 3.4: grounded chat.
export { GroundedChat, type AskOptions, type ChatStreamEvent, type GroundedChatOptions } from './chat.js';
export { checkCitations, type Citation } from './citations.js';
export { NodeSearch, stem, terms, tokens, type SearchHit } from './search.js';
export { READ_CODE_BUDGET, READ_CODE_MAX_LINES, runTool, TOOL_SPECS, ToolArgumentError, toolStatus, type CanvasAction, type ToolContext } from './tools.js';

// 3.6: the host side of the AiClient contract.
export { AiHost, DEFAULT_AI_SETTINGS, type AiHostOptions, type ProviderFactory, type SettingsStore } from './host.js';
