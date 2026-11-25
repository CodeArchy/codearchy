/**
 * Kept speech: phrase audio in IndexedDB, least recently played out first once
 * the store passes ~200 MB. Memory only when IndexedDB isn't available.
 *
 * Built so a lookup never waits: writes (new phrases, "played" times) are
 * batched into one transaction every ~250 ms instead of one per phrase, the
 * total size is tracked as it changes rather than recounted on every write,
 * and phrases not written yet are served from the batch.
 */
import type { VoiceAudio } from '@codearchy/protocol';

export interface AudioStore {
    get(id: string): Promise<VoiceAudio | undefined>;
    put(id: string, audio: VoiceAudio): Promise<void>;
}

const DB = 'codearchy-speech';
const MAX_BYTES = 200 * 1024 * 1024;
const FLUSH_MS = 250;

interface Meta {
    id: string;
    bytes: number;
    at: number;
}

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

    /** Not written yet. */
    const writes = new Map<string, VoiceAudio>();
    /** Played since the last flush (their "last used" moves on). */
    const touched = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** Bytes in the store (read once, then kept up to date). */
    let total: number | undefined;

    const schedule = () => {
        timer ??= setTimeout(() => {
            timer = undefined;
            void flush();
        }, FLUSH_MS);
    };

    async function flush(): Promise<void> {
        const db = await open();
        if (!db || (!writes.size && !touched.size)) return;
        const batch = [...writes];
        const seen = [...touched].filter((id) => !writes.has(id));
        writes.clear();
        touched.clear();
        const now = Date.now();
        if (total === undefined) {
            total = await new Promise<number>((resolve) => {
                const r = db.transaction('meta').objectStore('meta').getAll();
                r.onsuccess = () => resolve((r.result as Meta[]).reduce((n, m) => n + m.bytes, 0));
                r.onerror = () => resolve(0);
            });
        }
        const t = db.transaction(['audio', 'meta'], 'readwrite');
        const audio = t.objectStore('audio');
        const meta = t.objectStore('meta');
        for (const [id, a] of batch) {
            const pcm = a.pcm.slice().buffer;
            audio.put({ pcm, sampleRate: a.sampleRate }, id);
            meta.put({ id, bytes: pcm.byteLength, at: now } satisfies Meta, id);
            total += pcm.byteLength;
        }
        for (const id of seen) {
            const r = meta.get(id);
            r.onsuccess = () => r.result && meta.put({ ...(r.result as Meta), at: now }, id);
        }
        await done(t);
        if (total > maxBytes) await evict(db);
    }

    /** Oldest first, down to 80% of the budget. */
    async function evict(db: IDBDatabase): Promise<void> {
        const metas = await new Promise<Meta[]>((resolve) => {
            const r = db.transaction('meta').objectStore('meta').getAll();
            r.onsuccess = () => resolve(r.result as Meta[]);
            r.onerror = () => resolve([]);
        });
        let size = metas.reduce((n, m) => n + m.bytes, 0);
        const t = db.transaction(['audio', 'meta'], 'readwrite');
        for (const m of metas.sort((a, b) => a.at - b.at)) {
            if (size <= maxBytes * 0.8) break;
            t.objectStore('audio').delete(m.id);
            t.objectStore('meta').delete(m.id);
            size -= m.bytes;
        }
        await done(t);
        total = size;
    }

    return {
        async get(id) {
            const pending = writes.get(id);
            if (pending) return pending;
            const db = await open();
            if (!db) return undefined;
            const rec = await new Promise<{ pcm: ArrayBuffer; sampleRate: number } | undefined>((resolve) => {
                const r = db.transaction('audio').objectStore('audio').get(id);
                r.onsuccess = () => resolve(r.result as { pcm: ArrayBuffer; sampleRate: number } | undefined);
                r.onerror = () => resolve(undefined);
            });
            if (!rec) return undefined;
            touched.add(id);
            schedule();
            return { pcm: new Float32Array(rec.pcm), sampleRate: rec.sampleRate };
        },
        async put(id, audio) {
            writes.set(id, audio);
            schedule();
        },
    };
}
