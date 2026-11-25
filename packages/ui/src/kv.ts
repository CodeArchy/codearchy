/** A small key-value store in IndexedDB for the UI's own state (chat history); memory only when it's unavailable. */
export interface KeyValue {
    get<T>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
}

export function indexedDbKeyValue(db = 'codearchy-ui'): KeyValue {
    const memory = new Map<string, unknown>();
    let opening: Promise<IDBDatabase | undefined> | undefined;
    const open = () =>
        (opening ??= new Promise((resolve) => {
            try {
                const req = indexedDB.open(db, 1);
                req.onupgradeneeded = () => req.result.createObjectStore('kv');
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => resolve(undefined);
            } catch {
                resolve(undefined);
            }
        }));
    return {
        async get<T>(key: string): Promise<T | undefined> {
            const d = await open();
            if (!d) return memory.get(key) as T | undefined;
            return new Promise((resolve) => {
                const r = d.transaction('kv').objectStore('kv').get(key);
                r.onsuccess = () => resolve(r.result as T | undefined);
                r.onerror = () => resolve(undefined);
            });
        },
        async set(key: string, value: unknown): Promise<void> {
            const d = await open();
            if (!d) return void memory.set(key, value);
            await new Promise<void>((resolve) => {
                const t = d.transaction('kv', 'readwrite');
                t.objectStore('kv').put(value, key);
                t.oncomplete = () => resolve();
                t.onerror = () => resolve();
                t.onabort = () => resolve();
            });
        },
    };
}

export function memoryKeyValue(): KeyValue {
    const m = new Map<string, unknown>();
    return { get: async <T,>(k: string) => m.get(k) as T | undefined, set: async (k, v) => void m.set(k, v) };
}
