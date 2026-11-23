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
