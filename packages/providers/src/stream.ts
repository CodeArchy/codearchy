import { toProviderError } from './errors.js';
import type { ChatEvent, SignalLike } from './types.js';

/**
 * Runs an adapter's stream and turns anything it throws into the final `error`
 * event, so `chat()` keeps its "never throws" contract.
 */
export async function* guarded(
    provider: string,
    signal: SignalLike | undefined,
    run: () => AsyncGenerator<ChatEvent>,
): AsyncGenerator<ChatEvent> {
    try {
        yield* run();
    } catch (err) {
        yield { type: 'error', error: toProviderError(provider, err, signal) };
    }
}

/** Collects a whole stream; handy for tests and non-interactive callers. */
export async function collect(stream: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
    const events: ChatEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
}
