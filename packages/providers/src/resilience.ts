/**
 * Per-provider limits and retries, wrapped around any adapter:
 *
 * - at most `concurrency` chats in flight (the rest wait their turn);
 * - an optional request rate (token bucket, `requestsPerMinute`);
 * - transient failures (rate limits, 5xx, network) retried with exponential
 *   backoff and full jitter, honouring Retry-After. A stream is only retried if
 *   it failed before producing anything, so callers never see output twice.
 *
 * Adapters that retry internally (the Anthropic SDK does) keep their limits but
 * aren't retried again.
 */
import { ProviderError } from './errors.js';
import type { ChatEvent, ChatRequest, ProviderAdapter, SignalLike } from './types.js';

export interface ResilienceOptions {
    /** Chats in flight at once. Default 4. */
    concurrency?: number;
    /** Request rate cap. Default: none. */
    requestsPerMinute?: number;
    /** Attempts per chat, including the first. Default 3. */
    maxAttempts?: number;
    /** First backoff step. Default 1000 ms. */
    baseDelayMs?: number;
    /** Longest single wait, Retry-After included. Default 30 s. */
    maxDelayMs?: number;
    /** Injected for tests. */
    sleep?: (ms: number, signal?: SignalLike) => Promise<void>;
    random?: () => number;
    now?: () => number;
}

export function withResilience(adapter: ProviderAdapter, options: ResilienceOptions = {}): ProviderAdapter {
    const concurrency = Math.max(1, options.concurrency ?? 4);
    const maxAttempts = adapter.retriesInternally ? 1 : Math.max(1, options.maxAttempts ?? 3);
    const baseDelay = options.baseDelayMs ?? 1000;
    const maxDelay = options.maxDelayMs ?? 30_000;
    const sleep = options.sleep ?? defaultSleep;
    const random = options.random ?? Math.random;
    const now = options.now ?? Date.now;
    const gate = new Semaphore(concurrency);
    const bucket = options.requestsPerMinute ? new TokenBucket(options.requestsPerMinute, now) : undefined;

    async function* chat(request: ChatRequest, signal?: SignalLike): AsyncGenerator<ChatEvent> {
        try {
            await gate.acquire(signal);
        } catch {
            yield { type: 'error', error: new ProviderError('cancelled', adapter.id, 'Cancelled') };
            return;
        }
        try {
            for (let attempt = 1; ; attempt++) {
                if (bucket) {
                    const wait = bucket.take();
                    if (wait > 0) await sleep(wait, signal);
                }
                let produced = false;
                let failure: ProviderError | undefined;
                for await (const event of adapter.chat(request, signal)) {
                    if (event.type === 'error' && !produced && event.error.retryable && attempt < maxAttempts && !signal?.aborted) {
                        failure = event.error;
                        break;
                    }
                    produced = true;
                    yield event;
                }
                if (!failure) return;
                const backoff = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1));
                const jittered = Math.round(random() * backoff);
                const wait = Math.min(maxDelay, Math.max(jittered, failure.retryAfterMs ?? 0));
                try {
                    await sleep(wait, signal);
                } catch {
                    yield { type: 'error', error: new ProviderError('cancelled', adapter.id, 'Cancelled') };
                    return;
                }
            }
        } finally {
            gate.release();
        }
    }

    return {
        id: adapter.id,
        label: adapter.label,
        kind: adapter.kind,
        retriesInternally: true,
        detect: (signal) => adapter.detect(signal),
        listModels: (signal) => adapter.listModels(signal),
        chat,
        ...(adapter.embed ? { embed: adapter.embed.bind(adapter) } : {}),
    };
}

function defaultSleep(ms: number, signal?: SignalLike): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('aborted'));
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

class Semaphore {
    private active = 0;
    private readonly queue: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
    constructor(private readonly limit: number) {}

    acquire(signal?: SignalLike): Promise<void> {
        if (signal?.aborted) return Promise.reject(new Error('aborted'));
        if (this.active < this.limit) {
            this.active++;
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            const entry = {
                resolve: () => {
                    signal?.removeEventListener('abort', onAbort);
                    resolve();
                },
                reject,
            };
            const onAbort = () => {
                const i = this.queue.indexOf(entry);
                if (i >= 0) this.queue.splice(i, 1);
                reject(new Error('aborted'));
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            this.queue.push(entry);
        });
    }

    release(): void {
        const next = this.queue.shift();
        if (next) next.resolve(); // the slot passes straight to the next waiter
        else this.active--;
    }
}

/** Refills continuously at `perMinute`; `take()` returns how long to wait before the request may go. */
class TokenBucket {
    private tokens: number;
    private last: number;
    constructor(
        private readonly perMinute: number,
        private readonly now: () => number,
    ) {
        this.tokens = perMinute;
        this.last = now();
    }

    take(): number {
        const t = this.now();
        this.tokens = Math.min(this.perMinute, this.tokens + ((t - this.last) / 60_000) * this.perMinute);
        this.last = t;
        this.tokens -= 1;
        return this.tokens >= 0 ? 0 : Math.ceil((-this.tokens / this.perMinute) * 60_000);
    }
}
