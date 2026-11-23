/**
 * HTTP plumbing shared by the fetch-based adapters: a minimal fetch type, error
 * mapping, and streaming readers for Server-Sent Events and NDJSON.
 */
import { errorFromStatus, ProviderError, toProviderError } from './errors.js';
import type { SignalLike } from './types.js';

export interface ResponseLike {
    readonly ok: boolean;
    readonly status: number;
    readonly headers: { get(name: string): string | null };
    readonly body: ReadableStreamLike | null;
    text(): Promise<string>;
}

export interface ReadableStreamLike {
    getReader(): {
        read(): Promise<{ done: boolean; value?: Uint8Array }>;
        cancel(reason?: unknown): Promise<void>;
        releaseLock(): void;
    };
}

export interface RequestInitLike {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: SignalLike;
}

/** The subset of `fetch` the adapters call. `globalThis.fetch` satisfies it. */
export type FetchLike = (url: string, init?: RequestInitLike) => Promise<ResponseLike>;

export function defaultFetch(): FetchLike {
    const f = (globalThis as { fetch?: unknown }).fetch;
    if (typeof f !== 'function') throw new Error('No fetch in this environment: pass one in the adapter options.');
    // Bind so browsers don't throw "Illegal invocation".
    return (f as FetchLike).bind(globalThis);
}

/** Replaces each secret that appears in `text`. Keeps error messages and logs free of credentials. */
export function redact(text: string, secrets: ReadonlyArray<string | undefined>): string {
    let out = text;
    for (const secret of secrets) {
        if (secret && secret.length >= 6) out = out.split(secret).join('[redacted]');
    }
    return out;
}

/** Retry-After as milliseconds: seconds, an HTTP date, or OpenAI's retry-after-ms. */
export function retryAfterMs(headers: { get(name: string): string | null }, now = Date.now()): number | undefined {
    const ms = headers.get('retry-after-ms');
    if (ms && /^\d+(\.\d+)?$/.test(ms)) return Math.ceil(Number(ms));
    const value = headers.get('retry-after');
    if (!value) return undefined;
    if (/^\d+(\.\d+)?$/.test(value.trim())) return Math.ceil(Number(value) * 1000);
    const date = Date.parse(value);
    return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export interface Endpoint {
    provider: string;
    fetch: FetchLike;
    /** Secrets to strip from any error text. */
    secrets: ReadonlyArray<string | undefined>;
}

/** Sends a request; resolves with an OK response or rejects with a ProviderError. */
export async function send(endpoint: Endpoint, url: string, init: RequestInitLike): Promise<ResponseLike> {
    let res: ResponseLike;
    try {
        res = await endpoint.fetch(url, init);
    } catch (err) {
        throw toProviderError(endpoint.provider, err, init.signal);
    }
    if (res.ok) return res;
    let body = '';
    try {
        body = redact(await res.text(), endpoint.secrets);
    } catch {
        // the body is only used for the message
    }
    throw errorFromStatus(endpoint.provider, res.status, body, retryAfterMs(res.headers));
}

export async function sendJson<T>(endpoint: Endpoint, url: string, init: RequestInitLike): Promise<T> {
    const res = await send(endpoint, url, init);
    const text = await res.text();
    try {
        return JSON.parse(text) as T;
    } catch (err) {
        throw new ProviderError('invalid_response', endpoint.provider, 'The provider sent a response that is not JSON', {
            cause: err,
        });
    }
}

/** Yields text lines from a byte stream (LF or CRLF), decoding UTF-8 across chunk boundaries. */
export async function* lines(body: ReadableStreamLike, signal?: SignalLike): AsyncGenerator<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    const onAbort = () => void reader.cancel().catch(() => undefined);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl = buffer.indexOf('\n');
            while (nl >= 0) {
                const line = buffer.slice(0, nl);
                buffer = buffer.slice(nl + 1);
                yield line.endsWith('\r') ? line.slice(0, -1) : line;
                nl = buffer.indexOf('\n');
            }
        }
        buffer += decoder.decode();
        if (buffer) yield buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
    } finally {
        signal?.removeEventListener('abort', onAbort);
        try {
            reader.releaseLock();
        } catch {
            // already released by cancel()
        }
    }
}

export interface SseEvent {
    event?: string;
    data: string;
}

/** Parses Server-Sent Events (the subset LLM APIs use: `event:` and multi-line `data:`). */
export async function* sse(body: ReadableStreamLike, signal?: SignalLike): AsyncGenerator<SseEvent> {
    let event: string | undefined;
    let data: string[] = [];
    for await (const line of lines(body, signal)) {
        if (line === '') {
            if (data.length) yield { event, data: data.join('\n') };
            event = undefined;
            data = [];
        } else if (line.startsWith(':')) {
            // comment / keep-alive
        } else {
            const colon = line.indexOf(':');
            const field = colon < 0 ? line : line.slice(0, colon);
            let value = colon < 0 ? '' : line.slice(colon + 1);
            if (value.startsWith(' ')) value = value.slice(1);
            if (field === 'data') data.push(value);
            else if (field === 'event') event = value;
        }
    }
    if (data.length) yield { event, data: data.join('\n') };
}

/** Parses newline-delimited JSON, skipping blank lines. */
export async function* ndjson(provider: string, body: ReadableStreamLike, signal?: SignalLike): AsyncGenerator<unknown> {
    for await (const line of lines(body, signal)) {
        if (!line.trim()) continue;
        yield parseJson(provider, line);
    }
}

export function parseJson(provider: string, text: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch (err) {
        throw new ProviderError('invalid_response', provider, 'The provider sent a stream event that is not JSON', {
            cause: err,
        });
    }
}

/** Joins a base URL and a path without doubling or dropping slashes. */
export function joinUrl(base: string, path: string): string {
    return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Arguments from a model are untrusted text: parse to a plain object or report invalid output. */
export function parseArgs(provider: string, raw: unknown): Record<string, unknown> {
    let value = raw;
    if (typeof raw === 'string') {
        if (!raw.trim()) return {};
        value = parseJson(provider, raw);
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ProviderError('invalid_response', provider, 'The model sent tool arguments that are not a JSON object');
    }
    return value as Record<string, unknown>;
}
