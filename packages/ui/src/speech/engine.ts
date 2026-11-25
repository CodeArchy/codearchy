/**
 * The speech engine: CodeArchy's voice, a phrase at a time.
 *
 *   text ─▶ chunker ─▶ phrase ─▶ cache? ──yes──▶ ┐
 *                                  │ no            ├─▶ gapless player ─▶ marks
 *                                  └▶ host makes ─▶ ┘     (the canvas follows)
 *
 * - Speech starts with a short phrase and later phrases grow only as fast as
 *   synthesis outruns playback (see chunker.ts), so once it starts it doesn't
 *   stop to wait. Text can arrive all at once (a tour step) or as it's
 *   written (an answer streaming from the model).
 * - Every phrase is kept (memory, then IndexedDB) under the voice's identity
 *   and its text: anything said before is said again at once, and prefetching
 *   the opening phrases of what's likely next (the next tour step, the flow on
 *   screen) makes it start at once too.
 * - Marks fire when a phrase actually starts playing (the audio clock, not
 *   when it was made), so the canvas moves with the voice.
 * - The host only makes audio (`VoiceClient.synthesize`, in priority order);
 *   playing, caching and ordering live here, the same in every host. Voices
 *   whose audio can't be kept (the system voice) are spoken phrase by phrase
 *   through the host.
 */
import type { AbortSignalLike, SynthesisPriority, VoiceAudio, VoiceClient } from '@codearchy/protocol';
import { SpeechChunker, speechChunks, type SpeechChunk } from './chunker.js';
import { indexedDbAudioStore, type AudioStore } from './store.js';

export interface SpeechMark {
    /** The utterance's id. */
    utterance: string;
    index: number;
    text: string;
    /** Nodes the phrase links to. */
    keys: string[];
}

export interface SpeechState {
    /** Audio is playing. */
    speaking: boolean;
    /** Speech was asked for; the first phrase isn't playing yet. */
    preparing: boolean;
    /** The utterance being spoken, and its current phrase. */
    utterance?: string;
    phrase?: string;
}

export interface SayOptions {
    /** Names the utterance (marks and state carry it). */
    id?: string;
    onMark?(mark: SpeechMark): void;
    /** Played to the end (not called when cancelled). */
    onEnd?(): void;
    onError?(error: Error): void;
    /** Play after what's already playing (an answer after "let me look"), instead of cutting it off. */
    queue?: boolean;
}

export interface Utterance {
    readonly id: string;
    /** More text (for speech that's still being written). */
    push(markdown: string): void;
    /** No more text. */
    end(): void;
    cancel(): void;
}

/** Where audio plays: scheduled back to back, on one clock. */
export interface AudioSink {
    /** Plays `audio` after everything already scheduled; when it starts and ends (sink time, seconds). */
    schedule(audio: VoiceAudio): { start: number; end: number };
    now(): number;
    /** Runs `fn` at sink time `t` (now if it's past). */
    at(t: number, fn: () => void): void;
    /** Silence: stops what's playing and what's scheduled. */
    stop(): void;
    /** When everything scheduled will have played. */
    readonly tail: number;
}

/**
 * Web Audio, one context for the page. The audio device is opened on the
 * first click or key press (opening it takes ~0.7 s, and browsers only allow
 * it after a gesture), so the first word is heard as soon as it's ready.
 */
export class WebAudioSink implements AudioSink {
    private ctx?: AudioContext;
    private readonly sources = new Set<AudioBufferSourceNode>();
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();
    tail = 0;

    constructor() {
        if (typeof window === 'undefined') return;
        const open = () => {
            window.removeEventListener('pointerdown', open, true);
            window.removeEventListener('keydown', open, true);
            try {
                this.context();
            } catch {
                // no Web Audio here: speech falls back when it's needed
            }
        };
        window.addEventListener('pointerdown', open, true);
        window.addEventListener('keydown', open, true);
    }

    private context(): AudioContext {
        this.ctx ??= new AudioContext({ latencyHint: 'interactive' });
        if (this.ctx.state === 'suspended') void this.ctx.resume();
        return this.ctx;
    }

    now(): number {
        return this.context().currentTime;
    }

    schedule(audio: VoiceAudio): { start: number; end: number } {
        const c = this.context();
        const buf = c.createBuffer(1, audio.pcm.length, audio.sampleRate);
        buf.copyToChannel(audio.pcm as Float32Array<ArrayBuffer>, 0);
        const src = c.createBufferSource();
        src.buffer = buf;
        src.connect(c.destination);
        const start = Math.max(c.currentTime + 0.02, this.tail);
        src.start(start);
        this.tail = start + buf.duration;
        this.sources.add(src);
        src.onended = () => this.sources.delete(src);
        return { start, end: this.tail };
    }

    at(t: number, fn: () => void): void {
        const h = setTimeout(
            () => {
                this.timers.delete(h);
                fn();
            },
            Math.max(0, (t - this.now()) * 1000)
        );
        this.timers.add(h);
    }

    stop(): void {
        for (const s of this.sources) {
            try {
                s.stop();
            } catch {
                // not started yet
            }
        }
        this.sources.clear();
        for (const h of this.timers) clearTimeout(h);
        this.timers.clear();
        this.tail = 0;
    }
}

const RANK: Record<SynthesisPriority, number> = { now: 0, soon: 1, later: 2 };
const PRIORITY: SynthesisPriority[] = ['now', 'soon', 'later'];

/** A phrase being made: shared by everyone who asked for it. */
interface Making {
    /** The most urgent priority among those still waiting (what the host is told). */
    rank: number;
    /** Handed to the host (changing its priority now means telling the host). */
    handed: boolean;
    /** Askers still waiting, by priority (it's abandoned when none are; its priority follows the most urgent). */
    askers: number[];
    abort: AbortController;
    issued: Promise<void>;
    done: Promise<VoiceAudio | undefined>;
}
/** Phrases kept in memory (by size: a phrase is ~100–500 KB); pinned ones (acknowledgements…) never leave. */
const MEMORY_BYTES = 64 * 1024 * 1024;

async function digest(text: string): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface Item {
    chunk: SpeechChunk;
    index: number;
    /** Kept or being made (voices that can be kept). */
    audio?: Promise<VoiceAudio | undefined>;
}

/** One thing being said. */
class Run implements Utterance {
    private readonly chunker = new SpeechChunker();
    private readonly items: Item[] = [];
    private ended = false;
    private cancelled = false;
    private readonly abort = new AbortController();
    private wake?: () => void;
    /** Resolves once every phrase is scheduled (a queued utterance starts right after, gaplessly). */
    readonly scheduled: Promise<void>;
    private markScheduled!: () => void;
    /** Resolves when it's done (played to the end, or cancelled). */
    readonly done: Promise<void>;
    private markDone!: () => void;
    /** Phrases are made by the host and kept (false: spoken by the system voice). */
    private readonly kept: boolean;

    constructor(
        private readonly engine: SpeechEngine,
        readonly id: string,
        private readonly options: SayOptions,
        private readonly after?: Run
    ) {
        this.kept = engine.caching;
        this.scheduled = new Promise((r) => (this.markScheduled = r));
        this.done = new Promise((r) => (this.markDone = r));
        void this.consume();
    }

    push(markdown: string): void {
        if (this.cancelled || this.ended) return;
        for (const c of this.chunker.push(markdown)) this.add(c);
    }

    end(): void {
        if (this.cancelled || this.ended) return;
        for (const c of this.chunker.end()) this.add(c);
        this.ended = true;
        this.wake?.();
    }

    cancel(): void {
        if (this.cancelled) return;
        this.cancelled = true;
        this.abort.abort();
        this.wake?.();
        this.markScheduled();
        this.markDone();
        this.engine.ended(this);
    }

    /** Requests go to the host strictly in order (it serves them first come, first served). */
    private issuing: Promise<void> = Promise.resolve();

    private add(chunk: SpeechChunk): void {
        const item: Item = { chunk, index: this.items.length };
        if (this.kept) {
            let resolve!: (a: VoiceAudio | undefined) => void;
            item.audio = new Promise((r) => (resolve = r));
            this.issuing = this.issuing.then(() => {
                const r = this.engine.request(chunk.text, 'now', this.abort.signal);
                void r.audio.then(resolve);
                return r.issued;
            });
        }
        this.items.push(item);
        this.wake?.();
    }

    private async consume(): Promise<void> {
        if (this.after) await this.after.scheduled;
        const sink = this.engine.sink;
        let end = 0;
        for (let i = 0; ; i++) {
            while (i >= this.items.length && !this.ended && !this.cancelled) await new Promise<void>((r) => (this.wake = r));
            if (this.cancelled) return;
            if (i >= this.items.length) break;
            const item = this.items[i]!;
            if (this.kept) {
                const audio = await item.audio;
                if (this.cancelled) return;
                if (audio) {
                    const slot = sink.schedule(audio);
                    end = slot.end;
                    sink.at(slot.start, () => this.mark(item));
                    continue;
                }
            }
            // The system voice (or a phrase that couldn't be made): spoken by the host, after what's scheduled.
            if (sink.tail > 0 && sink.tail > sink.now()) await new Promise<void>((r) => sink.at(sink.tail, r));
            if (this.cancelled) return;
            this.mark(item);
            await new Promise<void>((resolve) =>
                this.engine.voice.speak(item.chunk.text, {
                    onEnd: resolve,
                    onError: (e) => {
                        this.options.onError?.(e);
                        resolve();
                    },
                })
            );
            if (this.cancelled) return;
        }
        this.markScheduled();
        const finish = () => {
            if (this.cancelled) return;
            this.markDone();
            this.engine.ended(this);
            this.options.onEnd?.();
        };
        if (end > 0 && end > sink.now()) sink.at(end, finish);
        else finish();
    }

    private mark(item: Item): void {
        if (this.cancelled) return;
        this.engine.phrase(this, item.chunk.text);
        this.options.onMark?.({ utterance: this.id, index: item.index, text: item.chunk.text, keys: item.chunk.keys });
    }
}

/** What a prefetch group has ready: whole texts kept, out of how many. */
export interface PrefetchProgress {
    ready: number;
    total: number;
}

export class SpeechEngine {
    readonly sink: AudioSink;
    private readonly store: AudioStore;
    /** Kept audio by `voice key \n text` (the store's id is its hash). */
    private readonly memory = new Map<string, VoiceAudio>();
    private memoryBytes = 0;
    /** Never evicted from memory: phrases that must start at once (acknowledgements, the preview). */
    private readonly pinned = new Set<string>();
    private readonly making = new Map<string, Making>();
    private readonly runs = new Set<Run>();
    private last?: Run;
    private current: SpeechState = { speaking: false, preparing: false };
    private readonly listeners = new Set<(s: SpeechState) => void>();
    private readonly groups = new Map<string, { abort: AbortController; progress: PrefetchProgress }>();
    private readonly groupListeners = new Map<string, Set<(p: PrefetchProgress) => void>>();
    private seq = 0;

    constructor(
        readonly voice: VoiceClient,
        options: { store?: AudioStore; sink?: AudioSink } = {}
    ) {
        this.store = options.store ?? indexedDbAudioStore();
        this.sink = options.sink ?? new WebAudioSink();
    }

    /** Whether speech is made by the host and kept (Kokoro), rather than spoken by the system voice. */
    get caching(): boolean {
        return !!(this.voice.synthesize && this.voice.cacheKey?.());
    }

    state(): SpeechState {
        return this.current;
    }

    subscribe(listener: (s: SpeechState) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Says `markdown` (links mark the canvas as they're spoken). Cuts off what's playing unless `queue`. */
    say(markdown: string, options: SayOptions = {}): Utterance {
        const u = this.stream(options);
        u.push(markdown);
        u.end();
        return u;
    }

    /** Speech whose text is still being written: `push` it as it comes, then `end`. */
    stream(options: SayOptions = {}): Utterance {
        if (!options.queue) this.stop();
        const after = options.queue && this.last && this.runs.has(this.last) ? this.last : undefined;
        const run = new Run(this, options.id ?? `u${++this.seq}`, options, after);
        this.runs.add(run);
        this.last = run;
        this.setState({ ...this.current, preparing: !this.current.speaking, utterance: this.current.utterance ?? run.id });
        return run;
    }

    /** Silence: everything playing or waiting to play stops. */
    stop(): void {
        for (const r of [...this.runs]) r.cancel();
        this.sink.stop();
        this.voice.stop();
        this.setState({ speaking: false, preparing: false });
    }

    /**
     * Makes and keeps speech for these texts ahead of time, most important
     * first: the first `openers` phrases of every text (so each starts at
     * once), then the rest in order. A new prefetch in the same group replaces
     * the old one's queued work.
     */
    prefetch(group: string, markdowns: string[], options: { openers?: number; priority?: SynthesisPriority; pin?: boolean } = {}): void {
        const previous = this.groups.get(group)?.abort;
        const abort = new AbortController();
        if (!this.caching) {
            previous?.abort();
            return this.setProgress(group, { ready: 0, total: 0 }, abort);
        }
        const lists = markdowns.map((m) => speechChunks(m));
        const openers = options.openers ?? 2;
        const first = options.priority ?? 'soon';
        const order: Array<{ text: number; chunk: SpeechChunk; priority: SynthesisPriority }> = [];
        for (let k = 0; k < openers; k++) lists.forEach((l, t) => l[k] && order.push({ text: t, chunk: l[k]!, priority: first }));
        lists.forEach((l, t) => l.slice(openers).forEach((chunk) => order.push({ text: t, chunk, priority: 'later' })));
        const wanted: Array<Array<Promise<VoiceAudio | undefined>>> = lists.map(() => []);
        // In order, each handed over before the next (the host's queue keeps that order).
        let issuing: Promise<void> = Promise.resolve();
        for (const o of order) {
            let resolve!: (a: VoiceAudio | undefined) => void;
            wanted[o.text]!.push(new Promise((r) => (resolve = r)));
            issuing = issuing.then(() => {
                if (abort.signal.aborted) return resolve(undefined);
                const r = this.request(o.chunk.text, o.priority, abort.signal, options.pin);
                void r.audio.then(resolve);
                return r.issued;
            });
        }
        // The new interest is registered first, so phrases both batches want aren't dropped.
        void issuing.then(() => previous?.abort());
        let ready = 0;
        this.setProgress(group, { ready, total: lists.length }, abort);
        wanted.forEach((w) =>
            void Promise.all(w).then((all) => {
                if (abort.signal.aborted || !all.every(Boolean)) return;
                this.setProgress(group, { ready: ++ready, total: lists.length }, abort);
            })
        );
    }

    /** Leaves a group's queued (not started) work behind: a closed tour's steps. */
    cancelPrefetch(group: string): void {
        const g = this.groups.get(group);
        g?.abort.abort();
        this.setProgress(group, { ready: 0, total: 0 }, new AbortController());
    }

    progress(group: string): PrefetchProgress {
        return this.groups.get(group)?.progress ?? { ready: 0, total: 0 };
    }

    onProgress(group: string, listener: (p: PrefetchProgress) => void): () => void {
        const set = this.groupListeners.get(group) ?? new Set();
        set.add(listener);
        this.groupListeners.set(group, set);
        listener(this.progress(group));
        return () => set.delete(listener);
    }

    /** A phrase's audio: from memory, from the store, or made by the host (once, however many ask). */
    audioFor(text: string, priority: SynthesisPriority, signal?: AbortSignalLike): Promise<VoiceAudio | undefined> {
        return this.request(text, priority, signal).audio;
    }

    /**
     * Asks for a phrase. `issued` resolves once it's answered from the cache
     * or handed to the host (so callers can keep the host's queue in order);
     * `audio` when it's there. Several askers share one job; it's abandoned
     * only when every one of them has given up on it.
     */
    request(text: string, priority: SynthesisPriority, signal?: AbortSignalLike, pin = false): { issued: Promise<void>; audio: Promise<VoiceAudio | undefined> } {
        const key = this.voice.cacheKey?.();
        const synthesize = this.voice.synthesize;
        if (!key || !synthesize) return { issued: Promise.resolve(), audio: Promise.resolve(undefined) };
        const k = `${key}\n${text}`;
        if (pin) this.pinned.add(k);
        const hit = this.memory.get(k);
        if (hit) return { issued: Promise.resolve(), audio: Promise.resolve(this.remember(k, hit)) };
        const rank = RANK[priority];
        let m = this.making.get(k);
        if (!m) {
            const made: Making = { rank, handed: false, askers: [], abort: new AbortController(), issued: Promise.resolve(), done: Promise.resolve(undefined) };
            let markIssued!: () => void;
            made.issued = new Promise((r) => (markIssued = r));
            made.done = (async () => {
                try {
                    const id = await digest(k);
                    const stored = await this.store.get(id).catch(() => undefined);
                    if (stored) return this.remember(k, stored);
                    if (made.abort.signal.aborted) return undefined;
                    made.handed = true;
                    const asked = synthesize.call(this.voice, text, PRIORITY[made.rank], made.abort.signal);
                    markIssued();
                    const audio = await asked.catch(() => undefined);
                    if (audio) {
                        this.remember(k, audio);
                        void this.store.put(id, audio).catch(() => undefined);
                    }
                    return audio;
                } finally {
                    markIssued();
                    if (this.making.get(k) === made) this.making.delete(k);
                }
            })();
            this.making.set(k, made);
            m = made;
        }
        const job = m;
        job.askers.push(rank);
        this.rerank(text, job);
        if (signal) {
            const drop = () => {
                job.askers.splice(job.askers.indexOf(rank), 1);
                if (!job.askers.length) {
                    if (!job.abort.signal.aborted) job.abort.abort();
                } else this.rerank(text, job);
            };
            if (signal.aborted) drop();
            else signal.addEventListener('abort', drop, { once: true });
        }
        return { issued: job.issued, audio: job.done };
    }

    /** A job's priority follows its most urgent asker; the host is told when it changes after hand-over. */
    private rerank(text: string, job: Making): void {
        const rank = Math.min(...job.askers);
        if (rank === job.rank) return;
        const raised = rank < job.rank;
        job.rank = rank;
        if (!job.handed) return;
        if (this.voice.reprioritize) this.voice.reprioritize(text, PRIORITY[rank]!);
        // A host that can't reprioritize can still raise: asked again, it raises its queued job.
        else if (raised) void this.voice.synthesize?.(text, PRIORITY[rank]!, job.abort.signal)?.catch(() => undefined);
    }

    // ── for runs ──────────────────────────────────────────────────────────

    /** @internal A run's phrase started playing. */
    phrase(run: Run, text: string): void {
        this.setState({ speaking: true, preparing: false, utterance: run.id, phrase: text });
    }

    /** @internal A run finished or was cancelled. */
    ended(run: Run): void {
        this.runs.delete(run);
        if (this.last === run) this.last = undefined;
        if (!this.runs.size) this.setState({ speaking: false, preparing: false });
    }

    private remember(k: string, audio: VoiceAudio): VoiceAudio {
        if (this.memory.has(k)) this.memory.delete(k);
        else this.memoryBytes += audio.pcm.byteLength;
        this.memory.set(k, audio);
        // Least recently used first; pinned phrases stay.
        for (const [old, a] of this.memory) {
            if (this.memoryBytes <= MEMORY_BYTES) break;
            if (this.pinned.has(old)) continue;
            this.memory.delete(old);
            this.memoryBytes -= a.pcm.byteLength;
        }
        return audio;
    }

    private setState(s: SpeechState): void {
        this.current = s;
        for (const l of this.listeners) l(s);
    }

    private setProgress(group: string, progress: PrefetchProgress, abort: AbortController): void {
        this.groups.set(group, { abort, progress });
        for (const l of this.groupListeners.get(group) ?? []) l(progress);
    }
}
