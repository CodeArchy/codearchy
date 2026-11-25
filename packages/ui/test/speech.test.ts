import { describe, expect, test } from 'vitest';
import { SpeechChunker, speechChunks } from '../src/speech/chunker.js';

const STEP =
    'The big picture. polyglot sample has 38 source files in 5 top-level parts: [@poly/shared](node:pkg:shared), [app](node:pkg:app), [php](node:pkg:php), [poly](node:pkg:poly) and [rusty-core](node:pkg:rust). It is split into 5 packages, each with its own manifest. Most of the code is in [poly](node:pkg:poly). [@poly/shared](node:pkg:shared) is the most depended-on part, so it\'s a good anchor while you explore. Double-click a part on the map to open it in place; the Inspector on the right summarises whatever you select.';

const ANSWER = [
    'Requests enter through [routes.ts](node:mod:src/api/routes.ts), which hands each one to a handler.',
    '',
    '- **Login** goes to [auth/service.ts](node:mod:src/auth/service.ts), e.g. to check the password.',
    '- Orders go to `placeOrder` in [orders/service.ts](node:mod:src/orders/service.ts).',
    '',
    '```ts',
    'router.post("/orders", createOrder);',
    '```',
    '',
    '1. Then the data layer writes to PostgreSQL.',
].join('\n');

describe('speech chunks', () => {
    test('start short and grow (so synthesis stays ahead), cutting at sentences and clauses', () => {
        const chunks = speechChunks(STEP);
        expect(chunks[0]!.text).toBe('The big picture.');
        // Every chunk ends at punctuation or a word, never mid-word; sizes grow from small.
        for (const c of chunks) expect(c.text).toMatch(/^\S.*\S$/);
        expect(chunks[1]!.text.length).toBeLessThanOrEqual(60);
        const lengths = chunks.map((c) => c.text.length);
        expect(Math.max(...lengths.slice(0, 3))).toBeLessThan(80);
        expect(chunks.map((c) => c.text).join(' ')).toBe(
            "The big picture. polyglot sample has 38 source files in 5 top-level parts: @poly/shared, app, php, poly and rusty-core. It is split into 5 packages, each with its own manifest. Most of the code is in poly. @poly/shared is the most depended-on part, so it's a good anchor while you explore. Double-click a part on the map to open it in place; the Inspector on the right summarises whatever you select."
        );
    });

    test('links become their label and mark the chunk with their node; a label is never split', () => {
        const chunks = speechChunks(STEP);
        const withShared = chunks.filter((c) => c.keys.includes('pkg:shared'));
        expect(withShared.length).toBeGreaterThanOrEqual(1);
        for (const c of chunks) for (const label of ['@poly/shared', 'rusty-core']) if (c.keys.includes(label)) expect(c.text).toContain(label);
        expect(chunks.flatMap((c) => c.keys)).toContain('pkg:rust');
    });

    test('markdown answers: bullets and emphasis go, code blocks are skipped, inline code is read', () => {
        const text = speechChunks(ANSWER).map((c) => c.text).join(' ');
        expect(text).not.toMatch(/[*`#]|router\.post|\]\(/);
        expect(text).toContain('Login goes to auth/service.ts, e.g. to check the password.');
        expect(text).toContain('Orders go to placeOrder in orders/service.ts.');
        expect(text).toContain('Then the data layer writes to PostgreSQL.');
        expect(text).not.toMatch(/e\.g\.\s*$/); // "e.g." doesn't end a chunk on its own
        expect(speechChunks(ANSWER).flatMap((c) => c.keys)).toEqual(['mod:src/api/routes.ts', 'mod:src/auth/service.ts', 'mod:src/orders/service.ts']);
    });

    test('streamed in any pieces, the chunks are exactly those of the whole text (replays hit the cache)', () => {
        for (const source of [STEP, ANSWER]) {
            const whole = speechChunks(source);
            for (let seed = 1; seed <= 40; seed++) {
                const c = new SpeechChunker();
                const got = [];
                let i = 0;
                let r = seed;
                while (i < source.length) {
                    r = (r * 1103515245 + 12345) % 2147483648;
                    const n = 1 + (r % 9);
                    got.push(...c.push(source.slice(i, i + n)));
                    i += n;
                }
                got.push(...c.end());
                expect(got).toEqual(whole);
            }
        }
    });

    test('the first chunk comes out while the answer is still streaming', () => {
        const c = new SpeechChunker();
        expect(c.push('Requests enter through [routes')).toEqual([]);
        expect(c.push('.ts](node:mod:src/api/routes.ts), which hands each one to a handler. Then')).toEqual([
            { text: 'Requests enter through routes.ts,', keys: ['mod:src/api/routes.ts'] },
            { text: 'which hands each one to a handler.', keys: [] },
        ]);
    });

    test('odd input: unclosed brackets and code are read as text at the end; nothing speakable, nothing said', () => {
        expect(speechChunks('Look at [this and `that').map((c) => c.text)).toEqual(['Look at [this and that']);
        expect(speechChunks('```\nconst x = 1;\n```\n')).toEqual([]);
        expect(speechChunks('...')).toEqual([]);
    });
});
