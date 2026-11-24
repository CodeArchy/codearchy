/**
 * The Companion: `codearchy serve` runs the native engine and serves it to the
 * web app over a WebSocket (protocol in @codearchy/protocol's companion.ts).
 *
 * Security (doc 11 §4):
 *   - bound to 127.0.0.1 only;
 *   - the upgrade must come from an allowed Origin (the app, localhost dev
 *     servers, and origins added with --allow-origin) and name this server in
 *     its Host header (DNS rebinding);
 *   - the first frame authenticates: the one-time pairing token (single use,
 *     compared in constant time) or a session key an earlier pairing issued;
 *   - read-only: requests are a fixed allow-list, and only indexed source files
 *     and tour files can be read;
 *   - frames are capped in size and rate.
 */
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { HierarchyIndex } from '@codearchy/core';
import {
    COMPANION_CLOSE,
    COMPANION_METHODS,
    COMPANION_PROTOCOL,
    type CompanionClientMessage,
    type CompanionMethod,
    type CompanionServerMessage,
    type SearchResult,
    type Tour,
    type WorkspaceSummary,
} from '@codearchy/protocol';
import { anchorTour } from '@codearchy/core';
import type { Snapshot, Workspace } from './workspace.js';

export const APP_ORIGIN = 'https://app.codearchy.com';
const MAX_FRAME = 1 << 20;
const AUTH_TIMEOUT_MS = 10_000;
/** Requests per second, with a burst allowance. */
const RATE = 60;
const BURST = 200;

export interface CompanionOptions {
    /** 0 picks a free port. */
    port?: number;
    /** Exact origins allowed besides the app and localhost dev servers. */
    allowOrigins?: string[];
    version: string;
    log?: (message: string) => void;
    /** Tests only: a known token. */
    token?: string;
    /** The app to pair with (default https://app.codearchy.com). */
    appUrl?: string;
}

export interface Companion {
    port: number;
    /** Open this to pair (it carries the one-time token in the fragment, which never reaches a server). */
    pairingUrl: string;
    /** A workspace file changed: rebuild shortly, then tell connected pages (wire it to Workspace's onChange). */
    notify(file?: string): void;
    close(): Promise<void>;
}

/** The app itself, and dev servers on this machine. */
export function originAllowed(origin: string | undefined, extra: string[] = []): boolean {
    if (!origin) return false;
    let u: URL;
    try {
        u = new URL(origin);
    } catch {
        return false;
    }
    if (u.origin === APP_ORIGIN || extra.includes(u.origin)) return true;
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]');
}

export async function startCompanion(workspace: Workspace, options: CompanionOptions): Promise<Companion> {
    const log = options.log ?? (() => undefined);
    const extra = (options.allowOrigins ?? []).map((o) => {
        try {
            return new URL(o).origin;
        } catch {
            throw new Error(`--allow-origin: "${o}" is not a URL`);
        }
    });
    let token: string | undefined = options.token ?? randomBytes(24).toString('base64url');
    const sessions = new Set<string>();
    const clients = new Set<WebSocket>();

    const http: Server = createHttpServer((_req, res) => {
        // Plain HTTP gets nothing useful: no workspace details without pairing.
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
        res.end('CodeArchy Companion. Open the pairing link it printed to connect.\n');
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });

    await new Promise<void>((resolve, reject) => {
        http.once('error', reject);
        http.listen(options.port ?? 0, '127.0.0.1', () => resolve());
    });
    const port = (http.address() as { port: number }).port;
    const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

    http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const origin = req.headers.origin;
        if (!hosts.has(String(req.headers.host ?? '')) || !originAllowed(origin, extra)) {
            log(`Refused a connection from ${origin ?? 'no origin'} (host ${req.headers.host ?? '?'}).`);
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => serve(ws, String(origin)));
    });

    const send = (ws: WebSocket, m: CompanionServerMessage) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));

    function serve(ws: WebSocket, origin: string): void {
        let authed = false;
        let tokens = BURST;
        let last = Date.now();
        const timer = setTimeout(() => ws.close(COMPANION_CLOSE.authTimeout, 'authenticate first'), AUTH_TIMEOUT_MS);
        ws.on('close', () => {
            clearTimeout(timer);
            clients.delete(ws);
        });
        ws.on('error', () => undefined);
        ws.on('message', (data, isBinary) => {
            if (isBinary) return ws.close(1003, 'text frames only');
            let msg: CompanionClientMessage;
            try {
                msg = JSON.parse(data.toString()) as CompanionClientMessage;
            } catch {
                return ws.close(1007, 'not JSON');
            }
            if (!authed) {
                if ((msg.type !== 'pair' && msg.type !== 'resume') || msg.protocol !== COMPANION_PROTOCOL) return ws.close(COMPANION_CLOSE.protocol, 'unsupported protocol');
                let session: string | undefined;
                if (msg.type === 'pair' && token && typeof msg.token === 'string' && sameSecret(msg.token, token)) {
                    token = undefined; // one-time
                    session = randomBytes(32).toString('base64url');
                    sessions.add(session);
                    log(`Paired with ${origin}.`);
                } else if (msg.type === 'resume' && typeof msg.session === 'string' && [...sessions].some((s) => sameSecret(msg.session, s))) {
                    session = msg.session;
                }
                if (!session) return ws.close(COMPANION_CLOSE.unauthorized, 'pairing failed');
                authed = true;
                clearTimeout(timer);
                clients.add(ws);
                const s = session;
                void workspace.snapshot().then(
                    (snap) => send(ws, { type: 'ready', protocol: COMPANION_PROTOCOL, session: s, summary: summaryOf(workspace, snap), version: options.version }),
                    (err: unknown) => ws.close(1011, err instanceof Error ? err.message.slice(0, 100) : 'indexing failed')
                );
                return;
            }
            // Token bucket: RATE per second, BURST at most.
            const now = Date.now();
            tokens = Math.min(BURST, tokens + ((now - last) / 1000) * RATE);
            last = now;
            if (tokens < 1) return ws.close(COMPANION_CLOSE.rateLimited, 'too many requests');
            tokens -= 1;
            if (msg.type !== 'request' || !Number.isInteger(msg.id)) return;
            void handle(msg.method, msg.params ?? {}).then(
                (result) => send(ws, { type: 'response', id: msg.id, result }),
                (err: unknown) => send(ws, { type: 'response', id: msg.id, error: err instanceof Error ? err.message : String(err) })
            );
        });
    }

    async function handle(method: CompanionMethod, params: Record<string, unknown>): Promise<unknown> {
        if (!(COMPANION_METHODS as readonly string[]).includes(method)) throw new Error(`Unknown request "${String(method).slice(0, 40)}"`);
        const snap = await workspace.snapshot();
        const h = snap.index;
        const str = (k: string) => String(params[k] ?? '');
        switch (method) {
            case 'summary':
                return summaryOf(workspace, snap);
            case 'view': {
                const v = h.project((params.request ?? {}) as Parameters<HierarchyIndex['project']>[0]);
                return snap.authorship ? snap.authorship.decorate(v) : v;
            }
            case 'children':
                return h.children(str('key'));
            case 'describe':
                return h.describe(str('key'));
            case 'explain':
                return h.explainEdge(str('source'), str('target'));
            case 'search':
                return search(h, str('query'));
            case 'flows':
                return snap.flows.list();
            case 'flow':
                return snap.flows.trace(str('id'));
            case 'tours':
                return snap.tours.list();
            case 'tour':
                return snap.tours.get(str('id'));
            case 'anchorTour':
                return anchorTour(params.tour as Tour, h, (p) => readIndexed(snap, p));
            case 'readFile':
                return readIndexed(snap, str('path'));
            case 'authorshipStatus':
                return snap.authorship?.status() ?? snap.authorshipStatus;
            case 'authorship':
                return snap.authorship?.describe(str('key'));
        }
    }

    /** Only what the UI shows: indexed source files and tour files, never anything else on disk. */
    function readIndexed(snap: Snapshot, p: string): Promise<string | undefined> {
        if (!snap.index.node(`mod:${p}`) && !snap.tourFiles.includes(p)) return Promise.resolve(undefined);
        return workspace.readFile(p);
    }

    // Live updates: rebuild shortly after the last change, then tell every client.
    let debounce: NodeJS.Timeout | undefined;
    const changed = new Set<string>();
    const notify = (file?: string) => {
        if (file) changed.add(file.split('\\').join('/'));
        clearTimeout(debounce);
        debounce = setTimeout(() => {
            const paths = [...changed];
            changed.clear();
            if (!clients.size) return;
            void workspace.snapshot().then((snap) => {
                const event: CompanionServerMessage = { type: 'event', event: { type: 'changed', paths, summary: summaryOf(workspace, snap) } };
                for (const ws of clients) send(ws, event);
            }, () => undefined);
        }, 400);
    };

    const app = options.appUrl ?? APP_ORIGIN;
    return {
        port,
        pairingUrl: `${app}/#pair=${token}@127.0.0.1:${port}`,
        notify,
        async close() {
            clearTimeout(debounce);
            for (const ws of clients) ws.close(1001, 'shutting down');
            wss.close();
            await new Promise<void>((resolve) => http.close(() => resolve()));
        },
    };
}

function sameSecret(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
}

function summaryOf(workspace: Workspace, snap: Snapshot): WorkspaceSummary {
    return {
        name: workspace.root.split(/[\\/]/).filter(Boolean).pop() ?? workspace.root,
        storage: 'native',
        files: snap.files,
        symbols: snap.symbols,
        edges: snap.edges,
        discovered: snap.files,
        parsed: snap.files,
        reused: 0,
        durationMs: snap.buildMs,
        workers: 0,
        languages: snap.languageCounts,
        live: true,
    };
}

/** Parts by name, then files and symbols by name (prefix first). */
function search(h: HierarchyIndex, query: string): SearchResult[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const parts: SearchResult[] = [];
    const prefix: SearchResult[] = [];
    const contains: SearchResult[] = [];
    for (const n of h.hierarchy.nodes) {
        const name = n.name.toLowerCase();
        if (n.kind === 'system' || !name.includes(q)) continue;
        if (n.kind === 'symbol') {
            const hit: SearchResult = { key: `mod:${n.path}`, name: n.name, kind: n.symbolKind ?? 'symbol', path: n.path, ...(n.startLine !== undefined ? { line: n.startLine } : {}) };
            (name.startsWith(q) ? prefix : contains).push(hit);
        } else if (parts.length < 15) {
            parts.push({ key: n.key, name: n.name, kind: n.kind === 'module' ? 'file' : n.kind, path: n.path });
        }
        if (prefix.length >= 35) break;
    }
    return [...parts, ...prefix, ...contains].slice(0, 50);
}
