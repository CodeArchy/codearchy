/**
 * The 2.0 panel: @codearchy/ui's CodeArchyMap, talking to the engine and the
 * AI host in the extension host over postMessage. Chat, summary cards and AI
 * settings come from the shared UI (the `ai` client); local model downloads
 * and voice keep their v1 dialogs; tours narrate through the same voice. The classic views (App.tsx) remain behind
 * the `codearchy.ui` setting during the 2.0 beta.
 */
import { useEffect, useRef, useState } from 'react';
import { CodeArchyMap, type EngineClient } from '@codearchy/ui';
import type { AiClient, AiHostEvent, ChatEvent, EdgeExplanation, Flow, FlowSummary, NodeDetails, NodeSummary, AuthorshipStatus, NodeAuthorship, Tour, TourDetails, TourSummary, View, ViewRequest } from '@codearchy/protocol';
import '@codearchy/ui/styles.css';
import './mapShell.css';
import { postMessage } from './vscode';
import { ModelSelector } from './components/ModelSelector';
import { VoiceSelector } from './components/VoiceSelector';
import { vscodeVoiceClient } from './voice/voiceClient';

declare global {
    interface Window {
        CODEARCHY_ELK_WORKER_URI?: string;
    }
}

// ─── engine requests over postMessage ───────────────────────────────────────

const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
let nextId = 1;

window.addEventListener('message', (ev: MessageEvent) => {
    const msg = ev.data as { type?: string; payload?: { id: number; result?: unknown; error?: string } };
    if (msg?.type !== 'engineResponse' || !msg.payload) return;
    const p = pending.get(msg.payload.id);
    pending.delete(msg.payload.id);
    if (msg.payload.error) p?.reject(new Error(msg.payload.error));
    else p?.resolve(msg.payload.result);
});

function request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        postMessage('engineRequest', { id, method, params });
    });
}

const client: EngineClient = {
    view: (req: ViewRequest) => request<View | undefined>('view', { request: req }),
    children: (key: string) => request<NodeSummary[] | undefined>('children', { key }),
    describe: (key: string) => request<NodeDetails | undefined>('describe', { key }),
    explain: (source: string, target: string) => request<EdgeExplanation | undefined>('explain', { source, target }),
    flows: () => request<FlowSummary[]>('flows', {}),
    flow: (id: string) => request<Flow | undefined>('flow', { id }),
    tours: () => request<TourSummary[]>('tours', {}),
    tour: (id: string) => request<TourDetails | undefined>('tour', { id }),
    anchorTour: (tour: Tour) => request<Tour>('anchorTour', { tour }),
    saveTour: (tour: Tour) => request<{ file: string }>('saveTour', { tour }),
    deleteTour: (id: string) => request<void>('deleteTour', { id }),
    authorshipStatus: () => request<AuthorshipStatus>('authorshipStatus', {}),
    authorship: (key: string) => request<NodeAuthorship | undefined>('authorship', { key }),
    search: (query: string) => request('search', { query }),
};

const host = {
    openFile: (path: string, line?: number) => postMessage('openWorkspaceFile', { path, line }),
};

// ─── AI host requests, chat streams and events over postMessage ─────────────

const aiPending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
const aiChats = new Map<string, (e: ChatEvent) => void>();
const aiListeners = new Set<(e: AiHostEvent) => void>();

window.addEventListener('message', (ev: MessageEvent) => {
    const msg = ev.data as { type?: string; payload?: Record<string, unknown> };
    // Handlers are looked up by ids from the message: only our own ids, and only functions, get called.
    if (msg?.type === 'aiResponse' && msg.payload) {
        const { id, result, error } = msg.payload as { id: unknown; result?: unknown; error?: unknown };
        if (typeof id !== 'number') return;
        const p = aiPending.get(id);
        aiPending.delete(id);
        if (!p) return;
        if (typeof error === 'string') p.reject(new Error(error));
        else p.resolve(result);
    } else if (msg?.type === 'aiChatEvent' && msg.payload) {
        const { conversation, event } = msg.payload as { conversation: unknown; event: ChatEvent };
        if (typeof conversation !== 'string' || !aiChats.has(conversation)) return;
        const handler = aiChats.get(conversation);
        if (typeof handler === 'function') handler(event);
    } else if (msg?.type === 'aiEvent' && msg.payload) {
        const event = (msg.payload as { event: AiHostEvent }).event;
        for (const l of aiListeners) l(event);
    }
});

function aiRequest<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
        aiPending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        postMessage('aiRequest', { id, method, params });
    });
}

const ai: AiClient = {
    state: () => aiRequest('state'),
    refresh: () => aiRequest('refresh'),
    updateSettings: (patch) => aiRequest('updateSettings', { patch }),
    setKey: (provider, key) => aiRequest('setKey', { provider, key }),
    card: (key, options) => aiRequest('card', { key, generate: options?.generate === true }),
    ask: (conversation, question, options, onEvent) =>
        new Promise<void>((resolve) => {
            aiChats.set(conversation, (e) => {
                onEvent(e);
                if (e.type === 'done' || e.type === 'error') {
                    aiChats.delete(conversation);
                    resolve();
                }
            });
            postMessage('aiAsk', { conversation, question, selection: options.selection });
        }),
    cancel: (conversation) => void aiRequest('cancel', { conversation }),
    reset: (conversation) => void aiRequest('reset', { conversation }),
    answerPreview: (id, send) => void aiRequest('answerPreview', { id, send }),
    subscribe: (listener) => {
        aiListeners.add(listener);
        return () => aiListeners.delete(listener);
    },
    audit: () => aiRequest('audit'),
};

/** VS Code blocks `new Worker(vscode-resource:…)`: load ELK's worker as a blob: URL. */
async function elkWorkerBlobUrl(): Promise<string> {
    const uri = window.CODEARCHY_ELK_WORKER_URI;
    if (!uri) throw new Error('ELK worker URI not injected by the extension host');
    const res = await fetch(uri);
    if (!res.ok) throw new Error(`ELK worker fetch failed: HTTP ${res.status}`);
    return URL.createObjectURL(await res.blob());
}

// ─── shell ──────────────────────────────────────────────────────────────────

export function MapShell() {
    const [workerUrl, setWorkerUrl] = useState<string>();
    const [failure, setFailure] = useState<string>();
    const [revision, setRevision] = useState<string>();
    const revisionRef = useRef<string>();
    const [dataVersion, setDataVersion] = useState(0);
    const [reveal, setReveal] = useState<{ key: string; nonce: number }>();
    const [dialog, setDialog] = useState<'model' | 'voice'>();
    const [voice] = useState(() => vscodeVoiceClient(() => setDialog('voice')));

    useEffect(() => {
        let url: string | undefined;
        elkWorkerBlobUrl()
            .then((u) => setWorkerUrl((url = u)))
            .catch((err: Error) => setFailure(err.message));
        return () => {
            if (url) URL.revokeObjectURL(url);
        };
    }, []);

    useEffect(() => {
        const onMessage = (ev: MessageEvent) => {
            const msg = ev.data as { type?: string; payload?: unknown };
            if (msg?.type === 'graphData') {
                // Another workspace resets the Map; the same one refreshes it in place.
                const project = String((msg.payload as { metadata?: { projectId?: string } })?.metadata?.projectId ?? '');
                if (revisionRef.current === project) setDataVersion((v) => v + 1);
                revisionRef.current = project;
                setRevision(project);
            } else if (msg?.type === 'revealNode') {
                const key = (msg.payload as { key?: string })?.key;
                if (key) setReveal({ key, nonce: Date.now() });
            }
        };
        window.addEventListener('message', onMessage);
        postMessage('ready');
        return () => window.removeEventListener('message', onMessage);
    }, []);

    const extras = (
        <>
            <button type="button" className="ca-search-button" title="Download and manage local Ollama models" onClick={() => setDialog('model')}>
                Local models
            </button>
            <button type="button" className="ca-search-button" title="Switch to the classic System / Flow / Dense views (setting: codearchy.ui)" onClick={() => postMessage('setUi', { ui: 'classic' })}>
                Classic views
            </button>
        </>
    );

    return (
        <div className="map-shell">
            {failure ? (
                <div className="loading">The Map could not start: {failure}</div>
            ) : revision === undefined || !workerUrl ? (
                <div className="loading">
                    <div className="spinner" />
                    Waiting for analysis data...
                </div>
            ) : (
                <CodeArchyMap
                    client={client}
                    host={host}
                    layoutWorkerUrl={workerUrl}
                    hostKind="vscode"
                    revision={revision}
                    dataVersion={dataVersion}
                    revealRequest={reveal}
                    toolbarExtras={extras}
                    ai={ai}
                    voice={voice}
                />
            )}
            {dialog === 'model' ? <ModelSelector onClose={() => setDialog(undefined)} /> : null}
            {dialog === 'voice' ? <VoiceSelector onClose={() => setDialog(undefined)} /> : null}
        </div>
    );
}
