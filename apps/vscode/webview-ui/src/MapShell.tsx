/**
 * The 2.0 panel: @codearchy/ui's CodeArchyMap, talking to the engine in the
 * extension host over postMessage, plus the existing chat and the AI model /
 * voice settings. The classic views (App.tsx) remain behind the
 * `codearchy.ui` setting during the 2.0 beta.
 */
import { useEffect, useRef, useState } from 'react';
import { CodeArchyMap, type EngineClient } from '@codearchy/ui';
import type { EdgeExplanation, NodeDetails, NodeSummary, View, ViewRequest } from '@codearchy/protocol';
import '@codearchy/ui/styles.css';
import './mapShell.css';
import { postMessage } from './vscode';
import { ChatPanel } from './components/ChatPanel';
import { ModelSelector } from './components/ModelSelector';
import { VoiceSelector } from './components/VoiceSelector';

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
    search: (query: string) => request('search', { query }),
};

const host = {
    openFile: (path: string, line?: number) => postMessage('openWorkspaceFile', { path, line }),
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
    const [chatOpen, setChatOpen] = useState(false);
    const [dialog, setDialog] = useState<'model' | 'voice'>();

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
            <button type="button" className="ca-search-button" title="Chat with the AI architect" aria-pressed={chatOpen} onClick={() => setChatOpen((v) => !v)}>
                Chat
            </button>
            <button type="button" className="ca-search-button" title="AI model settings" onClick={() => setDialog('model')}>
                AI model
            </button>
            <button type="button" className="ca-search-button" title="Voice and speech settings" onClick={() => setDialog('voice')}>
                Voice
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
                />
            )}
            <ChatPanel isOpen={chatOpen} onToggle={() => setChatOpen((v) => !v)} />
            {dialog === 'model' ? <ModelSelector onClose={() => setDialog(undefined)} /> : null}
            {dialog === 'voice' ? <VoiceSelector onClose={() => setDialog(undefined)} /> : null}
        </div>
    );
}
