/** What a platform supplies to run the conformance suite. */
import type { AnalyzeExecutor, FileSystemPort, ParserRuntime, StoragePort } from '@codearchy/core';

export interface ConformanceHarness {
    /** e.g. "node", "chromium", "firefox", "webkit". */
    platform: string;
    /** A FileSystemPort over a copy of fixtures/polyglot, and that copy's file listing (POSIX). */
    fixture(): Promise<{ fs: FileSystemPort; files: string[] }>;
    /** A fresh, empty database (unique per call). */
    openStorage(name: string): Promise<StoragePort>;
    parser(): Promise<ParserRuntime>;
    /** Optional parallel executor over the fixture (worker pool). */
    executor?(): Promise<AnalyzeExecutor & { lastRunWorkers: number }>;
}

export interface CaseResult {
    name: string;
    ok: boolean;
    skipped?: boolean;
    error?: string;
    ms: number;
}
