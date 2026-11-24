import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { Workspace } from '../src/workspace.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLYGLOT = path.resolve(HERE, '../../../fixtures/polyglot');
const MAIN = path.resolve(HERE, '../dist/main.js');

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function connect(workspace: Workspace, allowCode = true) {
    const server = createServer(workspace, { allowCode, version: 'test' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(clientSide);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
        const r = (await client.callTool({ name, arguments: args })) as ToolResult;
        return { error: !!r.isError, json: JSON.parse(r.content[0]!.text) as Record<string, any> };
    };
    return { client, call, close: () => client.close() };
}

describe('codearchy mcp (in process, polyglot fixture)', () => {
    const workspace = new Workspace(POLYGLOT);
    let session: Awaited<ReturnType<typeof connect>>;
    beforeAll(async () => {
        session = await connect(workspace);
    }, 60_000);
    afterAll(() => session.close());

    it('lists read-only tools, starting with overview', async () => {
        const { tools } = await session.client.listTools();
        expect(tools.map((t) => t.name)).toEqual(['overview', 'search', 'get_node', 'neighbors', 'explain_edge', 'find_flows', 'read_code']);
        expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
        expect(tools.find((t) => t.name === 'search')!.inputSchema).toMatchObject({ type: 'object', required: ['query'] });
    });

    it('gives an overview of the system with keys to explore from', async () => {
        const { error, json } = await session.call('overview');
        expect(error).toBe(false);
        expect(json.system).toMatchObject({ key: 'sys:root', name: 'polyglot' });
        expect(json.parts.length).toBeGreaterThan(2);
        expect(json.parts.every((p: { key: string }) => typeof p.key === 'string')).toBe(true);
        expect(json.index.files).toBeGreaterThan(20);
    });

    it('searches, describes a file with signatures and docs, and follows its dependencies', async () => {
        const found = await session.call('search', { query: 'billing', kind: 'module' });
        const keys = found.json.results.map((r: { key: string }) => r.key);
        expect(keys).toContain('mod:rb/lib/billing.rb');

        const node = await session.call('get_node', { key: 'mod:rb/lib/billing.rb' });
        expect(node.json).toMatchObject({ kind: 'module', path: 'rb/lib/billing.rb' });
        expect(node.json.card.purpose).toMatch(/billing gem/i);
        expect(node.json.dependsOn.length).toBeGreaterThan(0);

        const out = await session.call('neighbors', { key: 'mod:rb/bin/run.rb', direction: 'out' });
        // At the level of run.rb's siblings: the lib folder it reaches into.
        expect(out.json.dependsOn.map((l: { key: string }) => l.key)).toContain('dir:rb/lib');

        const edge = await session.call('explain_edge', { source: 'mod:rb/bin/run.rb', target: 'mod:rb/lib/billing.rb' });
        expect(edge.json.dependencies[0]).toMatchObject({ from: 'rb/bin/run.rb', to: 'rb/lib/billing.rb' });
    });

    it('reads indexed source lines, and nothing else', async () => {
        const code = await session.call('read_code', { path: 'rb/lib/billing.rb', startLine: 1, endLine: 3 });
        expect(code.json).toMatchObject({ path: 'rb/lib/billing.rb', startLine: 1, endLine: 3 });
        expect(code.json.code).toContain("1: require 'json'");

        const manifest = await session.call('read_code', { path: 'package.json', startLine: 1, endLine: 5 });
        expect(manifest).toMatchObject({ error: true, json: { error: expect.stringMatching(/not an indexed source file/) } });
        const escape = await session.call('read_code', { path: '../../package.json', startLine: 1, endLine: 5 });
        expect(escape.error).toBe(true);
    });

    it('lists entrypoints and traces one', async () => {
        const list = await session.call('find_flows', { kind: 'main' });
        expect(list.error).toBe(false);
        expect(list.json.results).toEqual([expect.objectContaining({ kind: 'main', label: 'main', framework: 'go', at: 'go/cmd/server/main.go:8' })]);
        const flow = await session.call('find_flows', { id: list.json.results[0].id });
        expect(flow.json).toMatchObject({ label: 'main', declaredAt: 'go/cmd/server/main.go:8' });
        expect(flow.json.steps[0]).toMatchObject({ step: 0, name: 'main', key: 'sym:go/cmd/server/main.go#main' });
        expect(await session.call('find_flows', { id: 'flow:nope' })).toMatchObject({ error: true, json: { error: expect.stringMatching(/No flow/) } });
    });

    it('reports bad arguments as tool errors', async () => {
        expect(await session.call('get_node', { key: 'dir:nope' })).toEqual({ error: true, json: { error: 'No node "dir:nope". Use search to find keys.' } });
        const bad = (await session.client.callTool({ name: 'neighbors', arguments: { key: 'sys:root', depth: 7 } })) as ToolResult;
        expect(bad.isError).toBe(true); // rejected by the input schema
    });

    it('leaves read_code out with --no-code', async () => {
        const noCode = await connect(new Workspace(POLYGLOT), false);
        const { tools } = await noCode.client.listTools();
        expect(tools.map((t) => t.name)).not.toContain('read_code');
        await noCode.close();
    });
});

describe('codearchy mcp keeps up with edits', () => {
    it('rebuilds the index after a file changes', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codearchy-mcp-'));
        await fs.mkdir(path.join(dir, 'src'));
        await fs.writeFile(path.join(dir, 'src', 'a.ts'), "export const a = 1;\n");
        const workspace = new Workspace(dir);
        workspace.watch();
        try {
            const before = await workspace.snapshot();
            expect(before.files).toBe(1);
            await fs.writeFile(path.join(dir, 'src', 'b.ts'), "import { a } from './a';\nexport const b = a + 1;\n");
            let after = before;
            for (let i = 0; i < 50 && after.files === 1; i++) {
                await new Promise((r) => setTimeout(r, 100));
                after = await workspace.snapshot();
            }
            expect(after.files).toBe(2);
            expect(after.index.node('mod:src/b.ts')).toBeDefined();
        } finally {
            workspace.close();
            await fs.rm(dir, { recursive: true, force: true });
        }
    }, 30_000);
});

describe('codearchy mcp over stdio (the built CLI)', () => {
    it('starts, lists its tools and answers overview', async () => {
        const transport = new StdioClientTransport({ command: process.execPath, args: [MAIN, 'mcp', '--root', POLYGLOT], stderr: 'pipe' });
        const client = new Client({ name: 'test', version: '1' });
        await client.connect(transport);
        try {
            expect(client.getServerVersion()).toMatchObject({ name: 'codearchy' });
            expect(client.getInstructions()).toMatch(/Start with overview/);
            const { tools } = await client.listTools();
            expect(tools).toHaveLength(7);
            const r = (await client.callTool({ name: 'overview', arguments: {} })) as ToolResult;
            expect(JSON.parse(r.content[0]!.text).system.name).toBe('polyglot');
        } finally {
            await client.close();
        }
    }, 60_000);
});
