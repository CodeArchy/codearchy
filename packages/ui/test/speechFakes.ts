import type { AbortSignalLike, SpeakOptions, SynthesisPriority, VoiceAudio, VoiceClient, VoiceState } from '@codearchy/protocol';
import type { AudioSink } from '../src/speech/engine.js';
import type { AudioStore } from '../src/speech/store.js';

export const settle = async () => {
    for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A sink on a virtual clock: `advance` plays time forward and runs what's due. */
export class FakeSink implements AudioSink {
    t = 0;
    tail = 0;
    played: Array<{ start: number; seconds: number; silenced?: boolean }> = [];
    private timers: Array<{ t: number; fn: () => void }> = [];
    now() {
        return this.t;
    }
    schedule(a: VoiceAudio) {
        const start = Math.max(this.t, this.tail);
        const seconds = a.pcm.length / a.sampleRate;
        this.tail = start + seconds;
        const slot: { start: number; seconds: number; silenced?: boolean } = { start, seconds };
        this.played.push(slot);
        return {
            start,
            end: this.tail,
            cancel: () => {
                slot.silenced = true;
                this.tail = Math.max(0, ...this.played.filter((p) => !p.silenced).map((p) => p.start + p.seconds));
            },
        };
    }
    at(t: number, fn: () => void) {
        if (t <= this.t) fn();
        else this.timers.push({ t, fn });
    }
    stop() {
        this.timers = [];
        this.tail = 0;
    }
    advance(dt: number) {
        this.t += dt;
        const due = this.timers.filter((x) => x.t <= this.t).sort((a, b) => a.t - b.t);
        this.timers = this.timers.filter((x) => x.t > this.t);
        for (const d of due) d.fn();
    }
}

export function memoryStore(): AudioStore & { size(): number } {
    const m = new Map<string, VoiceAudio>();
    return { get: async (id) => m.get(id), put: async (id, a) => void m.set(id, a), size: () => m.size };
}

/** A voice that makes 1 s of audio per 10 characters, and logs what it was asked for. */
export function fakeVoice(opts: { kept?: boolean } = {}) {
    const asked: Array<{ text: string; priority: SynthesisPriority; signal?: AbortSignalLike }> = [];
    const reprioritized: Array<{ text: string; priority: SynthesisPriority }> = [];
    const spoken: string[] = [];
    const stopped = { count: 0 };
    let key: string | undefined = 'kokoro:test:af_heart:1';
    const voice: VoiceClient = {
        state: () => ({}) as VoiceState,
        subscribe: () => () => undefined,
        update: () => undefined,
        speak: (text: string, o?: SpeakOptions) => {
            spoken.push(text);
            o?.onEnd?.();
        },
        stop: () => void (stopped.count += 1),
        ...(opts.kept === false
            ? {}
            : {
                  cacheKey: () => key,
                  reprioritize: (text: string, priority: SynthesisPriority) => void reprioritized.push({ text, priority }),
                  synthesize: async (text: string, priority: SynthesisPriority, signal?: AbortSignalLike) => {
                      asked.push({ text, priority, ...(signal ? { signal } : {}) });
                      await new Promise((r) => setTimeout(r, 0));
                      return signal?.aborted ? undefined : { pcm: new Float32Array(Math.round((text.length / 10) * 100)), sampleRate: 100 };
                  },
              }),
    };
    return { voice, asked, spoken, reprioritized, stopped, setKey: (k: string | undefined) => (key = k) };
}
