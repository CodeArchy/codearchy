/**
 * Narration that sounds instant: audio is made ahead and kept.
 *
 * A tour's steps are synthesised in the background (the next step first),
 * stored per voice in IndexedDB, and played straight from there: the next
 * step is ready before you press Next, and a tour you come back to speaks at
 * once. The key is the voice's identity (engine, model, voice, speed) plus the
 * text, so a changed step or another voice simply records again.
 *
 * Hosts provide the voice (VoiceClient); voices that can't be kept (the
 * system voice) speak directly.
 */
import type { SpeakOptions, SynthesisPriority, VoiceAudio, VoiceClient } from '@codearchy/protocol';

/** What the narrator is preparing, for "Voice ready for 3 of 7 steps". */
export interface NarrationProgress {
    ready: number;
    total: number;
}

export interface AudioStore {
    get(id: string): Promise<VoiceAudio | undefined>;
    put(id: string, audio: VoiceAudio): Promise<void>;
}

const DB = 'codearchy-narration';
const MAX_BYTES = 200 * 1024 * 1024;

/** IndexedDB, newest kept: least recently played clips go once the store passes ~200 MB. */
export function indexedDbAudioStore(maxBytes = MAX_BYTES): AudioStore {
    let opening: Promise<IDBDatabase | undefined> | undefined;
    const open = () =>
        (opening ??= new Promise((resolve) => {
            try {
                const req = indexedDB.open(DB, 1);
                req.onupgradeneeded = () => {
                    req.result.createObjectStore('audio');
                    req.result.createObjectStore('meta').createIndex('at', 'at');
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => resolve(undefined);
            } catch {
                resolve(undefined); // no IndexedDB (private mode): memory only
            }
        }));
    const done = (t: IDBTransaction) => new Promise<void>((resolve) => ((t.oncomplete = () => resolve()), (t.onerror = () => resolve()), (t.onabort = () => resolve())));
    const evict = async (db: IDBDatabase) => {
        const metas = await new Promise<Array<{ id: string; bytes: number; at: number }>>((resolve) => {
            const r = db.transaction('meta').objectStore('meta').getAll();
            r.onsuccess = () => resolve(r.result as Array<{ id: string; bytes: number; at: number }>);
            r.onerror = () => resolve([]);
        });
        let total = metas.reduce((n, m) => n + m.bytes, 0);
        if (total <= maxBytes) return;
        const t = db.transaction(['audio', 'meta'], 'readwrite');
        for (const m of metas.sort((a, b) => a.at - b.at)) {
            if (total <= maxBytes * 0.8) break;
            t.objectStore('audio').delete(m.id);
            t.objectStore('meta').delete(m.id);
            total -= m.bytes;
        }
        await done(t);
    };
    return {
        async get(id) {
            const db = await open();
            if (!db) return undefined;
            const rec = await new Promise<{ pcm: ArrayBuffer; sampleRate: number } | undefined>((resolve) => {
                const r = db.transaction('audio').objectStore('audio').get(id);
                r.onsuccess = () => resolve(r.result as { pcm: ArrayBuffer; sampleRate: number } | undefined);
                r.onerror = () => resolve(undefined);
            });
            if (!rec) return undefined;
            // Played: it's recent again.
            const t = db.transaction('meta', 'readwrite');
            t.objectStore('meta').put({ id, bytes: rec.pcm.byteLength, at: Date.now() }, id);
            return { pcm: new Float32Array(rec.pcm), sampleRate: rec.sampleRate };
        },
        async put(id, audio) {
            const db = await open();
            if (!db) return;
            const pcm = audio.pcm.slice().buffer;
            const t = db.transaction(['audio', 'meta'], 'readwrite');
            t.objectStore('audio').put({ pcm, sampleRate: audio.sampleRate }, id);
            t.objectStore('meta').put({ id, bytes: pcm.byteLength, at: Date.now() }, id);
            await done(t);
            await evict(db);
        },
    };
}

async function digest(text: string): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const RANK: Record<SynthesisPriority, number> = { now: 0, soon: 1, later: 2 };

export class Narrator {
    private readonly memory = new Map<string, VoiceAudio>();
    private readonly making = new Map<string, { priority: SynthesisPriority; done: Promise<VoiceAudio | undefined> }>();
    private progress: NarrationProgress = { ready: 0, total: 0 };
    private batch = new Set<string>();
    private readonly listeners = new Set<(p: NarrationProgress) => void>();
    private turn = 0;

    constructor(
        readonly voice: VoiceClient,
        private readonly store: AudioStore = indexedDbAudioStore()
    ) {}

    /** Whether this voice's audio is kept (otherwise narration speaks directly). */
    get caching(): boolean {
        return !!(this.voice.synthesize && this.voice.play && this.voice.cacheKey?.());
    }

    subscribe(listener: (p: NarrationProgress) => void): () => void {
        this.listeners.add(listener);
        listener(this.progress);
        return () => this.listeners.delete(listener);
    }

    /** Speaks `text`: from the cache when it's there (instantly), otherwise as it's made, then kept. */
    speak(text: string, options: SpeakOptions = {}): void {
        const mine = ++this.turn;
        const key = this.voice.cacheKey?.();
        if (!key || !this.voice.synthesize || !this.voice.play) return this.voice.speak(text, options);
        void (async () => {
            const id = await digest(`${key}\n${text}`);
            const kept = await this.lookup(id);
            if (mine !== this.turn) return;
            if (kept) return this.voice.play!(kept, options);
            const pending = this.making.get(id);
            if (pending && !this.voice.capturesSpeech) {
                // Already being made: ask for it first, play it when it's there.
                const audio = await this.make(id, text, 'now');
                if (mine !== this.turn) return;
                return audio ? this.voice.play!(audio, options) : this.voice.speak(text, options);
            }
            this.voice.speak(text, {
                ...options,
                onAudio: (audio) => {
                    options.onAudio?.(audio);
                    void this.keep(id, audio);
                },
            });
            // If you move on before it's spoken to the end, the host finishes it in the
            // background: wait for that too, so the step is kept for next time.
            if (this.voice.capturesSpeech) void this.make(id, text, 'later');
        })();
    }

    stop(): void {
        this.turn++;
        this.voice.stop();
    }

    /**
     * Makes and keeps audio for these texts, in order, without playing it. The
     * first ones get `first` priority (the next step), the rest `later`.
     */
    prefetch(texts: string[], options: { first?: number; priority?: SynthesisPriority } = {}): void {
        const key = this.voice.cacheKey?.();
        if (!key || !this.voice.synthesize) return this.setProgress(new Set(), 0);
        const first = options.first ?? 1;
        void (async () => {
            const ids = await Promise.all(texts.map((t) => digest(`${key}\n${t}`)));
            this.batch = new Set(ids);
            let ready = 0;
            this.setProgress(this.batch, ready);
            for (let i = 0; i < texts.length; i++) {
                const id = ids[i]!;
                const priority: SynthesisPriority = i < first ? (options.priority ?? 'soon') : 'later';
                void this.lookup(id).then(async (kept) => {
                    const audio = kept ?? (await this.make(id, texts[i]!, priority));
                    if (audio && this.batch.has(id)) this.setProgress(this.batch, ++ready);
                });
            }
        })();
    }

    /** Leaves queued (not started) synthesis behind: a closed tour's remaining steps. */
    cancelPrefetch(): void {
        this.voice.cancelPending?.();
        this.setProgress(new Set(), 0);
    }

    private setProgress(batch: Set<string>, ready: number): void {
        this.progress = { ready: Math.min(ready, batch.size), total: batch.size };
        for (const l of this.listeners) l(this.progress);
    }

    private async lookup(id: string): Promise<VoiceAudio | undefined> {
        const hit = this.memory.get(id);
        if (hit) return hit;
        const stored = await this.store.get(id).catch(() => undefined);
        if (stored) this.remember(id, stored);
        return stored;
    }

    private make(id: string, text: string, priority: SynthesisPriority): Promise<VoiceAudio | undefined> {
        const pending = this.making.get(id);
        // The host raises a queued job's priority when the same text is asked for sooner.
        if (pending && RANK[priority] >= RANK[pending.priority]) return pending.done;
        const done = this.voice.synthesize!(text, priority)
            .then((audio) => {
                if (audio) void this.keep(id, audio);
                return audio;
            })
            .catch(() => undefined)
            .finally(() => this.making.get(id)?.done === done && this.making.delete(id));
        this.making.set(id, { priority, done });
        return done;
    }

    private async keep(id: string, audio: VoiceAudio): Promise<void> {
        this.remember(id, audio);
        await this.store.put(id, audio).catch(() => undefined);
    }

    private remember(id: string, audio: VoiceAudio): void {
        this.memory.delete(id);
        this.memory.set(id, audio);
        while (this.memory.size > 24) this.memory.delete(this.memory.keys().next().value!);
    }
}
