import { describe, test } from 'vitest';
import * as assert from 'node:assert';
import type { AuthorshipRange } from '@codearchy/protocol';
import { AuthorshipLedger, overlayRanges } from '../src/index.js';

const show = (rs: AuthorshipRange[]) => rs.map((r) => `${r.start}-${r.end}:${r.origin}${r.agent ? `:${r.agent}` : ''}`);
const T = 1_000;

describe('AuthorshipLedger: edits', () => {
    const withAi = () => {
        const l = new AuthorshipLedger();
        l.applyEdit('a.ts', { start: 5, end: 4, inserted: 3, by: 'ai', agent: 'copilot' }, undefined, T); // insert lines 5-7
        return l;
    };

    test('an AI insertion is recorded as inferred, with its tool', () => {
        const l = withAi();
        assert.deepStrictEqual(show(l.ranges('a.ts')), ['5-7:ai:copilot']);
        assert.strictEqual(l.ranges('a.ts')[0]!.confidence, 'inferred');
        assert.strictEqual(l.ranges('a.ts')[0]!.source, 'capture');
    });

    test('edits above shift the range; a person editing inside reviews it', () => {
        const l = withAi();
        l.applyEdit('a.ts', { start: 1, end: 0, inserted: 2, by: 'human' }); // two lines typed above
        assert.deepStrictEqual(show(l.ranges('a.ts')), ['7-9:ai:copilot']);
        l.applyEdit('a.ts', { start: 8, end: 8, inserted: 1, by: 'human' }); // a person changes line 8
        assert.deepStrictEqual(show(l.ranges('a.ts')), ['7-9:reviewed:copilot']);
    });

    test('a tool edit (formatter, reload) keeps the attribution; deletions shrink or remove ranges', () => {
        const l = withAi();
        l.applyEdit('a.ts', { start: 6, end: 6, inserted: 1, by: 'unknown' });
        assert.deepStrictEqual(show(l.ranges('a.ts')), ['5-7:ai:copilot']);
        l.applyEdit('a.ts', { start: 7, end: 7, inserted: 0, by: 'human' }); // the last line deleted
        assert.deepStrictEqual(show(l.ranges('a.ts')), ['5-6:reviewed:copilot']);
        l.applyEdit('a.ts', { start: 4, end: 7, inserted: 1, by: 'human' }); // the whole block replaced
        assert.deepStrictEqual(show(l.ranges('a.ts')), []);
    });

    test("replacing a range's head or tail keeps the other part, not the new lines", () => {
        const head = withAi();
        head.applyEdit('a.ts', { start: 4, end: 5, inserted: 4, by: 'unknown' }); // lines 4-5 → 4 new lines (4-7)
        assert.deepStrictEqual(show(head.ranges('a.ts')), ['8-9:ai:copilot']);
        const tail = withAi();
        tail.applyEdit('a.ts', { start: 7, end: 9, inserted: 1, by: 'unknown' });
        assert.deepStrictEqual(show(tail.ranges('a.ts')), ['5-6:ai:copilot']);
    });

    test('a newer AI insertion over an old range replaces it there', () => {
        const l = withAi();
        l.applyEdit('a.ts', { start: 6, end: 6, inserted: 1, by: 'ai', agent: 'claude-code' });
        assert.deepStrictEqual(show(l.ranges('a.ts')), ['5-5:ai:copilot', '6-6:ai:claude-code', '7-7:ai:copilot']);
    });
});

describe('AuthorshipLedger: review and correction', () => {
    test('mark reviewed splits the selection out of an AI range', () => {
        const l = new AuthorshipLedger();
        l.applyEdit('a.ts', { start: 1, end: 0, inserted: 10, by: 'ai', agent: 'cursor' });
        assert.strictEqual(l.markReviewed('a.ts', 4, 6), 3);
        assert.deepStrictEqual(show(l.ranges('a.ts')), ['1-3:ai:cursor', '4-6:reviewed:cursor', '7-10:ai:cursor']);
        assert.strictEqual(l.ranges('a.ts')[1]!.source, 'review');
        assert.strictEqual(l.markReviewed('a.ts', 4, 6), 0); // nothing left to review there
    });

    test('adjacent ranges that say the same thing merge', () => {
        const l = new AuthorshipLedger();
        l.applyEdit('a.ts', { start: 1, end: 0, inserted: 4, by: 'ai', agent: 'cursor' });
        l.markReviewed('a.ts', 2, 2);
        l.markReviewed('a.ts', 1, 1);
        assert.deepStrictEqual(show(l.ranges('a.ts')), ['1-2:reviewed:cursor', '3-4:ai:cursor']);
    });

    test('split pieces survive a reconcile (their anchors are recomputed, not inherited)', () => {
        const text = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');
        const l = new AuthorshipLedger();
        l.applyEdit('a.ts', { start: 1, end: 0, inserted: 10, by: 'ai', agent: 'cursor' }, text);
        l.markReviewed('a.ts', 4, 6);
        l.reconcile('a.ts', text);
        assert.deepStrictEqual(show(l.ranges('a.ts')), ['1-3:ai:cursor', '4-6:reviewed:cursor', '7-10:ai:cursor']);
    });

    test('a correction overrides what was recorded, as declared by the person', () => {
        const l = new AuthorshipLedger();
        l.applyEdit('a.ts', { start: 1, end: 0, inserted: 10, by: 'ai', agent: 'cursor' });
        l.correct('a.ts', 3, 4, 'human');
        assert.deepStrictEqual(show(l.ranges('a.ts')), ['1-2:ai:cursor', '3-4:human', '5-10:ai:cursor']);
        assert.strictEqual(l.ranges('a.ts')[1]!.confidence, 'declared');
        l.correct('a.ts', 1, 10, 'unknown');
        assert.deepStrictEqual(show(l.ranges('a.ts')), []);
    });
});

describe('AuthorshipLedger: changes it did not see', () => {
    const file = (pre: number, body: string[]) => [...Array.from({ length: pre }, (_, i) => `// line ${i}`), ...body, '// end'].join('\n');

    test('re-finds moved text by its anchor, and drops rewritten text', () => {
        const l = new AuthorshipLedger();
        const body = ['function ai() {', '  return 42;', '}'];
        l.applyEdit('a.ts', { start: 3, end: 2, inserted: 3, by: 'ai', agent: 'codex' }, file(2, body));
        l.reconcile('a.ts', file(5, body)); // three lines appeared above, outside the editor
        assert.deepStrictEqual(show(l.ranges('a.ts')), ['6-8:ai:codex']);
        l.reconcile('a.ts', file(5, ['function ai() {', '  return 43;', '}'])); // rewritten
        assert.deepStrictEqual(show(l.ranges('a.ts')), []);
    });

    test('rename and remove', () => {
        const l = new AuthorshipLedger();
        l.applyEdit('a.ts', { start: 1, end: 0, inserted: 1, by: 'ai' });
        l.rename('a.ts', 'b.ts');
        assert.deepStrictEqual(l.paths(), ['b.ts']);
        l.remove('b.ts');
        assert.deepStrictEqual(l.paths(), []);
    });

    test('saves and loads; ignores anything malformed', () => {
        const l = new AuthorshipLedger();
        l.applyEdit('a.ts', { start: 1, end: 0, inserted: 2, by: 'ai', agent: 'aider' });
        assert.strictEqual(l.takeChanged(), true);
        assert.strictEqual(l.takeChanged(), false);
        const back = AuthorshipLedger.from(JSON.parse(JSON.stringify(l)));
        assert.deepStrictEqual(show(back.ranges('a.ts')), ['1-2:ai:aider']);
        const bad = AuthorshipLedger.from({ version: 1, files: { 'x.ts': [{ start: 0, end: 2, origin: 'ai' }, { start: 3, end: 1, origin: 'ai' }, { start: 1, end: 1, origin: 'nope' }, 'junk'] } });
        assert.deepStrictEqual(bad.paths(), []);
        assert.deepStrictEqual(AuthorshipLedger.from({ version: 99 }).paths(), []);
    });
});

describe('overlayRanges', () => {
    const git: AuthorshipRange[] = [{ start: 1, end: 10, origin: 'ai', agent: 'claude-code', confidence: 'declared', commit: 'c1' }];

    test('the ledger wins where it overlaps: reviews and corrections cut into git ranges', () => {
        assert.deepStrictEqual(show(overlayRanges(git, [{ start: 3, end: 4, origin: 'reviewed', agent: 'claude-code', confidence: 'declared' }])), [
            '1-2:ai:claude-code',
            '3-4:reviewed:claude-code',
            '5-10:ai:claude-code',
        ]);
        assert.deepStrictEqual(show(overlayRanges(git, [{ start: 12, end: 13, origin: 'ai', agent: 'copilot', confidence: 'inferred' }])), ['1-10:ai:claude-code', '12-13:ai:copilot']);
    });

    test("an inferred capture never replaces a commit's declared AI attribution", () => {
        assert.deepStrictEqual(show(overlayRanges(git, [{ start: 2, end: 3, origin: 'ai', agent: 'unknown-ai', confidence: 'inferred' }])), ['1-10:ai:claude-code']);
    });
});
