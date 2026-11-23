import { describe, expect, it } from 'vitest';
import { collect, ProviderError, withResilience, type ChatEvent, type ProviderAdapter } from '../src/index.js';

const done: ChatEvent = { type: 'done', stopReason: 'end', turn: { content: 'ok', toolCalls: [] } };
const fail = (code: ProviderError['code'], retryAfterMs?: number): ChatEvent => ({
    type: 'error',
    error: new ProviderError(code, 'fake', code, { retryAfterMs }),
});

/** An adapter that plays one script per call, recording how many calls it got. */
function fake(scripts: ChatEvent[][], extra: Partial<ProviderAdapter> = {}) {
    let calls = 0;
    const adapter: ProviderAdapter = {
        id: 'fake',
        label: 'Fake',
        kind: 'local',
        detect: async () => ({ state: 'ready' }),
        listModels: async () => [],
        async *chat() {
            const script = scripts[Math.min(calls++, scripts.length - 1)]!;
            for (const e of script) yield e;
        },
        ...extra,
    };
    return { adapter, calls: () => calls };
}

const instant = () => {
    const waits: number[] = [];
    return { waits, sleep: async (ms: number) => void waits.push(ms) };
};
const req = { model: 'm', messages: [] };

describe('withResilience', () => {
    it('retries a transient failure that happened before any output, honouring Retry-After', async () => {
        const { adapter, calls } = fake([[fail('rate_limit', 5000)], [{ type: 'text', delta: 'ok' }, done]]);
        const t = instant();
        const events = await collect(withResilience(adapter, { sleep: t.sleep, random: () => 0 }).chat(req));
        expect(events).toEqual([{ type: 'text', delta: 'ok' }, done]);
        expect(calls()).toBe(2);
        expect(t.waits).toEqual([5000]);
    });

    it('backs off exponentially with jitter and gives up after maxAttempts', async () => {
        const { adapter, calls } = fake([[fail('unavailable')]]);
        const t = instant();
        const events = await collect(withResilience(adapter, { sleep: t.sleep, random: () => 1, baseDelayMs: 100 }).chat(req));
        expect(calls()).toBe(3);
        expect(t.waits).toEqual([100, 200]);
        expect(events).toEqual([fail('unavailable')].map((e) => ({ ...e, error: expect.objectContaining({ code: 'unavailable' }) })));
    });

    it('never retries once output has been produced, or for a non-transient error', async () => {
        const midStream = fake([[{ type: 'text', delta: 'par' }, fail('unavailable')]]);
        const events = await collect(withResilience(midStream.adapter, instant()).chat(req));
        expect(midStream.calls()).toBe(1);
        expect(events.at(-1)).toMatchObject({ type: 'error' });

        const auth = fake([[fail('auth')]]);
        await collect(withResilience(auth.adapter, instant()).chat(req));
        expect(auth.calls()).toBe(1);
    });

    it("doesn't retry adapters that retry internally", async () => {
        const { adapter, calls } = fake([[fail('unavailable')]], { retriesInternally: true });
        await collect(withResilience(adapter, instant()).chat(req));
        expect(calls()).toBe(1);
    });

    it('limits chats in flight', async () => {
        let active = 0;
        let peak = 0;
        const adapter: ProviderAdapter = {
            ...fake([]).adapter,
            async *chat() {
                active++;
                peak = Math.max(peak, active);
                await new Promise((r) => setTimeout(r, 5));
                active--;
                yield done;
            },
        };
        const wrapped = withResilience(adapter, { concurrency: 2 });
        await Promise.all(Array.from({ length: 6 }, () => collect(wrapped.chat(req))));
        expect(peak).toBe(2);
    });

    it('waits for the rate bucket to refill', async () => {
        const { adapter } = fake([[done]]);
        const t = instant();
        const wrapped = withResilience(adapter, { requestsPerMinute: 2, sleep: t.sleep, now: () => 0 });
        for (let i = 0; i < 3; i++) await collect(wrapped.chat(req));
        expect(t.waits).toEqual([30_000]);
    });

    it('reports cancellation while queued', async () => {
        const slow: ProviderAdapter = {
            ...fake([]).adapter,
            async *chat() {
                await new Promise((r) => setTimeout(r, 20));
                yield done;
            },
        };
        const wrapped = withResilience(slow, { concurrency: 1 });
        const first = collect(wrapped.chat(req));
        const controller = new AbortController();
        const second = collect(wrapped.chat(req, controller.signal));
        controller.abort();
        expect(await second).toEqual([{ type: 'error', error: expect.objectContaining({ code: 'cancelled' }) }]);
        expect(await first).toEqual([done]);
    });
});
