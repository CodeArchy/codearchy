import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { computeGitAuthorship, parseIncrementalBlame } from '../src/index.js';

const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });

function repo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codearchy-authorship-'));
    git(dir, 'init', '-q', '-b', 'main');
    fs.mkdirSync(path.join(dir, 'app', 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'app', 'src', 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
    fs.writeFileSync(path.join(dir, 'app', 'src', 'old.ts'), 'export function old() {}\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'Initial commit');
    // An AI-assisted commit adds lines to a.ts and rewrites old.ts…
    fs.appendFileSync(path.join(dir, 'app', 'src', 'a.ts'), 'export const c = 3;\nexport const d = 4;\n');
    fs.writeFileSync(path.join(dir, 'app', 'src', 'old.ts'), 'export function old() {\n    return 42;\n}\n');
    git(dir, 'commit', '-q', '-am', 'Add c and d\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
    // …then a human renames old.ts (blame follows the move) and a colleague called Claude commits.
    git(dir, 'mv', 'app/src/old.ts', 'app/src/renamed.ts');
    git(dir, 'commit', '-q', '-m', 'Rename old.ts');
    fs.appendFileSync(path.join(dir, 'app', 'src', 'a.ts'), 'export const e = 5;\n');
    git(dir, 'commit', '-q', '-am', 'Add e\n\nCo-authored-by: Claude Dupont <claude@acme.com>');
    return dir;
}

describe('computeGitAuthorship', () => {
    test("traces AI commits onto today's lines, through renames, from a workspace subfolder", async () => {
        const dir = repo();
        try {
            const result = await computeGitAuthorship(path.join(dir, 'app'), ['src/a.ts', 'src/renamed.ts']);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.data.stats).toEqual({ commits: 4, aiCommits: 1, blamedFiles: 2 });
            const a = result.data.ranges.get('src/a.ts')!;
            expect(a.map((r) => `${r.start}-${r.end}:${r.origin}:${r.agent}`)).toEqual(['3-4:ai:claude-code']);
            const renamed = result.data.ranges.get('src/renamed.ts')!;
            expect(renamed.map((r) => `${r.start}-${r.end}`)).toEqual(['1-3']);
            const [c] = [...result.data.commits.values()];
            expect(c).toMatchObject({ agent: 'claude-code', subject: 'Add c and d', evidence: 'Co-authored-by: Claude <noreply@anthropic.com>' });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('a folder outside git has nothing to attribute', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codearchy-nogit-'));
        try {
            const result = await computeGitAuthorship(dir, []);
            expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/not in a git repository/) });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('parses incremental blame headers only', () => {
        const out = ['a'.repeat(40) + ' 1 1 2', 'author Ada', 'filename x.ts', 'b'.repeat(40) + ' 3 3 1', 'summary not a header 1 2 3', 'filename x.ts'].join('\n');
        expect(parseIncrementalBlame(out)).toEqual([
            { start: 1, count: 2, commit: 'a'.repeat(40) },
            { start: 3, count: 1, commit: 'b'.repeat(40) },
        ]);
    });
});
