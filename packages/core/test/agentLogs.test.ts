import { describe, test } from 'vitest';
import * as assert from 'node:assert';
import { AuthorshipLedger, matchEdits, parseAider, parseApplyPatch, parseClaudeCode, parseCodex, type AgentEdit } from '../src/index.js';

const jsonl = (...entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join('\n');
const use = (id: string, name: string, input: object, timestamp = '2026-11-02T10:00:00Z') => ({ type: 'assistant', cwd: '/repo', timestamp, message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, extra: object = {}, isError = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, ...(isError ? { is_error: true } : {}) }] }, toolUseResult: extra });
const show = (rs: Array<{ start: number; end: number; origin: string; agent?: string }>) => rs.map((r) => `${r.start}-${r.end}:${r.origin}:${r.agent}`);

describe('Claude Code transcripts', () => {
    test('Write, Edit and MultiEdit calls; failed calls dropped; edited proposals reviewed', () => {
        const r = parseClaudeCode(
            jsonl(
                use('t1', 'Write', { file_path: '/repo/a.ts', content: 'export const a = 1;\n' }),
                result('t1'),
                use('t2', 'Edit', { file_path: '/repo/b.ts', old_string: 'x', new_string: 'const y = computeSomething();' }),
                result('t2', { userModified: true }),
                use('t3', 'MultiEdit', { file_path: '/repo/c.ts', edits: [{ old_string: 'a', new_string: 'first()' }, { old_string: 'b', new_string: 'second()' }] }),
                result('t3'),
                use('t4', 'Edit', { file_path: '/repo/d.ts', old_string: 'q', new_string: 'rejected();' }),
                result('t4', {}, true),
                use('t5', 'Bash', { command: 'ls' }),
                use('t6', 'Edit', { old_string: 'no path' }),
                'not json'
            )
        );
        assert.deepStrictEqual(
            r.edits.map((e) => `${e.file}:${e.lines[0]}${e.reviewed ? ':reviewed' : ''}`),
            ['/repo/a.ts:export const a = 1;', '/repo/b.ts:const y = computeSomething();:reviewed', '/repo/c.ts:first()', '/repo/c.ts:second()']
        );
        assert.strictEqual(r.skipped, 1);
        assert.strictEqual(r.cwd, '/repo');
        assert.strictEqual(r.edits[0]!.time, Date.parse('2026-11-02T10:00:00Z'));
    });
});

describe('Codex sessions', () => {
    const patch = ['*** Begin Patch', '*** Update File: src/a.ts', '@@ function f', ' context', '-old();', '+newCall();', '+anotherCall();', ' more', '*** Add File: src/new.ts', '+export const n = 1;', '*** Delete File: src/gone.ts', '*** End Patch'].join('\n');

    test('apply_patch: added lines per file, in blocks', () => {
        assert.deepStrictEqual(parseApplyPatch(patch), [
            { file: 'src/a.ts', blocks: [['newCall();', 'anotherCall();']] },
            { file: 'src/new.ts', blocks: [['export const n = 1;']] },
        ]);
    });

    test('finds patches in function calls, custom tool calls and shell commands', () => {
        const r = parseCodex(
            jsonl(
                { timestamp: '2026-11-03T09:00:00Z', type: 'session_meta', payload: { cwd: '/repo' } },
                { timestamp: '2026-11-03T09:01:00Z', type: 'response_item', payload: { type: 'function_call', name: 'apply_patch', arguments: JSON.stringify({ input: patch }) } },
                { timestamp: '2026-11-03T09:02:00Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: patch } },
                { timestamp: '2026-11-03T09:03:00Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['apply_patch', patch] }) } },
                { type: 'response_item', payload: { type: 'message', content: 'I will run *** Begin Patch later' } }
            )
        );
        assert.strictEqual(r.cwd, '/repo');
        assert.strictEqual(r.edits.length, 6);
        assert.deepStrictEqual([...new Set(r.edits.map((e) => e.file))], ['src/a.ts', 'src/new.ts']);
    });
});

describe('Aider history', () => {
    test('SEARCH/REPLACE blocks with their file and session time', () => {
        const md = ['# aider chat started at 2026-11-04 08:30:00', '', '#### add a retry', '', 'src/client.py', '```python', '<<<<<<< SEARCH', 'def get():', '=======', 'def get(retries=3):', '    return fetch(retries)', '>>>>>>> REPLACE', '```', '', '<<<<<<< SEARCH', 'broken block'].join('\n');
        const r = parseAider(md);
        assert.deepStrictEqual(r.edits.map((e) => [e.file, e.lines]), [['src/client.py', ['def get(retries=3):', '    return fetch(retries)']]]);
        assert.strictEqual(r.edits[0]!.time, Date.parse('2026-11-04T08:30:00'));
        assert.strictEqual(r.skipped, 1);
    });
});

describe('matchEdits', () => {
    const edit = (lines: string[], extra: Partial<AgentEdit> = {}): AgentEdit => ({ agent: 'claude-code', file: 'a.ts', time: 1, lines, ...extra });
    const body = ['function total(items) {', '    const sum = items.reduce((a, b) => a + b, 0);', '    return applyDiscount(sum);', '}'];

    test('an exact run is ai, verified, from the log', () => {
        const text = ['// header', ...body, '// footer'].join('\n');
        const r = matchEdits(text, [edit(body)]);
        assert.deepStrictEqual(show(r), ['2-5:ai:claude-code']);
        assert.strictEqual(r[0]!.confidence, 'verified');
        assert.strictEqual(r[0]!.source, 'log');
    });

    test('a person changed one line: matched lines ai, the changed one reviewed', () => {
        const changed = [body[0]!, body[1]!, '    return applyDiscount(sum, customer);', body[3]!];
        const r = matchEdits(['// header', ...changed].join('\n'), [edit(body)]);
        assert.deepStrictEqual(show(r), ['2-3:ai:claude-code', '4-4:reviewed:claude-code', '5-5:ai:claude-code']);
    });

    test('rewritten text, generic lines and tiny edits are not placed', () => {
        assert.deepStrictEqual(matchEdits(['something else entirely', 'and more'].join('\n'), [edit(body)]), []);
        assert.deepStrictEqual(matchEdits(['}', '}', 'return x;'].join('\n'), [edit(['}', 'return x;'])]), []);
        assert.deepStrictEqual(show(matchEdits(['a', 'const y = computeSomething();'].join('\n'), [edit(['const y = computeSomething();'])])), ['2-2:ai:claude-code']);
    });

    test('an edit the person changed before accepting is reviewed; later edits win', () => {
        assert.deepStrictEqual(show(matchEdits(body.join('\n'), [edit(body, { reviewed: true })])), ['1-4:reviewed:claude-code']);
        const both = matchEdits(body.join('\n'), [edit(body, { time: 1 }), edit([body[1]!], { agent: 'codex', time: 2 })]);
        assert.deepStrictEqual(show(both), ['1-1:ai:claude-code', '2-2:ai:codex', '3-4:ai:claude-code']);
    });
});

describe('ledger.recordLog', () => {
    test('log ranges replace earlier log ranges and beat capture; reviews still win', () => {
        const l = new AuthorshipLedger();
        l.applyEdit('a.ts', { start: 1, end: 0, inserted: 6, by: 'ai', agent: 'unknown-ai' }); // inferred capture 1-6
        l.markReviewed('a.ts', 5, 6);
        const log = matchEdits(body6(), [{ agent: 'claude-code', file: 'a.ts', time: 1, lines: body6().split('\n').slice(0, 4) }]);
        l.recordLog('a.ts', log);
        assert.deepStrictEqual(show(l.ranges('a.ts')), ['1-4:ai:claude-code', '5-6:reviewed:unknown-ai']);
        l.recordLog('a.ts', log); // reading the same logs again changes nothing
        assert.deepStrictEqual(show(l.ranges('a.ts')), ['1-4:ai:claude-code', '5-6:reviewed:unknown-ai']);
        l.recordLog('a.ts', []); // the log no longer says anything: its ranges go (the capture they replaced isn't restored)
        assert.deepStrictEqual(show(l.ranges('a.ts')), ['5-6:reviewed:unknown-ai']);
    });
});

function body6(): string {
    return ['function total(items) {', '    const sum = items.reduce((a, b) => a + b, 0);', '    return applyDiscount(sum);', '}', 'export const x = total([]);', 'export const y = total([1]);'].join('\n');
}
