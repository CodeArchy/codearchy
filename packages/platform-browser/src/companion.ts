/**
 * The page side of the Companion: an EngineClient over a WebSocket to
 * `codearchy serve` on this machine. Pair once with the link it prints (the
 * token lives in the URL fragment, so it never reaches a server); keep the
 * session key to reconnect after a reload.
 */
import {
    COMPANION_PROTOCOL,
    type CompanionClientMessage,
    type CompanionMethod,
    type CompanionServerMessage,
    type EdgeExplanation,
    type EngineClient,
    type EngineEvent,
    type AuthorshipOrigin,
    type AuthorshipStatus,
    type Flow,
    type NodeAuthorship,
    type FlowSummary,
    type NodeDetails,
    type NodeSummary,
    type SearchResult,
    type Tour,
    type TourDetails,
    type TourSummary,
    type View,
    type ViewRequest,
    type WorkspaceSummary,
} from '@codearchy/protocol';

export interface CompanionTarget {
    /** 127.0.0.1 or localhost: a Companion only ever runs on this machine. */
    host: string;
    port: number;
}

/** `#pair=<token>@127.0.0.1:<port>` → the token and where to connect; undefined for anything else. */
export function parsePairing(hash: string): (CompanionTarget & { token: string }) | undefined {
    const m = /^#?pair=([A-Za-z0-9_-]{16,128})@(127\.0\.0\.1|localhost):(\d{1,5})$/.exec(hash.trim());
    if (!m) return undefined;
    const port = Number(m[3]);
    return port > 0 && port < 65536 ? { token: m[1]!, host: m[2]!, port } : undefined;
}

/** What a WebSocket implementation needs to offer (the browser's, or `ws` in tests). */
export type WebSocketLike = {
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: 'open', listener: () => void): void;
    addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
    addEventListener(type: 'close', listener: (ev: { code: number; reason: string }) => void): void;
    addEventListener(type: 'error', listener: () => void): void;
};
export type WebSocketFactory = (url: string) => WebSocketLike;

export class CompanionError extends Error {
    constructor(
        message: string,
        /** The close code (4401: the token or session was refused). */
        readonly code?: number
    ) {
        super(message);
    }
}

export interface CompanionConnection {
    engine: CompanionEngine;
    /** Keep it (sessionStorage) to reconnect without a new pairing link. */
    session: string;
    summary: WorkspaceSummary;
    version: string;
}

export class CompanionEngine implements EngineClient {
    private seq = 0;
    private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    private readonly listeners = new Set<(e: EngineEvent) => void>();
    private readonly closeListeners = new Set<(e: CompanionError) => void>();

    private constructor(private readonly ws: WebSocketLike) {}

    /** Pairs with a token, or resumes a session; resolves once the Companion is ready. */
    static connect(target: CompanionTarget, auth: { token: string } | { session: string }, factory: WebSocketFactory = (url) => new WebSocket(url) as unknown as WebSocketLike): Promise<CompanionConnection> {
        if (target.host !== '127.0.0.1' && target.host !== 'localhost') return Promise.reject(new CompanionError('A Companion runs on this machine only'));
        const ws = factory(`ws://${target.host}:${target.port}/`);
        const engine = new CompanionEngine(ws);
        return new Promise((resolve, reject) => {
            let ready = false;
            ws.addEventListener('open', () => {
                const hello: CompanionClientMessage = 'token' in auth ? { type: 'pair', protocol: COMPANION_PROTOCOL, token: auth.token } : { type: 'resume', protocol: COMPANION_PROTOCOL, session: auth.session };
                ws.send(JSON.stringify(hello));
            });
            ws.addEventListener('message', (ev) => {
                let m: CompanionServerMessage;
                try {
                    m = JSON.parse(String(ev.data)) as CompanionServerMessage;
                } catch {
                    return;
                }
                if (m.type === 'ready' && !ready) {
                    ready = true;
                    resolve({ engine, session: m.session, summary: m.summary, version: m.version });
                } else engine.receive(m);
            });
            ws.addEventListener('close', (ev) => {
                const err = new CompanionError(closeReason(ev.code, ev.reason), ev.code);
                if (!ready) reject(err);
                engine.closed(err);
            });
            ws.addEventListener('error', () => undefined); // a close event follows with the reason
        });
    }

    /** `changed` when files change (the Companion re-indexes and the views should refetch). */
    onEvent(listener: (e: EngineEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** The connection dropped (the Companion stopped, or the machine slept). */
    onClose(listener: (e: CompanionError) => void): () => void {
        this.closeListeners.add(listener);
        return () => this.closeListeners.delete(listener);
    }

    summary(): Promise<WorkspaceSummary> {
        return this.call('summary', {});
    }
    view(request: ViewRequest): Promise<View | undefined> {
        return this.call('view', { request });
    }
    children(key: string): Promise<NodeSummary[] | undefined> {
        return this.call('children', { key });
    }
    describe(key: string): Promise<NodeDetails | undefined> {
        return this.call('describe', { key });
    }
    explain(source: string, target: string): Promise<EdgeExplanation | undefined> {
        return this.call('explain', { source, target });
    }
    search(query: string): Promise<SearchResult[]> {
        return this.call('search', { query });
    }
    flows(): Promise<FlowSummary[]> {
        return this.call('flows', {});
    }
    flow(id: string): Promise<Flow | undefined> {
        return this.call('flow', { id });
    }
    tours(): Promise<TourSummary[]> {
        return this.call('tours', {});
    }
    tour(id: string): Promise<TourDetails | undefined> {
        return this.call('tour', { id });
    }
    anchorTour(tour: Tour): Promise<Tour> {
        return this.call('anchorTour', { tour });
    }
    authorshipStatus(): Promise<AuthorshipStatus> {
        return this.call('authorshipStatus', {});
    }
    authorship(key: string): Promise<NodeAuthorship | undefined> {
        return this.call('authorship', { key });
    }
    /** "Mark as reviewed" / "Correct attribution": kept in the Companion's ledger (outside the workspace). */
    authorshipMark(path: string, start: number, end: number, as: 'reviewed' | AuthorshipOrigin): Promise<{ marked: number }> {
        return this.call('authorshipMark', { path, start, end, as });
    }
    /** An indexed file's text (the code viewer). */
    readFile(path: string): Promise<string | undefined> {
        return this.call('readFile', { path });
    }

    dispose(): void {
        this.ws.close(1000, 'done');
    }

    private call<T>(method: CompanionMethod, params: Record<string, unknown>): Promise<T> {
        if (this.ws.readyState !== 1) return Promise.reject(new CompanionError('Not connected to the Companion'));
        const id = ++this.seq;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
            this.ws.send(JSON.stringify({ type: 'request', id, method, params } satisfies CompanionClientMessage));
        });
    }

    private receive(m: CompanionServerMessage): void {
        if (m.type === 'response') {
            const p = this.pending.get(m.id);
            if (!p) return;
            this.pending.delete(m.id);
            if (m.error !== undefined) p.reject(new CompanionError(m.error));
            else p.resolve(m.result);
        } else if (m.type === 'event') {
            for (const l of this.listeners) l(m.event);
        }
    }

    private closed(err: CompanionError): void {
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        for (const l of this.closeListeners) l(err);
    }
}

function closeReason(code: number, reason: string): string {
    switch (code) {
        case 4401:
            return 'The Companion refused the pairing (each link works once). Run `codearchy serve` again for a new link.';
        case 4400:
            return 'This Companion speaks a different protocol version. Update the CodeArchy CLI.';
        case 4408:
            return 'The Companion closed the connection before it was paired.';
        case 4429:
            return 'Too many requests to the Companion.';
        case 1006:
            return "Couldn't reach the Companion. Is `codearchy serve` still running?";
        default:
            return reason || `The connection to the Companion closed (${code}).`;
    }
}
