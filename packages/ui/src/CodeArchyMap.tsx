/**
 * The Map experience: Navigator · canvas · Inspector, with a breadcrumb and
 * ⌘K search. Owns the view state (scope, expanded nodes, selection, focus)
 * and asks the engine for projections through an EngineClient.
 *
 * Keyboard: Enter drill · Space expand/collapse · Backspace up a level ·
 * F focus (2-hop neighbourhood) · Esc clear · ⌘K / Ctrl+K search.
 *
 * Dense views draw their heaviest dependencies (plus everything around the
 * selection); "show all" draws every one. Layout uses the drawn set, so
 * selecting never moves anything; only the toggle re-lays out.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import type { EdgeExplanation, NodeDetails, View } from '@codearchy/protocol';
import type { EngineClient, HostActions, SearchResult } from './client.js';
import { LayoutEngine, type Layout } from './layout.js';
import { MapCanvas } from './MapCanvas.js';
import { buildMapModel, DEFAULT_EDGE_LIMIT, keyOfExternal, neighbourhood, visibleEdges } from './model.js';
import { Breadcrumb, Inspector, Navigator, SearchBox } from './panels.js';

export interface CodeArchyMapProps {
    client: EngineClient;
    host?: HostActions;
    /** URL of elkjs's `lib/elk-worker.min.js`. */
    layoutWorkerUrl: string;
    /** 'vscode' takes colours from the VS Code theme; 'web' follows light/dark. */
    hostKind?: 'web' | 'vscode';
    /** Changes when the workspace is re-indexed. */
    revision?: string;
}

type Selection = { kind: 'node'; key: string } | { kind: 'edge'; source: string; target: string } | undefined;

export function CodeArchyMap(props: CodeArchyMapProps) {
    const { client, host } = props;
    const revision = props.revision ?? '';
    const engine = useMemo(() => new LayoutEngine({ workerUrl: props.layoutWorkerUrl }), [props.layoutWorkerUrl]);
    useEffect(() => () => engine.dispose(), [engine]);

    const [scope, setScope] = useState('sys:root');
    const [expanded, setExpanded] = useState<string[]>([]);
    const [selection, setSelection] = useState<Selection>();
    const [focus, setFocus] = useState(false);
    const [allEdges, setAllEdges] = useState(false);
    const [view, setView] = useState<View>();
    const [layout, setLayout] = useState<Layout>();
    const [details, setDetails] = useState<NodeDetails>();
    const [explanation, setExplanation] = useState<EdgeExplanation>();
    const [searching, setSearching] = useState(false);
    const [status, setStatus] = useState('Loading…');
    const root = useRef<HTMLDivElement>(null);

    useEffect(() => {
        setScope('sys:root');
        setExpanded([]);
        setSelection(undefined);
    }, [revision]);

    // View + layout for the current scope and expansions.
    useEffect(() => {
        let live = true;
        setStatus('Loading…');
        void (async () => {
            const v = await client.view({ scope, expanded });
            if (!live || !v) return;
            const full = buildMapModel(v);
            // Lay out what is drawn by default (the heaviest edges): far tidier on
            // dense views. Selections add edges without moving anything; only the
            // "show all" toggle lays out again.
            const m = { ...full, edges: visibleEdges(full, { all: allEdges }) };
            const l = await engine.layout(`${v.frontierHash}${allEdges ? ':all' : ''}`, m);
            if (!live) return;
            setView(v);
            setLayout(l);
            setStatus('');
            if (v.scope !== scope) setScope(v.scope);
        })().catch((err: unknown) => live && setStatus(`Layout failed: ${err instanceof Error ? err.message : String(err)}`));
        return () => {
            live = false;
        };
    }, [client, engine, scope, expanded.join('\n'), revision, allEdges]); // eslint-disable-line react-hooks/exhaustive-deps

    const model = useMemo(() => (view ? buildMapModel(view) : undefined), [view]);

    // Inspector data for the selection.
    useEffect(() => {
        let live = true;
        setDetails(undefined);
        setExplanation(undefined);
        if (selection?.kind === 'node') {
            void client.describe(keyOfExternal(selection.key) ?? selection.key).then((d) => live && setDetails(d));
        } else if (selection?.kind === 'edge') {
            const s = keyOfExternal(selection.source) ?? selection.source;
            const t = keyOfExternal(selection.target) ?? selection.target;
            void client.explain(s, t).then((x) => live && setExplanation(x));
        }
        return () => {
            live = false;
        };
    }, [client, selection]);

    const lit = useMemo(() => {
        if (!model || selection?.kind !== 'node') return undefined;
        return neighbourhood(model, selection.key, focus ? 2 : 1);
    }, [model, selection, focus]);

    const drawn = useMemo(() => {
        if (!model) return [];
        const key = selection?.kind === 'node' ? selection.key : undefined;
        const around = key ? (focus ? neighbourhood(model, key, 1) : new Set([key])) : undefined;
        return visibleEdges(model, { all: allEdges, around });
    }, [model, allEdges, selection, focus]);

    const nameOf = useCallback(
        (key: string) => view?.nodes.find((n) => n.key === key)?.name ?? view?.ports.find((p) => p.external === key)?.externalName ?? key,
        [view]
    );

    const drill = useCallback((key: string) => {
        setScope(key);
        setExpanded([]);
        setSelection(undefined);
    }, []);
    const toggleExpand = useCallback((key: string) => {
        // Expansions nested under a collapsed node stay listed: the engine ignores
        // them while it's collapsed, and re-expanding restores what was open.
        setExpanded((e) => (e.includes(key) ? e.filter((k) => k !== key) : [...e, key]));
    }, []);
    const up = useCallback(() => {
        if (!view || view.breadcrumb.length < 2) return;
        const current = view.scope;
        drill(view.breadcrumb[view.breadcrumb.length - 2].key);
        setSelection({ kind: 'node', key: current });
    }, [view, drill]);

    /** Shows `key` on the canvas: its parent becomes the scope, and it is selected. */
    const reveal = useCallback(
        async (key: string) => {
            const d = await client.describe(key);
            if (!d) return;
            const parent = d.breadcrumb.length >= 2 ? d.breadcrumb[d.breadcrumb.length - 2].key : 'sys:root';
            setScope(parent);
            setExpanded([]);
            setSelection({ kind: 'node', key: d.key });
        },
        [client]
    );

    const activate = useCallback(
        (id: string) => {
            const external = keyOfExternal(id);
            if (external) return void reveal(external);
            const n = view?.nodes.find((x) => x.key === id);
            if (!n) return;
            if (n.expanded) return toggleExpand(id);
            if (n.hasChildren) drill(id);
            else if (n.kind === 'module') host?.openFile?.(n.path);
        },
        [view, reveal, toggleExpand, drill, host]
    );

    const onKeyDown = (e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            return setSearching(true);
        }
        const target = e.target as HTMLElement;
        if (target.closest('input, textarea, .ca-navigator')) return;
        const key = selection?.kind === 'node' ? selection.key : undefined;
        if (e.key === 'Backspace') return up();
        if (e.key === 'Escape') return setSelection(undefined);
        if ((e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey) return setFocus((f) => !f);
        if (e.key === 'Enter' && key) return activate(key);
        if (e.key === ' ' && key && !keyOfExternal(key)) {
            e.preventDefault();
            const n = view?.nodes.find((x) => x.key === key);
            if (n?.hasChildren || n?.expanded) toggleExpand(key);
        }
    };

    const pick = (r: SearchResult) => {
        setSearching(false);
        void reveal(r.key);
        root.current?.focus();
    };

    const selectedKey = selection?.kind === 'node' ? selection.key : undefined;
    return (
        <div ref={root} className="ca-root" data-host={props.hostKind ?? 'web'} tabIndex={-1} onKeyDown={onKeyDown}>
            <header className="ca-toolbar">
                {view ? <Breadcrumb items={view.breadcrumb} onGo={drill} /> : <span />}
                <span className="ca-toolbar-gap" />
                {focus ? <span className="ca-chip" title="F toggles focus">Focus: 2 hops</span> : null}
                {view?.skipped.length ? <span className="ca-muted">{view.skipped.length} expansion(s) over budget</span> : null}
                {model && model.edges.length > DEFAULT_EDGE_LIMIT ? (
                    <span className="ca-muted ca-edge-count">
                        {allEdges ? `all ${model.edges.length} dependencies` : `heaviest ${DEFAULT_EDGE_LIMIT} of ${model.edges.length} dependencies`}
                        {' · '}
                        <button type="button" className="ca-link" onClick={() => setAllEdges((a) => !a)}>
                            {allEdges ? 'show fewer' : 'show all'}
                        </button>
                    </span>
                ) : null}
                {client.search ? (
                    <button type="button" className="ca-search-button" onClick={() => setSearching(true)}>
                        Search <kbd>⌘K</kbd>
                    </button>
                ) : null}
            </header>
            <div className="ca-body">
                <Navigator client={client} revision={revision} path={view?.breadcrumb.map((b) => b.key) ?? []} selected={selectedKey} onReveal={(k) => void reveal(k)} onDrill={drill} />
                <section className="ca-canvas" aria-label="Architecture map">
                    {model && layout && view ? (
                        <ReactFlowProvider>
                            <MapCanvas
                                model={model}
                                edges={drawn}
                                layout={layout}
                                frontierHash={view.frontierHash}
                                selected={selectedKey}
                                selectedEdge={selection?.kind === 'edge' ? `${selection.source}->${selection.target}` : undefined}
                                lit={lit}
                                onSelect={(id) => setSelection(id ? { kind: 'node', key: id } : undefined)}
                                onActivate={activate}
                                onExpand={toggleExpand}
                                onCollapse={toggleExpand}
                                onSelectEdge={(source, target) => setSelection({ kind: 'edge', source, target })}
                            />
                        </ReactFlowProvider>
                    ) : null}
                    {status ? <div className="ca-status">{status}</div> : null}
                    {view && view.nodes.length === 0 ? <div className="ca-status">Nothing to show here.</div> : null}
                </section>
                <aside className="ca-side">
                    <Inspector
                        details={details}
                        explanation={explanation}
                        nameOf={nameOf}
                        host={host}
                        expanded={!!selectedKey && expanded.includes(selectedKey)}
                        onReveal={(k) => void reveal(k)}
                        onDrill={drill}
                        onToggleExpand={toggleExpand}
                    />
                </aside>
            </div>
            {searching && client.search ? <SearchBox client={client} onPick={pick} onClose={() => setSearching(false)} /> : null}
        </div>
    );
}
