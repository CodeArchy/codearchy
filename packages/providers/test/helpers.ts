/** A scripted fetch: records each request and answers from the first matching route. */
import type { FetchLike, RequestInitLike } from '../src/index.js';

export interface Recorded {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
}

export interface Reply {
    status?: number;
    headers?: Record<string, string>;
    /** One string per network chunk (to exercise chunk boundaries). */
    chunks?: string[];
    json?: unknown;
}

export type Route = (url: string, req: Recorded) => Reply | undefined;

export function mockFetch(...routes: Route[]): { fetch: FetchLike; requests: Recorded[] } {
    const requests: Recorded[] = [];
    const fetch = (async (input: unknown, init?: RequestInitLike & { headers?: unknown }) => {
        const url = typeof input === 'string' ? input : String((input as { url?: string }).url ?? input);
        const headers: Record<string, string> = {};
        new Headers(init?.headers as Record<string, string> | undefined).forEach((v, k) => (headers[k] = v));
        const raw = init?.body;
        const body = typeof raw === 'string' && raw ? JSON.parse(raw) : undefined;
        const req: Recorded = { url, method: init?.method ?? 'GET', headers, body };
        requests.push(req);
        if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        for (const route of routes) {
            const reply = route(url, req);
            if (reply) return respond(reply);
        }
        throw new TypeError(`fetch failed (no route for ${req.method} ${url})`);
    }) as unknown as FetchLike;
    return { fetch, requests };
}

function respond(reply: Reply): Response {
    const encoder = new TextEncoder();
    const chunks = reply.chunks ?? [JSON.stringify(reply.json ?? {})];
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const c of chunks) controller.enqueue(encoder.encode(c));
            controller.close();
        },
    });
    return new Response(stream, {
        status: reply.status ?? 200,
        headers: { 'content-type': reply.chunks ? 'text/event-stream' : 'application/json', ...reply.headers },
    });
}

/** Server-Sent Events text for a list of JSON payloads. */
export function sseOf(events: Array<unknown | { event: string; data: unknown }>, done = false): string {
    const lines = events.map((e) => {
        if (e && typeof e === 'object' && 'event' in e && 'data' in e) {
            const { event, data } = e as { event: string; data: unknown };
            return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        }
        return `data: ${JSON.stringify(e)}\n\n`;
    });
    return lines.join('') + (done ? 'data: [DONE]\n\n' : '');
}

/** Splits a string into n roughly equal pieces (byte-agnostic: may split inside an SSE line). */
export function split(text: string, n: number): string[] {
    const size = Math.ceil(text.length / n);
    const out: string[] = [];
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
    return out;
}
