import { describe, test } from 'vitest';
import * as assert from 'node:assert';
import { parseNote, projectNotes, serializeNote, type AuthorshipNote } from '../src/index.js';

describe('authorship notes', () => {
    test('round-trip: unknown ranges are never written', () => {
        const text = serializeNote(new Map([['src/a.ts', [{ start: 2, end: 3, origin: 'ai', agent: 'claude-code', confidence: 'verified' }, { start: 4, end: 9, origin: 'unknown' }]]]));
        assert.deepStrictEqual(parseNote(text), { version: 1, files: { 'src/a.ts': [{ start: 2, end: 3, origin: 'ai', agent: 'claude-code', confidence: 'verified' }] } });
    });

    test('junk, other versions, unsafe paths and bad ranges are refused', () => {
        assert.strictEqual(parseNote('not json'), undefined);
        assert.strictEqual(parseNote(JSON.stringify({ version: 2, files: {} })), undefined);
        const n = parseNote(JSON.stringify({ version: 1, files: { '../x.ts': [{ start: 1, end: 1, origin: 'ai' }], 'a.ts': [{ start: 0, end: 1, origin: 'ai' }, { start: 3, end: 2, origin: 'ai' }, { start: 1, end: 1, origin: 'unknown' }, { start: 5, end: 6, origin: 'human', confidence: 'nope' }] } }));
        assert.deepStrictEqual(n, { version: 1, files: { 'a.ts': [{ start: 5, end: 6, origin: 'human' }] } });
    });

    test("projects noted lines through blame runs onto today's numbering", () => {
        const notes = new Map<string, AuthorshipNote>([['c1', { version: 1, files: { 'old/a.ts': [{ start: 2, end: 5, origin: 'ai', agent: 'copilot' }] } }]]);
        // Today: 3 new lines on top (another commit), then c1's lines 1-6 at 4-9 (the file was renamed since).
        const runs = [
            { start: 1, count: 3, commit: 'c2', orig: 1, file: 'new/a.ts' },
            { start: 4, count: 6, commit: 'c1', orig: 1, file: 'old/a.ts' },
        ];
        assert.deepStrictEqual(projectNotes(runs, notes), [{ start: 5, end: 8, origin: 'ai', agent: 'copilot', confidence: 'declared', commit: 'c1' }]);
        // A later edit split c1's run: only the surviving parts are attributed.
        const split = [
            { start: 1, count: 2, commit: 'c1', orig: 1, file: 'old/a.ts' },
            { start: 3, count: 1, commit: 'c3', orig: 3, file: 'old/a.ts' },
            { start: 4, count: 3, commit: 'c1', orig: 4, file: 'old/a.ts' },
        ];
        assert.deepStrictEqual(projectNotes(split, notes).map((r) => `${r.start}-${r.end}`), ['2-2', '4-5']);
    });
});
