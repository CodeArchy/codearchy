/**
 * On-demand store for the Kokoro voice model.
 *
 * The VSIX doesn't bundle the ~107 MB voice pack. The first time the voice
 * worker asks the localhost model server for a file, the store downloads it
 * from Hugging Face at a pinned commit, verifies size and sha256, and caches
 * it in the extension's global storage, where it survives extension updates.
 *
 * Bytes are streamed through to the requester while downloading (so the
 * worker's own progress bar shows real progress), but the final chunk is
 * held back until the hash is verified: a corrupted or tampered file never
 * completes on the client and is never cached.
 *
 * Downloads only happen in response to the voice engine loading, which only
 * starts after the user activates Kokoro. The webview itself never talks to
 * the network; only the extension host does, through this store.
 *
 * Host-agnostic: no `vscode` import, so it is unit-tested in plain Node.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';

export const KOKORO_REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX';
/** Pinned commit: bump together with the hashes below. */
export const KOKORO_REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';

export interface ModelFile {
    size: number;
    sha256: string;
    /** Fetched only by an explicit request (the optional ~326 MB GPU model). */
    explicitOnly?: boolean;
}

const VOICE_SHA256: Record<string, string> = {
    af_alloy: 'c4a6b876047fd7fb472edf4ebd63cfac7c3b958a7cae7c106e8f038ca6308c45',
    af_aoede: '4a004c33430762e2461eedb2013fad808ef4ab3121f5300f554476caf58d8361',
    af_bella: 'f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b',
    af_heart: 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b',
    af_jessica: 'a240a5e3c15b43563d6e923bdca8ef5613a23471d9b77653694012435df23bd8',
    af_kore: '9be5221b6a941c04b561959b8ff0b06e809444dcc4ab7e75a7b23606f691819e',
    af_nicole: 'cd2191ab31b914ed7b318416b0e4440fdf392ddad9106a060819aa600a64f59a',
    af_nova: '18778272caa0d0eebaea251c35fd635f038434f9eee5e691d02a174bd328414f',
    af_river: '00a2bcf82b1d86e8f19902ede58c65ccf6c0e43b44b7d74fad54e5d8933c9c30',
    af_sarah: '4409fbc125afabacc615d94db5398d847006a737b0247d6892b7a9a0007a2f0a',
    af_sky: '4435255c9744f3f31659e0d714ab7689bf65d9e77ec1cce060f083912614f0b9',
    am_adam: '162b035ed91cfc48b6046982184c645f72edcdd1b82843347f605d7bf7b15716',
    am_echo: '3968b92c3c4cd1c4416dbded36c13eaa388a90d5788d02a13e4d781f5f8cf3c3',
    am_eric: 'e8b5be17edd1e3636901ce7598baafe2dc8dd8ff707a0c23bf9e461add7e2832',
    am_fenrir: 'c27989f741f7ee34d273a39d8a595cc0837d35f5ced9a29b7cc162614616df43',
    am_liam: '52403be32fd047c6a44517cb0bcd6b134f2a18baa73e70ef41651e0eab921ade',
    am_michael: '1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1',
    am_onyx: 'da5d135b424164916d75a68ffb4c2abce3d7d5ccc82dd1ee6cf447ce286145e6',
    am_puck: 'fcf73c989033e9233e0b98713eca600c8c74dcc1614b37009d5450ff4a2274a0',
    am_santa: '61150cf726ab6c5ed7a99f90a304f91f5a72c00c592e89ec94e5df11c319227a',
    bf_alice: '08afa6ba24da61ea5e8efa139e5aadc938d83f0a6da5a900adaf763ac1da5573',
    bf_emma: '669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73',
    bf_isabella: '3754352c4aaa46d17f27654ab7518d65b62ad6163a0f55a5f4330c2da2c4e94f',
    bf_lily: '5e0ee32ebe64a467124976b14e69590746f1c4ce41a12b587a50c862edfea335',
    bm_daniel: '6b3194bbceffb746733cbc22c8f593dd44e401a71d53895a2dca891bc595a1e8',
    bm_fable: 'f889083196807b4adb15e9204252165f503b8d33d3982e681c52443c49d798f1',
    bm_george: 'c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc',
    bm_lewis: 'b8f671cef828c30e66fdf0b0756a76bba58f6bb3398cbbf27058642acbcedb97',
};

/** Every file the voice worker may request, relative to the repo root. */
export const KOKORO_FILES: Record<string, ModelFile> = {
    'config.json': { size: 44, sha256: 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f' },
    'tokenizer.json': { size: 3497, sha256: '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34' },
    'tokenizer_config.json': { size: 113, sha256: 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20' },
    'onnx/model_quantized.onnx': { size: 92361116, sha256: 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478' },
    'onnx/model.onnx': { size: 325532232, sha256: '8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb', explicitOnly: true },
    ...Object.fromEntries(Object.entries(VOICE_SHA256).map(([v, sha256]) => [`voices/${v}.bin`, { size: 522240, sha256 }])),
};

/** Size of the files fetched automatically when voice is first used. */
export const BASE_PACK_BYTES = Object.values(KOKORO_FILES)
    .filter((f) => !f.explicitOnly)
    .reduce((n, f) => n + f.size, 0);

export interface StoreOptions {
    /** Writable cache root (e.g. the extension's globalStorage/voice). */
    cacheDir: string;
    /** Read-only copy shipped or prepared for development (optional). */
    bundledDir?: string;
    /** Download origin, without trailing slash. Overridable for tests. */
    baseUrl?: string;
    revision?: string;
    files?: Record<string, ModelFile>;
    log?: (message: string) => void;
}

export interface DownloadProgress {
    receivedBytes: number;
    totalBytes: number;
}

export class IntegrityError extends Error {}

export class VoiceModelStore {
    private readonly files: Record<string, ModelFile>;
    private readonly revisionDir: string;
    private readonly inflight = new Map<string, Promise<string>>();

    constructor(private readonly options: StoreOptions) {
        this.files = options.files ?? KOKORO_FILES;
        this.revisionDir = path.join(options.cacheDir, `kokoro-${(options.revision ?? KOKORO_REVISION).slice(0, 12)}`);
    }

    isKnown(rel: string): boolean {
        return Object.prototype.hasOwnProperty.call(this.files, rel);
    }

    /** Path of a verified local copy, or undefined. Never downloads. */
    localPath(rel: string): string | undefined {
        const spec = this.files[rel];
        if (!spec) return undefined;
        const cached = path.join(this.revisionDir, rel);
        if (sizeOf(cached) === spec.size) return cached;
        if (this.options.bundledDir) {
            const bundled = path.join(this.options.bundledDir, rel);
            if (sizeOf(bundled) === spec.size) return bundled;
        }
        return undefined;
    }

    /** Downloads (if needed) and returns the verified local path. */
    ensure(rel: string, onProgress?: (p: DownloadProgress) => void, signal?: AbortSignal): Promise<string> {
        const local = this.localPath(rel);
        if (local) return Promise.resolve(local);
        if (!this.isKnown(rel)) return Promise.reject(new Error(`unknown model file: ${rel}`));
        const existing = this.inflight.get(rel);
        if (existing) return existing;
        const p = this.download(rel, { onProgress, signal }).finally(() => this.inflight.delete(rel));
        this.inflight.set(rel, p);
        return p;
    }

    /**
     * Serves one model file over HTTP. HEAD never downloads (the worker uses
     * HEAD to probe for the optional GPU model). GET downloads on a cache miss
     * unless the file is explicit-only, streaming bytes through as they arrive.
     */
    async serve(rel: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const spec = this.files[rel];
        if (!spec) {
            res.writeHead(404).end();
            return;
        }
        const headers = {
            'Content-Type': rel.endsWith('.json') ? 'application/json' : 'application/octet-stream',
            'Content-Length': spec.size,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': rel.endsWith('.json') ? 'no-cache' : 'public, max-age=3600, immutable',
        };
        const local = this.localPath(rel);
        if (req.method === 'HEAD') {
            res.writeHead(local ? 200 : 404, local ? headers : undefined).end();
            return;
        }
        if (local) {
            res.writeHead(200, headers);
            fs.createReadStream(local).pipe(res);
            return;
        }
        if (spec.explicitOnly) {
            res.writeHead(404).end();
            return;
        }
        // Another request is already downloading this file: wait, then serve.
        const pending = this.inflight.get(rel);
        if (pending) {
            try {
                const file = await pending;
                res.writeHead(200, headers);
                fs.createReadStream(file).pipe(res);
            } catch {
                res.writeHead(502).end();
            }
            return;
        }
        res.writeHead(200, headers);
        const p = this.download(rel, { tee: res }).finally(() => this.inflight.delete(rel));
        this.inflight.set(rel, p);
        try {
            await p;
        } catch (err) {
            this.options.log?.(`voice model download failed (${rel}): ${(err as Error).message}`);
            res.destroy(); // the client sees a failed request, never a complete bad file
        }
    }

    private download(
        rel: string,
        opts: { tee?: http.ServerResponse; onProgress?: (p: DownloadProgress) => void; signal?: AbortSignal }
    ): Promise<string> {
        const spec = this.files[rel];
        const dest = path.join(this.revisionDir, rel);
        const tmp = `${dest}.${process.pid}.${Date.now()}.download`;
        const url = `${this.options.baseUrl ?? 'https://huggingface.co'}/${KOKORO_REPO}/resolve/${this.options.revision ?? KOKORO_REVISION}/${rel}`;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        this.options.log?.(`downloading voice model file ${rel} (${(spec.size / 1e6).toFixed(1)} MB)`);

        return new Promise<string>((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            const out = fs.createWriteStream(tmp);
            let received = 0;
            let heldBack: Buffer | undefined;
            let settled = false;
            const fail = (err: Error) => {
                if (settled) return;
                settled = true;
                out.destroy();
                fs.rm(tmp, { force: true }, () => reject(err));
            };
            // Destroying a write stream with writes still queued emits an error;
            // route it through fail() (a no-op once settled) instead of crashing.
            out.on('error', (e) => fail(e));
            opts.signal?.addEventListener('abort', () => fail(new Error('Download cancelled')), { once: true });

            const get = (target: string, redirects: number) => {
                if (opts.signal?.aborted) return fail(new Error('Download cancelled'));
                const transport = target.startsWith('https:') ? https : http;
                const req = transport.get(target, { headers: { 'User-Agent': 'CodeArchy' }, signal: opts.signal }, (res) => {
                    const status = res.statusCode ?? 0;
                    if (status >= 300 && status < 400 && res.headers.location) {
                        res.resume();
                        if (redirects >= 10) return fail(new Error('too many redirects'));
                        return get(new URL(res.headers.location, target).href, redirects + 1);
                    }
                    if (status !== 200) {
                        res.resume();
                        return fail(new Error(`HTTP ${status} for ${rel}`));
                    }
                    res.on('data', (chunk: Buffer) => {
                        received += chunk.length;
                        if (received > spec.size) {
                            req.destroy();
                            return fail(new IntegrityError(`${rel}: more bytes than expected`));
                        }
                        hash.update(chunk);
                        out.write(chunk);
                        if (opts.tee) {
                            if (heldBack) opts.tee.write(heldBack);
                            heldBack = chunk;
                        }
                        opts.onProgress?.({ receivedBytes: received, totalBytes: spec.size });
                    });
                    res.on('error', (e) => fail(e));
                    res.on('end', () => {
                        const digest = hash.digest('hex');
                        if (received !== spec.size || digest !== spec.sha256) {
                            return fail(new IntegrityError(`${rel}: integrity check failed (size ${received}, sha256 ${digest})`));
                        }
                        out.end(() => {
                            try {
                                fs.renameSync(tmp, dest);
                            } catch (e) {
                                return fail(e as Error);
                            }
                            settled = true;
                            if (opts.tee) opts.tee.end(heldBack);
                            resolve(dest);
                        });
                    });
                });
                req.on('error', (e) => fail(e));
            };
            get(url, 0);
        });
    }
}

function sizeOf(file: string): number {
    try {
        return fs.statSync(file).size;
    } catch {
        return -1;
    }
}
