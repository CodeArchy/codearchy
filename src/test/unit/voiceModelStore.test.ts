import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import { KOKORO_FILES, KOKORO_REPO, KOKORO_REVISION, BASE_PACK_BYTES, ModelFile, VoiceModelStore } from '../../voice/VoiceModelStore';

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const GOOD = Buffer.from('a'.repeat(200_000)); // several chunks
const SMALL = Buffer.from('{"ok":true}');
const FILES: Record<string, ModelFile> = {
    'onnx/model_quantized.onnx': { size: GOOD.length, sha256: sha(GOOD) },
    'config.json': { size: SMALL.length, sha256: sha(SMALL) },
    'onnx/model.onnx': { size: GOOD.length, sha256: sha(GOOD), explicitOnly: true },
    'tampered.bin': { size: GOOD.length, sha256: sha(GOOD) },
};

/** Fake Hugging Face: serves files at /<repo>/resolve/<rev>/<path>, via one redirect. */
function fakeHub(): Promise<{ base: string; hits: Map<string, number>; close: () => void }> {
    const hits = new Map<string, number>();
    const server = http.createServer((req, res) => {
        const url = req.url ?? '';
        if (url.startsWith(`/${KOKORO_REPO}/resolve/`)) {
            res.writeHead(302, { Location: url.replace('/resolve/', '/cdn/') }).end();
            return;
        }
        const rel = url.split(`/cdn/${KOKORO_REVISION}/`)[1];
        hits.set(rel, (hits.get(rel) ?? 0) + 1);
        const body = rel === 'config.json' ? SMALL : rel === 'tampered.bin' ? Buffer.from('b'.repeat(GOOD.length)) : GOOD;
        res.writeHead(200, { 'Content-Length': body.length });
        // Stream in pieces, slowly enough for concurrent requests to overlap.
        let i = 0;
        const step = () => {
            if (i >= body.length) return void res.end();
            res.write(body.subarray(i, i + 16_384));
            i += 16_384;
            setTimeout(step, 2);
        };
        step();
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        hits,
        close: () => server.close(),
    })));
}

/** A model server in front of the store, like ArchitecturePanel's. */
function frontServer(store: VoiceModelStore): Promise<{ url: (rel: string) => string; close: () => void }> {
    const server = http.createServer((req, res) => void store.serve(decodeURIComponent((req.url ?? '/').slice(1)), req, res));
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        url: (rel) => `http://127.0.0.1:${(server.address() as AddressInfo).port}/${rel}`,
        close: () => server.close(),
    })));
}

function get(url: string, method = 'GET'): Promise<{ status: number; body: Buffer; aborted: boolean }> {
    return new Promise((resolve) => {
        const req = http.request(url, { method }, (res) => {
            const chunks: Buffer[] = [];
            let aborted = false;
            res.on('data', (c) => chunks.push(c));
            res.on('aborted', () => (aborted = true));
            res.on('error', () => (aborted = true));
            res.on('close', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), aborted: aborted || !res.complete }));
        });
        req.on('error', () => resolve({ status: 0, body: Buffer.alloc(0), aborted: true }));
        req.end();
    });
}

suite('Voice model store (on-demand Kokoro download)', () => {
    let tmp: string;
    let hub: Awaited<ReturnType<typeof fakeHub>>;
    let front: Awaited<ReturnType<typeof frontServer>>;
    let store: VoiceModelStore;

    setup(async () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codearchy-voice-'));
        hub = await fakeHub();
        store = new VoiceModelStore({ cacheDir: tmp, baseUrl: hub.base, files: FILES });
        front = await frontServer(store);
    });
    teardown(() => {
        front.close();
        hub.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    test('a cache miss downloads, streams through, verifies, and caches', async () => {
        const r = await get(front.url('onnx/model_quantized.onnx'));
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.aborted, false);
        assert.ok(r.body.equals(GOOD));
        assert.ok(store.localPath('onnx/model_quantized.onnx'), 'file should be cached after verification');
        const again = await get(front.url('onnx/model_quantized.onnx'));
        assert.ok(again.body.equals(GOOD));
        assert.strictEqual(hub.hits.get('onnx/model_quantized.onnx'), 1, 'second request must be served from cache');
    });

    test('a hash mismatch never completes on the client and is never cached', async () => {
        const r = await get(front.url('tampered.bin'));
        assert.strictEqual(r.aborted, true, 'response must be cut off, not completed');
        assert.ok(r.body.length < GOOD.length, 'the final chunk must be held back');
        assert.strictEqual(store.localPath('tampered.bin'), undefined);
        // The partial download is removed too.
        const leftovers = fs.readdirSync(tmp, { recursive: true }).map(String).filter((f) => f.endsWith('.download'));
        assert.deepStrictEqual(leftovers, []);
    });

    test('concurrent requests share one download', async () => {
        const [a, b, c] = await Promise.all([1, 2, 3].map(() => get(front.url('onnx/model_quantized.onnx'))));
        for (const r of [a, b, c]) assert.ok(r.body.equals(GOOD));
        assert.strictEqual(hub.hits.get('onnx/model_quantized.onnx'), 1);
    });

    test('HEAD never downloads; explicit-only files are not fetched implicitly', async () => {
        assert.strictEqual((await get(front.url('config.json'), 'HEAD')).status, 404);
        assert.strictEqual((await get(front.url('onnx/model.onnx'))).status, 404);
        assert.strictEqual(hub.hits.size, 0);
        await store.ensure('onnx/model.onnx'); // the explicit GPU download path
        assert.strictEqual((await get(front.url('onnx/model.onnx'), 'HEAD')).status, 200);
    });

    test('names outside the manifest are rejected (no path traversal)', async () => {
        assert.strictEqual((await get(front.url('../../etc/passwd'))).status, 404);
        // The store matches exact manifest keys, so dot segments never resolve.
        for (const name of ['voices/../config.json', '../config.json', '/config.json', 'onnx\\model.onnx']) {
            assert.strictEqual(store.isKnown(name), false, name);
            assert.strictEqual(store.localPath(name), undefined, name);
        }
        await assert.rejects(store.ensure('../outside'));
    });

    test('a bundled development copy is used without downloading', async () => {
        const bundled = fs.mkdtempSync(path.join(os.tmpdir(), 'codearchy-voice-bundled-'));
        fs.writeFileSync(path.join(bundled, 'config.json'), SMALL);
        const withBundle = new VoiceModelStore({ cacheDir: tmp, bundledDir: bundled, baseUrl: hub.base, files: FILES });
        assert.ok(withBundle.localPath('config.json')?.startsWith(bundled));
        fs.rmSync(bundled, { recursive: true, force: true });
    });

    test('the real manifest pins the base pack', () => {
        assert.match(KOKORO_REVISION, /^[0-9a-f]{40}$/);
        assert.ok(Object.values(KOKORO_FILES).every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
        assert.strictEqual(Object.keys(KOKORO_FILES).filter((k) => k.startsWith('voices/')).length, 28);
        assert.ok(BASE_PACK_BYTES > 100e6 && BASE_PACK_BYTES < 110e6, `base pack ${BASE_PACK_BYTES}`);
    });
});
