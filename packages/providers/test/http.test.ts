import { describe, expect, it } from 'vitest';
import { errorFromStatus } from '../src/errors.js';
import { joinUrl, lines, redact, retryAfterMs, sse } from '../src/http.js';

function streamOf(...chunks: Array<string | Uint8Array>) {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
        start(c) {
            for (const chunk of chunks) c.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
            c.close();
        },
    });
}

async function all<T>(gen: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const x of gen) out.push(x);
    return out;
}

describe('stream readers', () => {
    it('splits lines across chunk boundaries, LF and CRLF', async () => {
        expect(await all(lines(streamOf('a\r\nb', 'c\n', '\nd')))).toEqual(['a', 'bc', '', 'd']);
    });

    it('decodes a multi-byte character split between chunks', async () => {
        const bytes = new TextEncoder().encode('é→ok\n');
        expect(await all(lines(streamOf(bytes.slice(0, 1), bytes.slice(1, 4), bytes.slice(4))))).toEqual(['é→ok']);
    });

    it('parses SSE: event names, multi-line data, comments, a missing trailing blank line', async () => {
        const events = await all(sse(streamOf(': keep-alive\n', 'event: x\ndata: 1\ndata: 2\n\n', 'data:3')));
        expect(events).toEqual([
            { event: 'x', data: '1\n2' },
            { event: undefined, data: '3' },
        ]);
    });
});

describe('errors', () => {
    const h = (v: Record<string, string>) => ({ get: (k: string) => v[k] ?? null });

    it('reads Retry-After as seconds, an HTTP date, or retry-after-ms', () => {
        expect(retryAfterMs(h({ 'retry-after': '2' }))).toBe(2000);
        expect(retryAfterMs(h({ 'retry-after-ms': '150' }))).toBe(150);
        expect(retryAfterMs(h({ 'retry-after': new Date(10_000).toUTCString() }), 7_000)).toBe(3000);
        expect(retryAfterMs(h({}))).toBeUndefined();
    });

    it('maps statuses to the taxonomy', () => {
        expect(errorFromStatus('p', 401, '{}').code).toBe('auth');
        expect(errorFromStatus('p', 429, '{"error":{"message":"slow down"}}', 500)).toMatchObject({
            code: 'rate_limit',
            message: 'slow down',
            retryAfterMs: 500,
            retryable: true,
        });
        expect(errorFromStatus('p', 429, '{"error":{"code":"insufficient_quota"}}').code).toBe('quota');
        expect(errorFromStatus('p', 400, '{"error":{"code":"context_length_exceeded"}}').code).toBe('context_overflow');
        expect(errorFromStatus('p', 400, '{"error":{"message":"API key not valid. Please pass a valid API key."}}').code).toBe(
            'auth',
        );
        expect(errorFromStatus('p', 503, 'busy')).toMatchObject({ code: 'unavailable', retryable: true });
        expect(errorFromStatus('p', 404, '{"error":"model not found"}')).toMatchObject({
            code: 'bad_request',
            message: 'model not found',
            retryable: false,
        });
    });

    it('joins URLs without doubling or dropping slashes, in linear time', () => {
        expect(joinUrl('http://h/v1/', '/models')).toBe('http://h/v1/models');
        expect(joinUrl('http://h/v1', 'models')).toBe('http://h/v1/models');
        const t = Date.now();
        joinUrl(`http://h${'/'.repeat(200_000)}x`, 'models');
        expect(Date.now() - t).toBeLessThan(200);
    });

    it('redacts secrets', () => {
        expect(redact('bad key sk-test-123456 here', ['sk-test-123456'])).toBe('bad key [redacted] here');
    });
});
