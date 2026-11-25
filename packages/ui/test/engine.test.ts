import { describe, expect, test, vi } from 'vitest';
import { SpeechEngine, WebAudioSink, type SpeechMark } from '../src/speech/engine.js';
import { FakeSink, fakeVoice, memoryStore, settle } from './speechFakes.js';

const STEP = 'Where things start. The system is entered through [routes.ts](node:mod:routes) and 1 command, which runs the nightly import.';

describe('speech engine', () => {
    test('plays phrases back to back, marking each (with its nodes) when it starts, then ends', async () => {
        const { voice, asked } = fakeVoice();
        const sink = new FakeSink();
        const engine = new SpeechEngine(voice, { store: memoryStore(), sink });
        const marks: SpeechMark[] = [];
        let ended = false;
        engine.say(STEP, { id: 'step', onMark: (m) => marks.push(m), onEnd: () => (ended = true) });
        await settle();
        // Every phrase was asked for at once ('now', in order) and scheduled gaplessly.
        expect(asked.map((a) => a.priority)).toEqual(asked.map(() => 'now'));
        expect(asked[0]!.text).toBe('Where things start.');
        for (let i = 1; i < sink.played.length; i++) expect(sink.played[i]!.start).toBeCloseTo(sink.played[i - 1]!.start + sink.played[i - 1]!.seconds);
        expect(marks.map((m) => m.index)).toEqual([0]); // only the first has started
        expect(engine.state()).toMatchObject({ speaking: true, utterance: 'step', phrase: 'Where things start.' });
        sink.advance(sink.tail);
        expect(marks.map((m) => m.index)).toEqual(sink.played.map((_, i) => i));
        expect(marks.flatMap((m) => m.keys)).toEqual(['mod:routes']);
        expect(ended).toBe(true);
        expect(engine.state().speaking).toBe(false);
    });

    test('what was said is kept: said again (even by a new engine on the same store) it plays without making anything', async () => {
        const store = memoryStore();
        const { voice, asked } = fakeVoice();
        const first = new SpeechEngine(voice, { store, sink: new FakeSink() });
        first.say(STEP);
        await settle();
        const made = asked.length;
        const sink = new FakeSink();
        const second = new SpeechEngine(voice, { store, sink });
        second.say(STEP);
        await settle();
        expect(asked).toHaveLength(made);
        expect(sink.played).toHaveLength(made);
    });

    test('streaming: a sentence is asked for as soon as it is complete, while the rest is still being written', async () => {
        const { voice, asked } = fakeVoice();
        const sink = new FakeSink();
        const engine = new SpeechEngine(voice, { store: memoryStore(), sink });
        const u = engine.stream();
        u.push('Requests enter through [routes');
        u.push('.ts](node:mod:r), which hands each one to a ');
        await settle();
        expect(asked).toHaveLength(0); // mid-sentence: never cut at the comma
        u.push('handler. Then it');
        await settle();
        expect(asked.map((a) => a.text)).toEqual(['Requests enter through routes.ts, which hands each one to a handler.']);
        expect(sink.played).toHaveLength(1);
        u.push(' replies.');
        u.end();
        await settle();
        expect(asked.map((a) => a.text)).toEqual(['Requests enter through routes.ts, which hands each one to a handler.', 'Then it replies.']);
    });

    test('prefetch makes the openings of every text first, then the rest; progress counts texts fully kept', async () => {
        const { voice, asked } = fakeVoice();
        const engine = new SpeechEngine(voice, { store: memoryStore(), sink: new FakeSink() });
        const seen: string[] = [];
        engine.onProgress('tour', (p) => seen.push(`${p.ready}/${p.total}`));
        engine.prefetch('tour', [STEP, 'The core. Most of the code lives in the core package, which everything else depends on for shared types.'], { openers: 1 });
        await settle();
        expect(asked.slice(0, 2).map((a) => `${a.priority}:${a.text}`)).toEqual(['soon:Where things start.', 'soon:The core.']);
        expect(asked.slice(2).every((a) => a.priority === 'later')).toBe(true);
        expect(seen.at(-1)).toBe('2/2');
        // Now a step starts from the cache.
        const sink = new FakeSink();
        const engine2 = new SpeechEngine(voice, { store: memoryStore(), sink });
        expect(engine2).toBeDefined();
    });

    test('one job per phrase, however many ask; wanted sooner, it is raised (before the host has it) or reprioritized (after)', async () => {
        const { voice, asked, reprioritized } = fakeVoice();
        const engine = new SpeechEngine(voice, { store: memoryStore(), sink: new FakeSink() });
        const a = engine.audioFor('Where things start.', 'later');
        const b = engine.audioFor('Where things start.', 'now');
        void engine.audioFor('Where things start.', 'soon');
        await settle();
        expect(asked.map((x) => x.priority)).toEqual(['now']);
        expect(await a).toBe(await b);

        const r = engine.request('The core.', 'later');
        await r.issued;
        void engine.audioFor('The core.', 'now');
        await settle();
        // Handed over already: the host is told to raise it.
        expect(asked.filter((x) => x.text === 'The core.').map((x) => x.priority)).toEqual(['later']);
        expect(reprioritized).toEqual([{ text: 'The core.', priority: 'now' }]);
    });

    test('when the one who needed a phrase now gives up (a skipped step), it drops back to what others still need', async () => {
        const { voice, reprioritized } = fakeVoice();
        // The host never finishes, so the job stays queued.
        voice.synthesize = () => new Promise(() => undefined);
        const engine = new SpeechEngine(voice, { store: memoryStore(), sink: new FakeSink() });
        const tour = new AbortController();
        const step = new AbortController();
        await engine.request('The rest of step two.', 'later', tour.signal).issued;
        await engine.request('The rest of step two.', 'now', step.signal).issued;
        step.abort(); // Next: the step on screen no longer needs it; the tour prefetch still does
        expect(reprioritized.map((r) => r.priority)).toEqual(['now', 'later']);
    });

    test('a shared phrase survives one asker giving up; it is dropped only when all have', async () => {
        const { voice, asked } = fakeVoice();
        const engine = new SpeechEngine(voice, { store: memoryStore(), sink: new FakeSink() });
        const tour = new AbortController();
        const step = new AbortController();
        const fromTour = engine.audioFor('The core.', 'later', tour.signal);
        const fromStep = engine.audioFor('The core.', 'now', step.signal);
        tour.abort();
        expect(await fromStep).toBeDefined();
        expect(await fromTour).toBe(await fromStep);
        const lonely = new AbortController();
        const gone = engine.audioFor('Nobody wants this.', 'later', lonely.signal);
        lonely.abort();
        expect(await gone).toBeUndefined();
        expect(asked.find((x) => x.text === 'Nobody wants this.')?.signal?.aborted ?? true).toBe(true);
    });

    test('queued speech waits for what is playing (an answer after "let me look"); otherwise new speech cuts it off', async () => {
        const { voice } = fakeVoice();
        const sink = new FakeSink();
        const engine = new SpeechEngine(voice, { store: memoryStore(), sink });
        const order: string[] = [];
        engine.say('Let me look.', { onMark: (m) => order.push(m.text) });
        engine.say('Requests enter through the routes.', { queue: true, onMark: (m) => order.push(m.text) });
        await settle();
        sink.advance(100);
        expect(order).toEqual(['Let me look.', 'Requests enter through the routes.']);
        expect(sink.played[1]!.start).toBeCloseTo(sink.played[0]!.seconds);

        const cut: string[] = [];
        engine.say('A long explanation goes on. And on for a while.', { onMark: (m) => cut.push(m.text) });
        await settle();
        engine.say('Never mind.', { onMark: (m) => cut.push(m.text) });
        await settle();
        sink.advance(100);
        expect(cut.at(-1)).toBe('Never mind.');
        expect(cut).not.toContain('And on for a while.');
    });

    test('cancelling silences it at once (its scheduled audio stops) and stops the marks', async () => {
        const { voice } = fakeVoice();
        const sink = new FakeSink();
        const engine = new SpeechEngine(voice, { store: memoryStore(), sink });
        const marks: string[] = [];
        const u = engine.say(STEP, { onMark: (m) => marks.push(m.text) });
        await settle();
        expect(sink.played.length).toBeGreaterThan(1); // phrases are scheduled ahead, back to back
        u.cancel();
        expect(sink.played.every((p) => p.silenced)).toBe(true);
        expect(sink.tail).toBe(0);
        sink.advance(100);
        expect(marks).toHaveLength(1); // only the phrase that had started
        expect(engine.state().speaking).toBe(false);
    });

    test('what a cancelled utterance asked for is still made, in the background, and kept: said again, it plays at once', async () => {
        const store = memoryStore();
        const { voice, asked } = fakeVoice();
        const engine = new SpeechEngine(voice, { store, sink: new FakeSink() });
        engine.say(STEP).cancel(); // closed before a word was made
        await settle();
        expect(asked.length).toBeGreaterThan(1);
        expect(asked.every((a) => a.priority === 'later' && !a.signal?.aborted)).toBe(true);
        const made = asked.length;
        const sink = new FakeSink();
        new SpeechEngine(voice, { store, sink }).say(STEP);
        await settle();
        expect(asked).toHaveLength(made);
        expect(sink.played).toHaveLength(made);
    });

    test('cancelled while the system voice is saying it, the system voice stops', async () => {
        const { voice, stopped } = fakeVoice({ kept: false });
        voice.speak = () => undefined; // still talking
        const engine = new SpeechEngine(voice, { store: memoryStore(), sink: new FakeSink() });
        const u = engine.say(STEP);
        await settle();
        const before = stopped.count;
        u.cancel();
        expect(stopped.count).toBe(before + 1);
    });

    test('a voice that can\'t be kept (the system voice) speaks phrase by phrase, marking each', async () => {
        const { voice, spoken } = fakeVoice({ kept: false });
        const engine = new SpeechEngine(voice, { store: memoryStore(), sink: new FakeSink() });
        const marks: string[][] = [];
        let ended = false;
        engine.say(STEP, { onMark: (m) => marks.push(m.keys), onEnd: () => (ended = true) });
        await settle();
        expect(spoken.join(' ')).toBe('Where things start. The system is entered through routes.ts and 1 command, which runs the nightly import.');
        expect(marks.flat()).toEqual(['mod:routes']);
        expect(ended).toBe(true);
    });

    test('a resume of the audio device that fails is never left unhandled (no audio device; Firefox rejects it when the page navigates away)', async () => {
        let resumes = 0;
        class NoDevice {
            state = 'suspended';
            currentTime = 0;
            resume(): Promise<void> {
                resumes++;
                return Promise.reject(new DOMException('Navigated away from page', 'InvalidStateError'));
            }
        }
        const unhandled: unknown[] = [];
        const record = (e: unknown) => unhandled.push(e);
        process.on('unhandledRejection', record);
        vi.stubGlobal('AudioContext', NoDevice);
        try {
            const sink = new WebAudioSink();
            sink.now();
            sink.now();
            await new Promise((r) => setTimeout(r, 20));
            expect(resumes).toBe(2); // still asked each time it's suspended (a later gesture may allow it)
            expect(unhandled).toEqual([]);
        } finally {
            process.off('unhandledRejection', record);
            vi.unstubAllGlobals();
        }
    });
});
