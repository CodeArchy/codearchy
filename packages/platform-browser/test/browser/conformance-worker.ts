/**
 * Runs the shared conformance suite inside a module Worker (SQLite's OPFS SAH
 * pool requires one). The fixture is copied into an OPFS directory and read
 * through HandleFileSystem: the same API a folder opened with the File System
 * Access picker uses.
 */
import { runConformance, type ConformanceHarness } from '@codearchy/conformance';
import { BrowserWorkerPool, HandleFileSystem, createFetchParserRuntime, listHandleFiles, openSqliteWasm } from '../../src/index.js';
import { indexChecks } from './indexes.js';
import { storeChecks } from './stores.js';

const scope = self as unknown as { onmessage: ((ev: MessageEvent) => void) | null; postMessage(m: unknown): void };

async function writeFixture(): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    try {
        await root.removeEntry('polyglot', { recursive: true });
    } catch {
        // first run
    }
    const dir = await root.getDirectoryHandle('polyglot', { create: true });
    const files: string[] = await (await fetch('/fixture/index.json')).json();
    for (const p of files) {
        const parts = p.split('/');
        let d = dir;
        for (const seg of parts.slice(0, -1)) d = await d.getDirectoryHandle(seg, { create: true });
        const handle = await d.getFileHandle(parts[parts.length - 1], { create: true });
        const bytes = new Uint8Array(await (await fetch(`/fixture/files/${p}`)).arrayBuffer());
        const access = await (handle as FileSystemFileHandle & {
            createSyncAccessHandle(): Promise<{ truncate(n: number): void; write(b: Uint8Array, o: { at: number }): number; flush(): void; close(): void }>;
        }).createSyncAccessHandle();
        access.truncate(0);
        access.write(bytes, { at: 0 });
        access.flush();
        access.close();
    }
    return dir;
}

scope.onmessage = async (ev: MessageEvent<{ platform: string }>) => {
    try {
        const dir = await writeFixture();
        const parserOptions = { runtimeWasmUrl: '/parsers/web-tree-sitter.wasm', grammarBaseUrl: '/parsers/' };
        const harness: ConformanceHarness = {
            platform: ev.data.platform,
            fixture: async () => ({ fs: new HandleFileSystem(dir), files: await listHandleFiles(dir) }),
            openStorage: (name) => openSqliteWasm({ mode: 'opfs-sahpool', name, poolName: 'codearchy-conformance', wasmUrl: '/sqlite/sqlite3.wasm' }),
            parser: () => createFetchParserRuntime(parserOptions),
            executor: async () =>
                new BrowserWorkerPool({
                    ...parserOptions,
                    workerUrl: '/dist-test/parse-worker.js',
                    source: { kind: 'handle', handle: dir },
                    maxFileSize: 1_000_000,
                    workers: 2,
                    minJobsForWorkers: 1,
                }),
        };
        scope.postMessage({ type: 'done', results: [...(await runConformance(harness)), ...(await storeChecks()), ...(await indexChecks())] });
    } catch (err) {
        scope.postMessage({ type: 'fatal', message: (err as Error).stack ?? String(err) });
    }
};
