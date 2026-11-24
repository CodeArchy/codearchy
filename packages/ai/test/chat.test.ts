import { describe, expect, it } from 'vitest';
import { MemoryAuditLog, ProviderRegistry, type ChatEvent, type ChatRequest, type ProviderAdapter, type ToolCall } from '@codearchy/providers';
import type { Flow } from '@codearchy/protocol';
import { checkCitations, GroundedChat, NodeSearch, stem, tokens, type ChatStreamEvent, type FlowSource } from '../src/index.js';
import { FILES, index, reader } from './fixture.js';

type Step = { text?: string; calls?: Array<Omit<ToolCall, 'id'>> };

/** A chat model that plays one scripted step per request (repeating the last), recording requests. */
function model(steps: Step[], opts: { remote?: boolean; tools?: boolean } = {}) {
    const requests: ChatRequest[] = [];
    const adapter: ProviderAdapter = {
        id: 'fake',
        label: 'Fake',
        kind: opts.remote ? 'api-key' : 'local',
        baseUrl: opts.remote ? 'https://fake.example.com' : 'http://localhost:1',
        detect: async () => ({ state: 'ready' }),
        listModels: async () => [{ id: 'm', label: 'm', provider: 'fake', supports: { tools: opts.tools ?? true }, locality: 'cloud' }],
        async *chat(request) {
            requests.push(structuredClone(request));
            const step = steps[Math.min(requests.length - 1, steps.length - 1)]!;
            if (step.text) yield { type: 'text', delta: step.text } as ChatEvent;
            const toolCalls = (step.calls ?? []).map((c, i) => ({ ...c, id: `t${requests.length}_${i}` }));
            for (const call of toolCalls) yield { type: 'tool_call', call } as ChatEvent;
            yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } } as ChatEvent;
            yield { type: 'done', stopReason: toolCalls.length ? 'tool_use' : 'end', turn: { content: step.text ?? '', toolCalls } } as ChatEvent;
        },
    };
    return { adapter, requests };
}

async function chatWith(adapter: ProviderAdapter, tier: 'local-only' | 'structure' | 'excerpts' = 'structure', audit = new MemoryAuditLog()) {
    const registry = new ProviderRegistry([adapter], { policy: { tier } }, { resilience: false, audit });
    await registry.refresh();
    return { chat: new GroundedChat({ index: index(), readFile: reader(FILES), registry }), audit };
}

async function run(stream: AsyncIterable<ChatStreamEvent>) {
    const events: ChatStreamEvent[] = [];
    for await (const e of stream) events.push(e);
    const done = events.find((e) => e.type === 'done') as Extract<ChatStreamEvent, { type: 'done' }> | undefined;
    return { events, done };
}

describe('search', () => {
    it('splits identifiers into words', () => {
        expect(tokens('parseHTTPRequest src/auth_service.py v2')).toEqual(['parse', 'http', 'request', 'src', 'auth', 'service', 'py', 'v2']);
    });

    it('stems both sides so plural and tense forms meet', () => {
        expect(['invoices', 'invoice', 'charged', 'charging', 'charges', 'policies', 'class'].map((w) => stem(w))).toEqual([
            'invoic',
            'invoic',
            'charg',
            'charg',
            'charg',
            'policy',
            'class',
        ]);
    });

    it('ranks names and paths, preferring exact names and containers', () => {
        const s = new NodeSearch(index());
        expect(s.search('session')[0]).toMatchObject({ key: 'mod:src/auth/session.ts' });
        expect(s.search('login').map((h) => h.key)).toContain('sym:src/auth/session.ts#login');
        expect(s.search('charge invoice', { kinds: ['module'] }).map((h) => h.key).slice(0, 2).sort()).toEqual([
            'mod:src/billing/charge.ts',
            'mod:src/billing/invoice.ts',
        ]);
        expect(s.search('zzz')).toEqual([]);
        expect(s.search('where is it and how does that work')).toEqual([]); // only stopwords
    });
});

describe('citations', () => {
    it('links inline-code names that match exactly one file or symbol, and leaves the rest', () => {
        const r = checkCitations('`session.ts` calls `login()`; `charge` too, but `index` and `nothing` stay. [`sign`](node:sym:src/auth/tokens.ts#sign) is already linked.', index());
        expect(r.answer).toBe(
            '[`session.ts`](node:mod:src/auth/session.ts) calls [`login()`](node:sym:src/auth/session.ts#login); [`charge`](node:sym:src/billing/charge.ts#charge) too, but `index` and `nothing` stay. [`sign`](node:sym:src/auth/tokens.ts#sign) is already linked.',
        );
        expect(r.autoLinked).toBe(3);
        expect(checkCitations('see [here](src/auth/tokens.ts#L2) and [docs](README.md)', index()).answer).toBe(
            'see [here](file:src/auth/tokens.ts#L2) and [docs](README.md)',
        );
        expect(r.citations.map((c) => (c.type === 'node' ? c.key : c.path))).toEqual([
            'mod:src/auth/session.ts',
            'sym:src/auth/session.ts#login',
            'sym:src/billing/charge.ts#charge',
            'sym:src/auth/tokens.ts#sign',
        ]);
    });

    it('keeps links the index knows and turns the rest into text', () => {
        const r = checkCitations(
            'See [session](node:mod:src/auth/session.ts), [ghost](node:dir:nowhere), [session.ts:2](file:src/auth/session.ts#L2), [x](file:src/missing.ts#L1) and [lines](file:src/auth/tokens.ts#L1-L3).',
            index(),
        );
        expect(r.invalid).toBe(2);
        expect(r.answer).toContain('[session](node:mod:src/auth/session.ts)');
        expect(r.answer).toContain('ghost,');
        expect(r.answer).not.toContain('node:dir:nowhere');
        expect(r.citations).toEqual([
            { type: 'node', key: 'mod:src/auth/session.ts', label: 'session' },
            { type: 'file', path: 'src/auth/session.ts', label: 'session.ts:2', startLine: 2 },
            { type: 'file', path: 'src/auth/tokens.ts', label: 'lines', startLine: 1, endLine: 3 },
        ]);
    });
});

describe('GroundedChat', () => {
    it('looks things up with tools, streams status, and hands over a checked answer with citations', async () => {
        const fake = model([
            { text: 'Let me look.', calls: [{ name: 'search', args: { query: 'login' } }] },
            { calls: [{ name: 'get_node', args: { key: 'mod:src/auth/session.ts' } }, { name: 'show_in_map', args: { keys: ['dir:src/auth', 'dir:nope'] } }] },
            { text: 'Logging in happens in [session.ts](node:mod:src/auth/session.ts) via [login](file:src/auth/session.ts#L2); see also [made up](node:dir:imaginary).' },
        ]);
        const { chat } = await chatWith(fake.adapter);
        const { events, done } = await run(chat.ask('Where does login happen?', { selection: 'mod:src/billing/charge.ts' }));

        expect(events.filter((e) => e.type === 'status').map((e) => (e as { text: string }).text)).toEqual([
            'Searching for "login"…',
            'Looking at session.ts…',
            'Preparing a view of the map…',
        ]);
        const actions = events.filter((e) => e.type === 'action') as Array<Extract<ChatStreamEvent, { type: 'action' }>>;
        expect(actions).toHaveLength(1);
        expect(actions[0]!.action.action).toBe('focus');
        expect(actions[0]!.action.keys.length).toBeGreaterThan(0);
        expect(actions[0]!.action.keys).not.toContain('dir:nope'); // only keys the index knows
        expect(done).toMatchObject({ mode: 'tools', rounds: 3, invalidCitations: 1, provider: 'fake', model: 'm', usage: { inputTokens: 30, outputTokens: 15 } });
        expect(done!.answer).toContain('see also made up.');
        expect(done!.citations.map((c) => (c.type === 'node' ? c.key : c.path))).toEqual(['mod:src/auth/session.ts', 'src/auth/session.ts']);

        // The first request: rules + top-level parts in the system prompt, the selection and question in the user turn.
        const first = fake.requests[0]!;
        expect(first.system).toMatch(/\[Name\]\(node:<key>\)/);
        expect(first.system).toContain('Top-level parts:');
        expect(first.messages[0]!.content).toContain('Selected in the map: charge.ts');
        // An on-device model may read code under every tier.
        expect(first.tools?.map((t) => t.name)).toEqual(['search', 'get_node', 'neighbors', 'explain_edge', 'read_code', 'show_in_map']);

        // Tool results reached the model as tool messages; get_node carried signatures but no code bodies.
        const third = fake.requests[2]!;
        const results = third.messages.filter((m) => m.role === 'tool');
        expect(results.map((m) => (m as { name: string }).name)).toEqual(['search', 'get_node', 'show_in_map']);
        const nodeResult = (results[1] as { content: string }).content;
        expect(nodeResult).toContain('export function login(user: string)');
        expect(nodeResult).not.toContain('secretInternalLogic');
        expect(done!.history.at(-1)).toMatchObject({ role: 'assistant' });
    });

    it('offers read_code only when excerpts may reach the model, and declares excerpts after reading', async () => {
        const remote = model([{ text: 'ok' }], { remote: true });
        const blocked = await chatWith(remote.adapter, 'structure');
        await run(blocked.chat.ask('q'));
        expect(remote.requests[0]!.tools!.map((t) => t.name)).not.toContain('read_code');
        expect(remote.requests[0]!.system).toMatch(/Source code is not available/);

        const reader = model(
            [{ calls: [{ name: 'read_code', args: { path: 'src/auth/session.ts', startLine: 1, endLine: 4 } }] }, { text: 'It calls secretInternalLogic ([session.ts:3](file:src/auth/session.ts#L3)).' }],
            { remote: true },
        );
        const audit = new MemoryAuditLog();
        const allowed = await chatWith(reader.adapter, 'excerpts', audit);
        const { done } = await run(allowed.chat.ask('What does login call?'));
        expect(reader.requests[0]!.tools!.map((t) => t.name)).toContain('read_code');
        const codeResult = reader.requests[1]!.messages.find((m) => m.role === 'tool') as { content: string };
        expect(JSON.parse(codeResult.content)).toMatchObject({ path: 'src/auth/session.ts', startLine: 1, endLine: 4, code: expect.stringContaining('3:     return secretInternalLogic(user);') });
        expect(audit.entries().map((e) => e.contains)).toEqual([['structure'], ['structure', 'excerpts']]);
        expect(done!.citations).toEqual([{ type: 'file', path: 'src/auth/session.ts', label: 'session.ts:3', startLine: 3 }]);
    });

    it('lets an on-device model read code under any tier, but never files outside the index', async () => {
        const local = model([{ calls: [{ name: 'read_code', args: { path: '.env', startLine: 1, endLine: 5 } }, { name: 'read_code', args: { path: 'src/billing/invoice.ts', startLine: 1, endLine: 999 } }] }, { text: 'done' }]);
        const { chat } = await chatWith(local.adapter, 'local-only');
        await run(chat.ask('q'));
        const [env, invoice] = local.requests[1]!.messages.filter((m) => m.role === 'tool') as Array<{ content: string; isError?: boolean }>;
        expect(env).toMatchObject({ isError: true });
        expect(env!.content).toMatch(/not an indexed source file/);
        expect(JSON.parse(invoice!.content)).toMatchObject({ startLine: 1, endLine: 5, totalLines: 5 });
    });

    it('reports bad tool arguments back to the model instead of failing', async () => {
        const fake = model([{ calls: [{ name: 'get_node', args: {} }, { name: 'neighbors', args: { key: 'dir:missing' } }, { name: 'frobnicate', args: {} }] }, { text: 'sorry' }]);
        const { chat } = await chatWith(fake.adapter);
        const { done } = await run(chat.ask('q'));
        const results = fake.requests[1]!.messages.filter((m) => m.role === 'tool') as Array<{ content: string; isError?: boolean }>;
        expect(results.map((r) => [r.isError, JSON.parse(r.content).error])).toEqual([
            [true, '"key" must be a non-empty string'],
            [true, 'No node "dir:missing". Use search to find keys.'],
            [true, 'Unknown tool "frobnicate"'],
        ]);
        expect(done!.answer).toBe('sorry');
    });

    it('explains an edge with its import sites', async () => {
        const fake = model([{ calls: [{ name: 'explain_edge', args: { source: 'mod:src/billing/charge.ts', target: 'mod:src/auth/session.ts' } }] }, { text: 'ok' }]);
        const { chat } = await chatWith(fake.adapter);
        await run(chat.ask('q'));
        const result = JSON.parse((fake.requests[1]!.messages.find((m) => m.role === 'tool') as { content: string }).content);
        expect(result).toMatchObject({ total: 1, dependencies: [{ from: 'src/billing/charge.ts', to: 'src/auth/session.ts', weight: 1, sites: ['src/auth/session.ts (line 1)'] }] });
    });

    it('offers find_flows when the host has flows: lists entrypoints, then traces one', async () => {
        const flow: Flow = {
            id: 'flow:src/auth/session.ts#http:POST /login',
            kind: 'http',
            label: 'POST /login',
            framework: 'express',
            file: 'src/auth/session.ts',
            line: 1,
            steps: [
                { key: 'sym:src/auth/session.ts#login', name: 'login', file: 'src/auth/session.ts', line: 1, lane: 'dir:src/auth', depth: 0, resolution: 'entry' },
                { key: 'sym:src/auth/tokens.ts#sign', name: 'sign', file: 'src/auth/tokens.ts', line: 1, lane: 'dir:src/auth', depth: 1, parent: 0, callSite: { file: 'src/auth/session.ts', line: 2 }, resolution: 'name' },
            ],
            lanes: [{ key: 'dir:src/auth', name: 'auth', kind: 'component' }],
            sinks: [{ kind: 'database', name: 'pg', step: 1 }],
            approximate: true,
            truncated: false,
        };
        const { steps: _s, lanes: _l, sinks: _k, approximate: _a, truncated: _t, ...summary } = flow;
        const flows: FlowSource = { list: () => [summary], trace: (id) => (id === flow.id ? flow : undefined) };

        const without = model([{ text: 'ok' }]);
        await run((await chatWith(without.adapter)).chat.ask('q'));
        expect(without.requests[0]!.tools!.map((t) => t.name)).not.toContain('find_flows');

        const fake = model([{ calls: [{ name: 'find_flows', args: { query: 'login' } }, { name: 'find_flows', args: { id: flow.id } }, { name: 'find_flows', args: { kind: 'nope' } }] }, { text: 'ok' }]);
        const registry = new ProviderRegistry([fake.adapter], { policy: { tier: 'structure' } }, { resilience: false });
        await registry.refresh();
        await run(new GroundedChat({ index: index(), readFile: reader(FILES), registry, flows }).ask('What happens when someone logs in?'));
        expect(fake.requests[0]!.tools!.map((t) => t.name)).toContain('find_flows');
        expect(fake.requests[0]!.system).toMatch(/find_flows/);
        const [listed, traced, bad] = fake.requests[1]!.messages.filter((m) => m.role === 'tool') as Array<{ content: string; isError?: boolean }>;
        expect(JSON.parse(listed!.content)).toEqual({ total: 1, matching: 1, results: [{ id: flow.id, kind: 'http', label: 'POST /login', framework: 'express', at: 'src/auth/session.ts:2' }] });
        expect(JSON.parse(traced!.content)).toMatchObject({
            label: 'POST /login',
            steps: [
                { step: 0, name: 'login', key: 'sym:src/auth/session.ts#login', at: 'src/auth/session.ts:2', part: 'auth' },
                { step: 1, name: 'sign', calledBy: 0, callLine: 3, matchedByNameOnly: true },
            ],
            reaches: [{ kind: 'database', library: 'pg', step: 1 }],
            approximate: expect.any(String),
        });
        expect(bad).toMatchObject({ isError: true });
    });

    it('stops looking after maxRounds and makes the model answer', async () => {
        const looping = model([{ calls: [{ name: 'search', args: { query: 'auth' } }] }]);
        const registry = new ProviderRegistry([looping.adapter], { policy: { tier: 'structure' } }, { resilience: false });
        await registry.refresh();
        const chat = new GroundedChat({ index: index(), readFile: reader(FILES), registry, maxRounds: 3 });
        const { done } = await run(chat.ask('q'));
        expect(looping.requests).toHaveLength(4);
        expect(looping.requests[3]).toMatchObject({ toolChoice: 'none' });
        expect(looping.requests[3]!.messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringMatching(/Answer now/) });
        expect(done!.rounds).toBe(4);
    });

    it('packs retrieved context into the prompt for models without tool calling (RAG)', async () => {
        const plain = model([{ text: 'Billing lives in [billing](node:dir:src/billing).' }], { tools: false });
        const { chat } = await chatWith(plain.adapter);
        const { done } = await run(chat.ask('how are invoices charged?'));
        const req = plain.requests[0]!;
        expect(req.tools).toBeUndefined();
        expect(req.messages[0]!.content).toContain('Context from the map:');
        expect(req.messages[0]!.content).toMatch(/charge\.ts \(module\) key mod:src\/billing\/charge\.ts/);
        expect(done).toMatchObject({ mode: 'rag', rounds: 1 });
    });

    it('passes blocks and provider errors through as an error event', async () => {
        const remote = model([{ text: 'x' }], { remote: true });
        const { chat } = await chatWith(remote.adapter, 'local-only');
        const { events } = await run(chat.ask('q'));
        expect(events).toEqual([{ type: 'error', error: expect.objectContaining({ code: 'policy' }) }]);
        expect(remote.requests).toHaveLength(0);
    });

    it('treats a failing card lookup as "no card"', async () => {
        const fake = model([{ calls: [{ name: 'search', args: { query: 'login' } }, { name: 'get_node', args: { key: 'mod:src/auth/session.ts' } }] }, { text: 'ok' }]);
        const registry = new ProviderRegistry([fake.adapter], { policy: { tier: 'structure' } }, { resilience: false });
        await registry.refresh();
        const asked: string[] = [];
        const chat = new GroundedChat({
            index: index(),
            readFile: reader(FILES),
            registry,
            cards: async (key) => {
                asked.push(key);
                throw new Error('store offline');
            },
        });
        const { done } = await run(chat.ask('where is login?'));
        expect(done!.answer).toBe('ok');
        expect(asked.some((k) => k.startsWith('sym:'))).toBe(false);
    });

    it('continues a conversation from the previous history', async () => {
        const fake = model([{ text: 'first' }, { text: 'second' }]);
        const { chat } = await chatWith(fake.adapter);
        const one = await run(chat.ask('q1'));
        await run(chat.ask('q2', { history: one.done!.history }));
        expect(fake.requests[1]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    });
});
