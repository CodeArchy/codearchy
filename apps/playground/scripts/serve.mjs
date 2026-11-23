/**
 * Static server for dist/. Sends NO COOP/COEP headers on purpose: the PWA runs
 * without cross-origin isolation, so the playground must too.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.map': 'application/json' };

/** Serves `dir` on 127.0.0.1; port 0 picks a free one. Resolves to the base URL. */
export async function serve(dir, port = 0) {
    const root = path.resolve(dir);
    const server = http.createServer((req, res) => {
        const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        const file = path.resolve(root, `.${url === '/' ? '/index.html' : url}`);
        if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
        fs.createReadStream(file).pipe(res);
    });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
}
