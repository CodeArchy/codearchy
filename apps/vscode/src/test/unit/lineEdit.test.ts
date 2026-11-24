import * as assert from 'assert';
import { breaks, lineEditOf } from '../../authorship/lineEdit';

const change = (startLine: number, startChar: number, endLine: number, rangeLength: number, text: string) => ({
    range: { start: { line: startLine, character: startChar }, end: { line: endLine } },
    rangeLength,
    text,
});

suite('authorship: editor changes as line edits', () => {
    test('whole lines inserted at a line start are a pure insertion', () => {
        // 3 lines inserted before (0-based) line 4 → before line 5, nothing replaced.
        assert.deepStrictEqual(lineEditOf(change(4, 0, 4, 0, 'a\nb\nc\n')), { start: 5, end: 4, inserted: 3 });
    });

    test('typing inside a line changes that line', () => {
        assert.deepStrictEqual(lineEditOf(change(9, 7, 9, 0, 'x')), { start: 10, end: 10, inserted: 1 });
    });

    test('a block pasted or inserted mid-line replaces the line with several', () => {
        assert.deepStrictEqual(lineEditOf(change(2, 4, 2, 0, 'one\ntwo\nthree')), { start: 3, end: 3, inserted: 3 });
    });

    test('a selection across lines replaced by one line', () => {
        assert.deepStrictEqual(lineEditOf(change(5, 2, 8, 40, 'y')), { start: 6, end: 9, inserted: 1 });
    });

    test('deleting whole lines', () => {
        // Lines 3-4 (0-based) deleted from their start to the next line's start.
        assert.deepStrictEqual(lineEditOf(change(3, 0, 5, 20, '')), { start: 4, end: 6, inserted: 1 });
        assert.strictEqual(breaks('a\nb\n'), 2);
    });
});
