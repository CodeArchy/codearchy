/**
 * How the UI reaches the engine. The contract itself lives in
 * @codearchy/protocol (EngineClient, SearchResult) so engines and transports
 * can implement it without depending on the UI; each host provides one (a Web
 * Worker in the browser, postMessage to the extension host in VS Code).
 */
export type { EngineClient, SearchResult } from '@codearchy/protocol';

/** Things only the host can do; each is optional and hidden when missing. */
export interface HostActions {
    /** Open a workspace file, optionally at a 0-based line. */
    openFile?(path: string, line?: number): void;
}
