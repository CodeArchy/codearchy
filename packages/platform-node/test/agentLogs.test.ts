import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuthorshipLedger } from '@codearchy/core';
import { AgentLogIngester } from '../src/index.js';

const jsonl = (...entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join('\n');
const show = (rs: Array<{ start: number; end: number; origin: string; agent?: string }>) => rs.map((r) => `${r.start}-${r.end}:${r.origin}:${r.agent}`);

describe('AgentLogIngester', () => {
    test('reads Claude Code, Codex and Aider logs for this workspace only, and records what they wrote', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codearchy-agentlogs-'));
        const home = path.join(tmp, 'home');
        const root = path.join(tmp, 'repo');
        try {
            fs.mkdirSync(path.join(root, 'src'), { recursive: true });
            const service = ['export function charge(order) {', '    const total = order.items.reduce((s, i) => s + i.price, 0);', '    return gateway.charge(order.customer, total);', '}'];
            fs.writeFileSync(path.join(root, 'src', 'billing.ts'), ['// billing', ...service, ''].join('\n'));
            fs.writeFileSync(path.join(root, 'src', 'retry.py'), ['def get(retries=3):', '    return fetch_with_backoff(retries)', ''].join('\n'));
            fs.writeFileSync(path.join(root, 'src', 'flags.ts'), ['export const flags = loadFeatureFlags(environment);', ''].join('\n'));

            // Claude Code: a transcript in this workspace's project folder, plus one for another project.
            const encoded = path.resolve(root).replace(/[^a-zA-Z0-9]/g, '-');
            const claude = path.join(home, '.claude', 'projects', encoded);
            fs.mkdirSync(claude, { recursive: true });
            fs.writeFileSync(
                path.join(claude, 'session.jsonl'),
                jsonl(
                    { type: 'assistant', cwd: root, timestamp: '2026-11-02T10:00:00Z', message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: path.join(root, 'src', 'billing.ts'), content: ['// billing', ...service].join('\n') } }] } },
                    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
                    { type: 'assistant', cwd: root, message: { content: [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: '/elsewhere/secret.ts', content: 'export const outside = trueAndLongEnough;' } }] } }
                )
            );
            const other = path.join(home, '.claude', 'projects', '-somewhere-else');
            fs.mkdirSync(other, { recursive: true });
            fs.writeFileSync(path.join(other, 's.jsonl'), jsonl({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Write', input: { file_path: path.join(root, 'src', 'flags.ts'), content: 'export const flags = loadFeatureFlags(environment);' } }] } }));

            // Codex: one session in this workspace, one in another directory.
            const day = path.join(home, '.codex', 'sessions', '2026', '11', '03');
            fs.mkdirSync(day, { recursive: true });
            const patch = ['*** Begin Patch', '*** Update File: src/flags.ts', '+export const flags = loadFeatureFlags(environment);', '*** End Patch'].join('\n');
            fs.writeFileSync(path.join(day, 'rollout-a.jsonl'), jsonl({ type: 'session_meta', payload: { cwd: root } }, { timestamp: '2026-11-03T09:00:00Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: patch } }));
            fs.writeFileSync(path.join(day, 'rollout-b.jsonl'), jsonl({ type: 'session_meta', payload: { cwd: '/another/project' } }, { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: patch.replace('flags', 'other') } }));

            // Aider: the history in the workspace.
            fs.writeFileSync(path.join(root, '.aider.chat.history.md'), ['# aider chat started at 2026-11-04 08:30:00', 'src/retry.py', '```python', '<<<<<<< SEARCH', 'def get():', '=======', 'def get(retries=3):', '    return fetch_with_backoff(retries)', '>>>>>>> REPLACE', '```'].join('\n'));

            const ledger = new AuthorshipLedger();
            const read = async (rel: string) => fs.promises.readFile(path.join(root, rel), 'utf8').catch(() => undefined);
            const ingester = new AgentLogIngester(root, { agents: ['claude-code', 'codex', 'aider'], home, env: {} });
            const reports = await ingester.run(ledger, read);

            expect(show(ledger.ranges('src/billing.ts'))).toEqual(['1-5:ai:claude-code']);
            expect(ledger.ranges('src/billing.ts')[0]).toMatchObject({ confidence: 'verified', source: 'log' });
            expect(show(ledger.ranges('src/flags.ts'))).toEqual(['1-1:ai:codex']);
            expect(show(ledger.ranges('src/retry.py'))).toEqual(['1-2:ai:aider']);
            expect(ledger.paths().sort()).toEqual(['src/billing.ts', 'src/flags.ts', 'src/retry.py']);
            expect(reports.map((r) => `${r.agent}:${r.logs}:${r.edits}:${r.files}`)).toEqual(['claude-code:1:1:1', 'codex:2:1:1', 'aider:1:1:1']);

            // Only the enabled agents are read; a second run with the same logs changes nothing.
            const again = await ingester.run(ledger, read);
            expect(again).toEqual(reports);
            expect(show(ledger.ranges('src/billing.ts'))).toEqual(['1-5:ai:claude-code']);
            const none = new AuthorshipLedger();
            await new AgentLogIngester(root, { agents: [], home, env: {} }).run(none, read);
            expect(none.paths()).toEqual([]);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});
