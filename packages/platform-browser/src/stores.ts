/**
 * Small persistent stores for browser hosts (pages and workers): a key-value
 * store on IndexedDB, and an encrypted store for secrets such as API keys.
 *
 * Secrets are encrypted with AES-GCM under a key WebCrypto generates as
 * non-extractable and keeps in IndexedDB: the raw key material can never be
 * read out, not even by this page's own scripts, so stored data copied from
 * disk is useless without this browser profile. That's what it protects
 * against. It does not protect against code running on the page itself (which
 * can ask the store to decrypt), so a host's content security policy still
 * matters.
 *
 * When IndexedDB isn't available (some private modes), both stores fall back
 * to memory and report `persistent === false`.
 */

const DB_VERSION = 1;
const STORE = 'kv';

function promisify<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
    });
}

export class IdbKeyValue {
    private db?: Promise<IDBDatabase | undefined>;
    private readonly memory = new Map<string, unknown>();
    private usable = true;

    constructor(private readonly name = 'codearchy') {}

    /** False when values only live in memory for this session. */
    async persistent(): Promise<boolean> {
        return !!(await this.open());
    }

    async get<T>(key: string): Promise<T | undefined> {
        const db = await this.open();
        if (!db) return this.memory.get(key) as T | undefined;
        return (await promisify(db.transaction(STORE, 'readonly').objectStore(STORE).get(key))) as T | undefined;
    }

    async set(key: string, value: unknown): Promise<void> {
        const db = await this.open();
        if (!db) return void this.memory.set(key, value);
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, key);
        await done(tx);
    }

    async delete(key: string): Promise<void> {
        const db = await this.open();
        if (!db) return void this.memory.delete(key);
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(key);
        await done(tx);
    }

    /** Keys starting with `prefix` (bounded by an IDBKeyRange, so only those rows are read). */
    async keys(prefix = ''): Promise<string[]> {
        const db = await this.open();
        if (!db) return [...this.memory.keys()].filter((k) => k.startsWith(prefix));
        const range = prefix ? IDBKeyRange.bound(prefix, `${prefix}￿`) : undefined;
        return (await promisify(db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys(range))).map(String);
    }

    private open(): Promise<IDBDatabase | undefined> {
        this.db ??= new Promise((resolve) => {
            if (!this.usable || typeof indexedDB === 'undefined') return resolve(undefined);
            let req: IDBOpenDBRequest;
            try {
                req = indexedDB.open(this.name, DB_VERSION);
            } catch {
                return resolve(undefined);
            }
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => {
                this.usable = false;
                resolve(undefined);
            };
            req.onblocked = () => resolve(undefined);
        });
        return this.db;
    }
}

function done(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
}

interface Sealed {
    iv: Uint8Array;
    data: ArrayBuffer;
}

const KEY_NAME = 'secret-store:key';
const PREFIX = 'secret:';

/** Encrypted secrets (the shape of @codearchy/providers' SecretStore). */
export class IdbSecretStore {
    private key?: Promise<CryptoKey>;

    constructor(private readonly kv: IdbKeyValue = new IdbKeyValue()) {}

    async get(name: string): Promise<string | undefined> {
        const sealed = await this.kv.get<Sealed>(PREFIX + name);
        if (!sealed) return undefined;
        try {
            const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv as BufferSource }, await this.cryptoKey(), sealed.data);
            return new TextDecoder().decode(plain);
        } catch {
            return undefined; // sealed under a key that no longer exists (site data partly cleared)
        }
    }

    async set(name: string, value: string): Promise<void> {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, await this.cryptoKey(), new TextEncoder().encode(value));
        await this.kv.set(PREFIX + name, { iv, data } satisfies Sealed);
    }

    async delete(name: string): Promise<void> {
        await this.kv.delete(PREFIX + name);
    }

    /** The non-extractable AES-GCM key, created on first use and kept in IndexedDB. */
    private cryptoKey(): Promise<CryptoKey> {
        this.key ??= (async () => {
            const existing = await this.kv.get<CryptoKey>(KEY_NAME);
            if (existing) return existing;
            const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
            await this.kv.set(KEY_NAME, key);
            return key;
        })();
        return this.key;
    }
}
