import { describe, test } from 'vitest';
import * as assert from 'node:assert';
import { EdgeType, NodeType, type ArchitectureGraph } from '@codearchy/protocol';
import { AuthorshipIndex, buildHierarchy, classifyCommit, HierarchyIndex, rangesFromBlame, weekOf, type AttributedCommit } from '../src/index.js';

const commit = (message: string, authorName = 'Ada', authorEmail = 'ada@example.com') => classifyCommit({ authorName, authorEmail, message })?.agent;

describe('classifyCommit', () => {
    test('co-author trailers from AI tools', () => {
        assert.strictEqual(commit('fix: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>'), 'claude-code');
        assert.strictEqual(commit('feat\n\nCo-authored-by: Claude Opus 4.5 <noreply@anthropic.com>'), 'claude-code');
        assert.strictEqual(commit('feat\n\nCo-authored-by: Copilot <copilot@github.com>'), 'copilot');
        assert.strictEqual(commit('feat\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>'), 'cursor');
        assert.strictEqual(commit('feat\n\nCo-authored-by: aider (gpt-4o) <noreply@aider.chat>'), 'aider');
        assert.strictEqual(commit('feat\n\nCo-authored-by: devin-ai-integration[bot] <158243242+devin-ai-integration[bot]@users.noreply.github.com>'), 'devin');
    });

    test("people who share a tool's name are not AI", () => {
        assert.strictEqual(commit('feat\n\nCo-authored-by: Claude Dupont <claude@acme.com>'), undefined);
        assert.strictEqual(commit('feat\n\nCo-authored-by: Devin Smith <devin@acme.com>'), undefined);
        assert.strictEqual(commit('feat\n\nCo-authored-by: Jules Verne <jules@acme.com>'), undefined);
        assert.strictEqual(commit('feat: talk to the Claude API', 'Claude Martin', 'claude.martin@acme.com'), undefined);
        assert.strictEqual(commit('docs: compare Copilot and Cursor'), undefined); // a mention isn't a marker
        // Quoting a tool's marker in prose (a changelog, this feature's own PR) isn't the marker.
        assert.strictEqual(commit('feat: authorship\n\n| Tool markers | "🤖 Generated with [Claude Code]", Aider\'s `aider:` prefix |'), undefined);
    });

    test('coding-agent bot authors and tool markers in the message', () => {
        assert.strictEqual(commit('Implement search', 'copilot-swe-agent[bot]', '198982749+Copilot@users.noreply.github.com'), 'copilot');
        assert.strictEqual(commit('Fix bug', 'google-labs-jules[bot]', 'x+google-labs-jules[bot]@users.noreply.github.com'), 'jules');
        assert.strictEqual(commit('refactor\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)'), 'claude-code');
        assert.strictEqual(commit('aider: Added retry to the client'), 'aider');
        assert.strictEqual(commit('Bump deps', 'dependabot[bot]', '49699333+dependabot[bot]@users.noreply.github.com'), undefined); // a bot, but not an AI coder
    });

    test('custom rules for in-house agents', () => {
        const rules = [{ agent: 'acme-bot', contains: 'acme-agent' }];
        assert.strictEqual(classifyCommit({ authorName: 'A', authorEmail: 'a@x', message: 'x\n\nCo-authored-by: Acme-Agent <bot@acme>' }, rules)?.agent, 'acme-bot');
    });
});

describe('rangesFromBlame', () => {
    const commits = new Map<string, AttributedCommit>([['a'.repeat(40), { agent: 'copilot', evidence: 'x', time: 0, subject: 's' }]]);
    test("keeps AI commits' runs, merging adjacent ones", () => {
        const runs = [
            { start: 5, count: 2, commit: 'a'.repeat(40) },
            { start: 1, count: 3, commit: 'b'.repeat(40) },
            { start: 7, count: 1, commit: 'a'.repeat(40) },
            { start: 10, count: 2, commit: 'a'.repeat(40) },
        ];
        assert.deepStrictEqual(
            rangesFromBlame(runs, commits).map((r) => `${r.start}-${r.end}:${r.origin}:${r.agent}:${r.confidence}`),
            ['5-7:ai:copilot:declared', '10-11:ai:copilot:declared']
        );
    });
});

describe('AuthorshipIndex', () => {
    const files = ['api/routes.ts', 'api/handlers.ts', 'core/orders.ts', 'core/util.ts'];
    const graph: ArchitectureGraph = {
        nodes: files.map((id) => ({ id, label: id, filePath: id, type: NodeType.File, symbols: [], metadata: {} })),
        edges: [{ id: 'e', source: 'api/routes.ts', target: 'api/handlers.ts', type: EdgeType.Import, weight: 1, metadata: {} }],
        subsystems: [],
        metadata: { analyzedAt: 0, fileCount: files.length, totalSymbols: 0, totalEdges: 1, languages: [] },
    };
    const index = new HierarchyIndex(buildHierarchy(graph, { systemName: 'shop' }));
    const t1 = Date.UTC(2026, 10, 3, 12); // a Tuesday
    const t2 = Date.UTC(2026, 10, 12, 9);
    const commits = new Map<string, AttributedCommit>([
        ['c1', { agent: 'claude-code', evidence: 'Co-authored-by: Claude', time: t1, subject: 'Add handlers' }],
        ['c2', { agent: 'copilot', evidence: 'bot', time: t2, subject: 'Orders' }],
    ]);
    const lines: Record<string, number> = { 'api/routes.ts': 10, 'api/handlers.ts': 40, 'core/orders.ts': 100, 'core/util.ts': 20 };
    const a = new AuthorshipIndex(index, (p) => lines[p], {
        ranges: new Map([
            ['api/handlers.ts', [{ start: 1, end: 30, origin: 'ai', agent: 'claude-code', confidence: 'declared', commit: 'c1' }]],
            ['core/orders.ts', [{ start: 1, end: 10, origin: 'ai', agent: 'copilot', confidence: 'declared', commit: 'c2' }, { start: 50, end: 59, origin: 'reviewed', agent: 'copilot', commit: 'c2' }]],
        ]),
        commits,
        stats: { commits: 12, aiCommits: 2, blamedFiles: 2 },
    });

    test('counts lines per origin for files and every container', () => {
        assert.deepStrictEqual(a.fileCounts('api/handlers.ts'), { ai: 30, reviewed: 0, human: 0, unknown: 10 });
        assert.deepStrictEqual(a.counts('sys:root'), { ai: 40, reviewed: 10, human: 0, unknown: 120 });
        assert.deepStrictEqual(a.counts('dir:api'), { ai: 30, reviewed: 0, human: 0, unknown: 20 });
        assert.strictEqual(a.counts('nope'), undefined);
        assert.deepStrictEqual(a.status(), { state: 'ready', commits: 12, aiCommits: 2, blamedFiles: 2, counts: { ai: 40, reviewed: 10, human: 0, unknown: 120 } });
    });

    test('decorates a view for the lens', () => {
        const v = a.decorate(index.project());
        const byKey = Object.fromEntries(v.nodes.map((n) => [n.key, n.authorship]));
        assert.deepStrictEqual(byKey['dir:core'], { ai: 10, reviewed: 10, human: 0, unknown: 100 });
    });

    test('describes a node: agents, AI-heavy files, weekly timeline and commits', () => {
        const d = a.describe('sys:root')!;
        assert.deepStrictEqual(d.byAgent, { 'claude-code': 30, copilot: 20 });
        assert.deepStrictEqual(d.topFiles, [{ path: 'api/handlers.ts', ai: 30, lines: 40 }, { path: 'core/orders.ts', ai: 10, lines: 100 }]);
        assert.deepStrictEqual(d.weekly, [{ week: weekOf(t1), ai: 30 }, { week: weekOf(t2), ai: 10 }]);
        assert.deepStrictEqual(d.commits.map((c) => `${c.hash}:${c.agent}:${c.lines}`), ['c1:claude-code:30', 'c2:copilot:20']);
        const file = a.describe('mod:core/orders.ts')!;
        assert.strictEqual(file.ranges!.length, 2);
        assert.deepStrictEqual(file.topFiles, []);
    });

    test('weeks start on Monday (UTC)', () => {
        assert.strictEqual(new Date(weekOf(t1)).getUTCDay(), 1);
        assert.strictEqual(weekOf(Date.UTC(2026, 10, 2, 0)), Date.UTC(2026, 10, 2)); // a Monday is its own week
    });
});
