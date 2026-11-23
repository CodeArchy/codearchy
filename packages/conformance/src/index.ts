/**
 * @codearchy/conformance — the shared adapter conformance suite. Each
 * platform (platform-node via Vitest, platform-browser via Playwright in
 * Chromium/Firefox/WebKit) implements a ConformanceHarness and must pass every
 * case, including reproducing the golden polyglot graph exactly.
 */
export { CASES, runConformance } from './cases.js';
export type { ConformanceHarness, CaseResult } from './harness.js';
export { GOLDEN_POLYGLOT } from './expected/polyglot.js';
