import { describe, expect, it } from 'vitest';
import { parseAnswer, parseInline } from '../src/answer.js';

describe('chat answer parsing', () => {
    it('parses paragraphs, headings, lists and code blocks', () => {
        const blocks = parseAnswer('## Short answer\nLogin lives in auth.\n\n- one\n- two\n  continued\n\n1. first\n2. second\n\n```ts\nconst a = 1;\n```');
        expect(blocks.map((b) => b.t)).toEqual(['h', 'p', 'ul', 'ol', 'pre']);
        expect(blocks[2]).toEqual({
            t: 'ul',
            items: [[{ t: 'text', text: 'one' }], [{ t: 'text', text: 'two' }, { t: 'text', text: ' ' }, { t: 'text', text: 'continued' }]],
        });
        expect(blocks[4]).toEqual({ t: 'pre', text: 'const a = 1;' });
    });

    it('turns node: and file: links into citations, with code and bold inside', () => {
        expect(parseInline('See [`session.ts`](node:mod:src/auth/session.ts) and [login, line 42](file:src/auth/session.ts#L42) — **really**.')).toEqual([
            { t: 'text', text: 'See ' },
            { t: 'node', key: 'mod:src/auth/session.ts', label: [{ t: 'code', text: 'session.ts' }] },
            { t: 'text', text: ' and ' },
            { t: 'file', path: 'src/auth/session.ts', line: 42, label: [{ t: 'text', text: 'login, line 42' }] },
            { t: 'text', text: ' — ' },
            { t: 'bold', children: [{ t: 'text', text: 'really' }] },
            { t: 'text', text: '.' },
        ]);
    });

    it('never produces markup: HTML stays text, other links are not followable', () => {
        const nodes = parseInline('<img src=x onerror=alert(1)> [click](javascript:alert(1)) [docs](https://example.com)');
        expect(nodes.every((n) => n.t === 'text')).toBe(true);
        expect(nodes.map((n) => (n as { text: string }).text).join('')).toBe('<img src=x onerror=alert(1)> click (javascript:alert(1)) docs (https://example.com)');
    });

    it('leaves unbalanced markers alone and stays linear on long input', () => {
        expect(parseInline('a ` b ** c [d')).toEqual([{ t: 'text', text: 'a ` b ** c [d' }]);
        const t = Date.now();
        parseAnswer('['.repeat(200_000) + '*'.repeat(200_000) + 'x](' + '('.repeat(200_000));
        expect(Date.now() - t).toBeLessThan(1000);
    });
});
