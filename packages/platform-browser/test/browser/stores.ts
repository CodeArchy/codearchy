/**
 * Checks for the browser stores, run inside the conformance worker in each
 * engine. Results use the conformance suite's shape so the runner reports them
 * alongside it.
 */
import { IdbKeyValue, IdbSecretStore } from '../../src/stores.js';

type Result = { name: string; ok: boolean; ms: number; error?: string; skipped?: boolean };

async function check(name: string, body: () => Promise<void>): Promise<Result> {
    const t = performance.now();
    try {
        await body();
        return { name, ok: true, ms: Math.round(performance.now() - t) };
    } catch (err) {
        return { name, ok: false, ms: Math.round(performance.now() - t), error: (err as Error).stack ?? String(err) };
    }
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

export async function storeChecks(): Promise<Result[]> {
    const db = `codearchy-store-test-${Math.random().toString(36).slice(2)}`;
    return [
        await check('browser stores: key-value persists across instances, with prefix listing', async () => {
            const a = new IdbKeyValue(db);
            assert(await a.persistent(), 'IndexedDB should be available in a worker');
            await a.set('settings:ai', { tier: 'structure' });
            await a.set('usage:x:day', 12);
            await a.set('other', 1);
            const b = new IdbKeyValue(db);
            const got = await b.get<{ tier: string }>('settings:ai');
            assert(got?.tier === 'structure', `read back ${JSON.stringify(got)}`);
            const keys = (await b.keys('usage:')).join(',');
            assert(keys === 'usage:x:day', `prefix keys: ${keys}`);
            await b.delete('other');
            assert((await a.get('other')) === undefined, 'deleted');
        }),
        await check('browser stores: secrets are encrypted at rest under a non-extractable key', async () => {
            const kv = new IdbKeyValue(db);
            const secrets = new IdbSecretStore(kv);
            const key = 'sk-ant-browser-test-0123456789';
            await secrets.set('codearchy.provider.anthropic.apiKey', key);
            assert((await new IdbSecretStore(new IdbKeyValue(db)).get('codearchy.provider.anthropic.apiKey')) === key, 'a new instance decrypts it');
            const raw = await kv.get<{ iv: Uint8Array; data: ArrayBuffer }>('secret:codearchy.provider.anthropic.apiKey');
            assert(raw && raw.iv.byteLength === 12 && raw.data.byteLength > 0, 'stored sealed');
            assert(!new TextDecoder().decode(raw.data).includes('sk-ant'), 'not stored as plaintext');
            const cryptoKey = await kv.get<CryptoKey>('secret-store:key');
            assert(cryptoKey && cryptoKey.extractable === false, 'the key is not extractable');
            let exported = true;
            await crypto.subtle.exportKey('raw', cryptoKey).catch(() => (exported = false));
            assert(!exported, 'exporting the key fails');
            await secrets.delete('codearchy.provider.anthropic.apiKey');
            assert((await secrets.get('codearchy.provider.anthropic.apiKey')) === undefined, 'deleted');
        }),
    ];
}
