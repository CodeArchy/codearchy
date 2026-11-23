// Run with: node --test webview-ui/test/   (Node >= 22.18 strips TypeScript types natively)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PhraseChunker, cleanText } from '../src/voice/phraseChunker.ts';

/** Streams `text` into a chunker in small deltas, like an LLM would. */
function stream(text: string, step = 3): { phrases: string[]; firstAt: number } {
    const c = new PhraseChunker();
    const phrases: string[] = [];
    let firstAt = -1;
    for (let i = 0; i < text.length; i += step) {
        const out = c.push(text.slice(i, i + step));
        if (out.length && firstAt < 0) firstAt = i + step;
        phrases.push(...out);
    }
    phrases.push(...c.flush());
    return { phrases, firstAt };
}

const ANSWER =
    'The Auth Service validates tokens, then calls the User Repository. ' +
    'It caches sessions in Redis for fifteen minutes. If the cache misses, it reads Postgres. ' +
    'Finally, the gateway forwards the request to the Orders API.';

test('first phrase is short: released at the first clause after 4 words', () => {
    const { phrases, firstAt } = stream(ANSWER);
    assert.equal(phrases[0], 'The Auth Service validates tokens,');
    assert.ok(firstAt <= 40, `first phrase should be ready within ~40 chars, got ${firstAt}`);
});

test('later phrases are sentence sized and nothing is lost or duplicated', () => {
    const { phrases } = stream(ANSWER);
    assert.deepEqual(phrases.slice(1), [
        'then calls the User Repository.',
        'It caches sessions in Redis for fifteen minutes.',
        'If the cache misses, it reads Postgres.',
        'Finally, the gateway forwards the request to the Orders API.',
    ]);
    const words = (s: string) => s.replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);
    assert.deepEqual(words(phrases.join(' ')), words(ANSWER));
});

test('first phrase falls back to 12 words when there is no punctuation', () => {
    const { phrases } = stream('one two three four five six seven eight nine ten eleven twelve thirteen fourteen');
    assert.equal(phrases[0], 'one two three four five six seven eight nine ten eleven twelve');
});

test('result is identical whatever the delta size', () => {
    const a = stream(ANSWER, 1).phrases;
    for (const step of [2, 5, 17, 1000]) assert.deepEqual(stream(ANSWER, step).phrases, a);
});

test('code fences are skipped, including fences split across deltas', () => {
    const md = 'Here is the handler you asked about:\n```ts\nexport function login() { return 1; }\n```\nIt returns early when the token is valid.';
    for (const step of [1, 4, 9]) {
        const { phrases } = stream(md, step);
        assert.ok(!phrases.join(' ').includes('login()'), `code leaked at step ${step}: ${phrases}`);
        assert.equal(phrases[0], 'Here is the handler you asked about:');
        assert.equal(phrases.at(-1), 'It returns early when the token is valid.');
    }
});

test('never cuts inside inline code, links or bold; markdown is cleaned', () => {
    const md = 'See the `AuthService.validate, refresh` method in [the auth docs, section two](https://x.dev/a, b) and **note, carefully** the retry.';
    const { phrases } = stream(md, 2);
    const all = phrases.join(' ');
    assert.ok(!/[`*\[\]]|https?:/.test(all), all);
    assert.ok(all.includes('the auth docs, section two'));
    assert.ok(all.includes('note, carefully'));
});

test('abbreviations and version numbers do not end a sentence', () => {
    const { phrases } = stream('We support many runtimes, e.g. Node and Deno. Version 2.1 adds caching to the index store.');
    assert.ok(phrases.some((p) => p.includes('e.g. Node and Deno.')), phrases.join(' | '));
    assert.ok(phrases.some((p) => p.includes('Version 2.1 adds caching')), phrases.join(' | '));
});

test('list items become separate phrases without their markers', () => {
    const { phrases } = stream('The main parts are:\n- the parser that reads files\n- the resolver that links imports\n- the graph builder');
    assert.deepEqual(phrases, ['The main parts are:', 'the parser that reads files', 'the resolver that links imports', 'the graph builder']);
});

test('runaway sentences are capped near maxChars at a clause or space', () => {
    const long = 'This sentence keeps going ' + 'and going '.repeat(40) + 'until it ends.';
    const { phrases } = stream('Short start, then more. ' + long);
    for (const p of phrases) assert.ok(p.length <= 210, `${p.length}: ${p}`);
});

test('cleanText strips markdown and math', () => {
    assert.equal(cleanText('## Title\n**Bold** and `code` with $x^2$ and [link](http://a)'), 'Title\nBold and with and link');
});

test('cleanText leaves no angle brackets behind', () => {
    for (const input of ['a <scr<script>ipt>b</script> c', 'x < y > z', '<<b>>bold<</b>>', 'unclosed <img src=x']) {
        assert.doesNotMatch(cleanText(input), /[<>]/, input);
    }
    assert.equal(cleanText('Use <b>bold</b> text'), 'Use bold text');
});
