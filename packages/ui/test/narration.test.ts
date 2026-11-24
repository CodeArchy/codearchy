import { describe, expect, test } from 'vitest';
import type { SpeakOptions, SynthesisPriority, VoiceAudio, VoiceClient, VoiceState } from '@codearchy/protocol';
import { Narrator, type AudioStore } from '../src/narration.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
    for (let i = 0; i < 20; i++) await tick();
};

function memoryStore(): AudioStore & { size(): number } {
    const m = new Map<string, VoiceAudio>();
    return { get: async (id) => m.get(id), put: async (id, a) => void m.set(id, a), size: () => m.size };
}

function fakeVoice(opts: { captures?: boolean; key?: string } = {}) {
    let key: string | undefined = opts.key ?? 'kokoro:v1:af_heart:1';
    const log = { synthesized: [] as Array<[string, SynthesisPriority]>, played: [] as VoiceAudio[], spoken: [] as string[] };
    const audio = (text: string): VoiceAudio => ({ pcm: new Float32Array([text.length]), sampleRate: 24000 });
    const voice: VoiceClient = {
        state: () => ({}) as VoiceState,
        subscribe: () => () => undefined,
        update: () => undefined,
        speak: (text: string, o?: SpeakOptions) => {
            log.spoken.push(text);
            o?.onAudio?.(audio(text));
            o?.onEnd?.();
        },
        stop: () => undefined,
        cacheKey: () => key,
        synthesize: async (text, priority) => (log.synthesized.push([text, priority]), audio(text)),
        play: (a, o) => (log.played.push(a), o?.onEnd?.()),
        capturesSpeech: opts.captures ?? true,
    };
    return { voice, log, setKey: (k: string | undefined) => (key = k) };
}

describe('Narrator', () => {
    test('speech made while speaking is kept, and the same text then plays from the cache', async () => {
        const { voice, log } = fakeVoice();
        const store = memoryStore();
        const n = new Narrator(voice, store);
        n.speak('The big picture.');
        await settle();
        expect(log.spoken).toEqual(['The big picture.']);
        expect(store.size()).toBe(1);
        n.speak('The big picture.');
        await settle();
        expect(log.spoken).toHaveLength(1);
        expect(log.played).toHaveLength(1);
    });

    test('prefetch makes the next step first, reports progress, and a prefetched step plays at once', async () => {
        const { voice, log } = fakeVoice();
        const n = new Narrator(voice, memoryStore());
        const seen: string[] = [];
        n.subscribe((p) => seen.push(`${p.ready}/${p.total}`));
        n.prefetch(['two', 'three', 'four'], { first: 1 });
        await settle();
        expect(log.synthesized).toEqual([
            ['two', 'soon'],
            ['three', 'later'],
            ['four', 'later'],
        ]);
        expect(seen.at(-1)).toBe('3/3');
        n.speak('three');
        await settle();
        expect(log.spoken).toEqual([]);
        expect(log.played).toHaveLength(1);
        // Already kept: asking again makes nothing new.
        n.prefetch(['two', 'three', 'four']);
        await settle();
        expect(log.synthesized).toHaveLength(3);
    });

    test('another voice (or speed) records again; the system voice speaks directly', async () => {
        const { voice, log, setKey } = fakeVoice();
        const n = new Narrator(voice, memoryStore());
        n.prefetch(['step']);
        await settle();
        setKey('kokoro:v1:bm_george:1');
        n.prefetch(['step']);
        await settle();
        expect(log.synthesized).toHaveLength(2);
        setKey(undefined);
        n.speak('step');
        await settle();
        expect(log.spoken).toEqual(['step']);
        expect(n.caching).toBe(false);
    });

    test('a host that cannot capture speech waits for the queued step instead of making it twice', async () => {
        const { voice, log } = fakeVoice({ captures: false });
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const synth = voice.synthesize!;
        voice.synthesize = async (t, p) => (await gate, synth(t, p));
        const n = new Narrator(voice, memoryStore());
        n.prefetch(['now playing'], { first: 0 });
        await settle();
        n.speak('now playing');
        await settle();
        release();
        await settle();
        expect(log.spoken).toEqual([]);
        expect(log.played).toHaveLength(1);
        // Asked for sooner: the host is asked again at 'now' (it raises the queued job).
        expect(log.synthesized.map(([, p]) => p)).toEqual(['later', 'now']);
    });
});
