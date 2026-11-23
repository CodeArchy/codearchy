/**
 * @codearchy/platform-browser — browser adapters for @codearchy/core:
 * File System Access / OPFS and in-memory file systems, SQLite WASM storage
 * (OPFS SAH pool), a fetch-based tree-sitter runtime, and a Web Worker parse
 * pool. No server: code is read and indexed entirely in the browser.
 */
export { HandleFileSystem, MemoryFileSystem, listHandleFiles, type MemoryEntry } from './fs.js';
export { openSqliteWasm, opfsSyncAccessAvailable, type SqliteWasmOptions } from './storage.js';
export { createFetchParserRuntime, type FetchParserOptions } from './parser.js';
export {
    BrowserWorkerPool,
    createBrowserAnalyzer,
    fileSystemFor,
    runBrowserParseWorker,
    yieldToBrowser,
    type BrowserWorkerData,
    type BrowserWorkerPoolOptions,
    type WorkspaceSource,
} from './pool.js';
