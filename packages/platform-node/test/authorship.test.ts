import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { computeGitAuthorship, parseIncrementalBlame, readAuthorshipNotes, writeAuthorshipNote } from '../src/index.js';

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
            expect(result.data.stats).toEqual({ commits: 4, aiCommits: 1, blamedFiles: 2, notedCommits: 0 });
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
            { start: 1, count: 2, commit: 'a'.repeat(40), orig: 1, file: 'x.ts' },
            { start: 3, count: 1, commit: 'b'.repeat(40), orig: 3, file: 'x.ts' },
        ]);
    });
});

describe('authorship notes in git', () => {
    test('a note written for a commit is read back as exact lines, through later edits and renames', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codearchy-notes-'));
        try {
            git(dir, 'init', '-q', '-b', 'main');
            const lines = ['export function a() {', '    return computeAnswer();', '}', 'export const b = 2;', ''];
            fs.writeFileSync(path.join(dir, 'x.ts'), lines.join('\n'));
            fs.writeFileSync(path.join(dir, 'y.ts'), 'export const y = 1;\n');
            git(dir, 'add', '.');
            git(dir, 'commit', '-q', '-m', 'Add x and y'); // no AI markers: only the note will say anything
            const read = async (rel: string) => fs.promises.readFile(path.join(dir, rel), 'utf8').catch(() => undefined);
            fs.appendFileSync(path.join(dir, 'y.ts'), '// changed after the commit\n');
            const written = await writeAuthorshipNote(dir, (rel) => (rel === 'x.ts' ? [{ start: 1, end: 3, origin: 'ai', agent: 'claude-code', confidence: 'verified' }] : rel === 'y.ts' ? [{ start: 1, end: 1, origin: 'ai' }] : []), read);
            expect(written.files).toEqual(['x.ts']);
            expect(written.skipped).toEqual(['y.ts']); // differs from the commit: its lines wouldn't match
            git(dir, 'checkout', '-q', 'y.ts');
            // A second note on the same commit merges with the first.
            const second = await writeAuthorshipNote(dir, (rel) => (rel === 'y.ts' ? [{ start: 1, end: 1, origin: 'human' }] : []), read);
            expect(second.files).toEqual(['y.ts']);
            expect(Object.keys((await readAuthorshipNotes(dir)).values().next().value!.files).sort()).toEqual(['x.ts', 'y.ts']);

            let result = await computeGitAuthorship(dir, ['x.ts', 'y.ts']);
            expect(result.ok && result.data.stats).toMatchObject({ aiCommits: 0, notedCommits: 1, blamedFiles: 2 });
            expect(result.ok && result.data.ranges.get('x.ts')!.map((r) => `${r.start}-${r.end}:${r.origin}:${r.agent}`)).toEqual(['1-3:ai:claude-code']);
            expect(result.ok && [...result.data.commits.values()][0]).toMatchObject({ agent: 'claude-code', evidence: 'authorship note', subject: 'Add x and y' });

            // Two lines added on top, then the file renamed: the note still lands on the same code.
            fs.writeFileSync(path.join(dir, 'x.ts'), ['// header', '// more', ...lines].join('\n'));
            git(dir, 'commit', '-q', '-am', 'Header');
            git(dir, 'mv', 'x.ts', 'z.ts');
            git(dir, 'commit', '-q', '-m', 'Rename');
            result = await computeGitAuthorship(dir, ['z.ts', 'y.ts']);
            expect(result.ok && result.data.ranges.get('z.ts')!.map((r) => `${r.start}-${r.end}:${r.origin}`)).toEqual(['3-5:ai']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
