/** Runs the shared adapter conformance suite against platform-node. */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, runConformance, type ConformanceHarness } from '@codearchy/conformance';
import { createNodeParserRuntime, NodeFileSystem, NodeWorkerPool, openNodeSqlite, walkFiles } from '../src/index.js';
import { FIXTURES } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let tmp: string;
let repo: string;

beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codearchy-conformance-'));
    repo = path.join(tmp, 'polyglot');
    fs.cpSync(path.join(FIXTURES, 'polyglot'), repo, { recursive: true });
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const harness: ConformanceHarness = {
    platform: 'node',
    fixture: async () => ({ fs: new NodeFileSystem(repo), files: await walkFiles(repo) }),
    openStorage: async (name) => (await openNodeSqlite({ file: path.join(tmp, name) }))!,
    parser: async () => (await createNodeParserRuntime())!,
    executor: async () =>
        new NodeWorkerPool({ root: repo, maxFileSize: 1_000_000, workers: 2, minJobsForWorkers: 1, workerScript: path.join(here, '..', 'dist', 'worker.js') }),
};

const sqlite = await openNodeSqlite({ file: ':memory:' });
sqlite?.close();

describe.runIf(!!sqlite)(`conformance: ${harness.platform}`, () => {
    for (const c of CASES) {
        test(c.name, async () => {
            const [r] = await runConformance(harness, (n) => n === c.name);
            expect(r.error ?? null).toBeNull();
        });
    }
});
