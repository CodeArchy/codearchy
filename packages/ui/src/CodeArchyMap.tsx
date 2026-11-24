/**
 * The Map experience: Navigator · canvas · Inspector, with a breadcrumb and
 * ⌘K search. Owns the view state (scope, expanded nodes, selection, focus)
 * and asks the engine for projections through an EngineClient.
 *
 * Modes: Map (node-link) or Matrix (DSM); lenses colour both by Health or
 * Tests, always with the value as text too. Flows (when the engine has them)
 * lists the entrypoints and traces what each one does across the parts.
 * Tours (when the engine has them) lists guided walks; playing one docks a
 * player over the canvas, and each step moves the canvas to what it explains.
 *
 * One canvas: double-click, Enter or Space expands a node in place (and
 * collapses it again); "Show only this" / Shift+Enter opens it as its own
 * view. Reveals (search, Navigator, editor) expand the path in place.
 *
 * Keyboard: Enter / Space expand · Shift+Enter open on its own · Backspace up a level ·
 * F focus (2-hop neighbourhood) · Esc clear · ⌘K / Ctrl+K search.
 *
 * Dense views draw their heaviest dependencies (plus everything around the
 * selection); "show all" draws every one. Layout uses the drawn set, so
 * selecting never moves anything; only the toggle re-lays out.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import type { AiClient, EdgeExplanation, Flow, NodeDetails, Tour, TourDetails, TourStep, View } from '@codearchy/protocol';
import { AiSettingsPanel, ChatPanel, PreviewDialog } from './ai.js';
import { Icon } from './icons.js';
import type { EngineClient, HostActions, SearchResult } from './client.js';
import { LayoutEngine, type Layout } from './layout.js';
import { MapCanvas, type FocusRequest } from './MapCanvas.js';
import { buildMapModel, DEFAULT_EDGE_LIMIT, flowRoles, keyOfExternal, LENSES, revealPlan, visibleEdges, type LensId } from './model.js';
import { Matrix } from './Matrix.js';
import { FlowsView } from './Flows.js';
import { AddToTourDialog, ToursList, TourPlayer } from './Tours.js';
import { addToDraft, loadDraft, loadProgress, removeFromDraft, saveDraft, saveProgress, stepView, tourFromFlow, type StepCapture } from './tourModel.js';
import { flowRows } from './flowModel.js';
import { Breadcrumb, Inspector, Navigator, SearchBox } from './panels.js';

export interface CodeArchyMapProps {
    client: EngineClient;
    host?: HostActions;
    /** URL of elkjs's `lib/elk-worker.min.js`. */
    layoutWorkerUrl: string;
    /** 'vscode' takes colours from the VS Code theme; 'web' follows light/dark. */
    hostKind?: 'web' | 'vscode';
    /** Changes when a different workspace is loaded: the view resets to the top. */
    revision?: string;
    /** Changes when the same workspace's data changes (a file saved): the current view refetches in place. */
    dataVersion?: number;
    /** Ask the Map to show a node (e.g. "Reveal in Map" from the editor); a new `nonce` repeats it. */
    revealRequest?: { key: string; nonce: number };
    /** Host controls added to the toolbar (settings, chat, switch views…). */
    toolbarExtras?: ReactNode;
    /** Host content at the toolbar's start (e.g. the app's brand). */
    toolbarStart?: ReactNode;
    /** The host's AI side. With it, the Map gets chat, summary cards and AI settings. */
    ai?: AiClient;
}

type Selection = { kind: 'node'; key: string } | { kind: 'edge'; source: string; target: string } | undefined;
type Mode = 'map' | 'matrix' | 'flows' | 'tours';
const MODE_LABEL: Record<Mode, string> = { map: 'Map', matrix: 'Matrix', flows: 'Flows', tours: 'Tours' };

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
    const [mode, setMode] = useState<Mode>('map');
    /** The tour being played, and its step. */
    const [playing, setPlaying] = useState<{ tour: TourDetails; index: number }>();
    const [done, setDone] = useState<Set<string>>(new Set());
    const workspaceId = props.revision || 'workspace';
    const [draft, setDraftState] = useState<Tour | undefined>(() => loadDraft(workspaceId));
    const [capture, setCapture] = useState<StepCapture>();
    /** Ask Flows mode to show a flow (a tour step, or a reveal); a new `nonce` repeats it. */
    const [flowFocus, setFlowFocus] = useState<{ id: string; nonce: number }>();
    const [lens, setLens] = useState<LensId>('dependencies');
    const [view, setView] = useState<View>();
    const [layout, setLayout] = useState<Layout>();
    const [details, setDetails] = useState<NodeDetails>();
    const [explanation, setExplanation] = useState<EdgeExplanation>();
    const [searching, setSearching] = useState(false);
    const [status, setStatus] = useState('Loading…');
    const [sideTab, setSideTab] = useState<'inspector' | 'chat'>('inspector');
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [chatPrompt, setChatPrompt] = useState<{ text: string; nonce: number }>();
    /** Where the viewport goes after the next transition (a node, or the whole map). */
    const [focusOn, setFocusOn] = useState<FocusRequest>({ nonce: 1 });
    const nonce = useRef(1);
    const focusTo = useCallback((key?: string) => setFocusOn({ ...(key ? { key } : {}), nonce: ++nonce.current }), []);
    /** A reveal waiting for its view: if an ancestor didn't fit the budget, open its parent instead. */
    const revealing = useRef<{ key: string; path: string[] } | undefined>(undefined);
    const root = useRef<HTMLDivElement>(null);

    useEffect(() => {
        setScope('sys:root');
        setExpanded([]);
        setSelection(undefined);
        focusTo();
    }, [revision]); // eslint-disable-line react-hooks/exhaustive-deps

    // View + layout for the current scope and expansions.
    useEffect(() => {
        let live = true;
        // Only a slow view shows the pill: a quick expansion just animates.
        const slow = setTimeout(() => live && setStatus('Loading…'), 250);
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
            clearTimeout(slow);
            setView(v);
            setLayout(l);
            setStatus('');
            if (v.scope !== scope) setScope(v.scope);
            // A reveal whose path didn't fit the node budget: show the node in its parent's own view.
            const r = revealing.current;
            if (r) {
                revealing.current = undefined;
                if (!v.nodes.some((n) => n.key === r.key) && r.path.length >= 2) {
                    setScope(r.path[r.path.length - 2]);
                    setExpanded([]);
                    focusTo(r.key);
                }
            }
        })().catch((err: unknown) => live && setStatus(`Layout failed: ${err instanceof Error ? err.message : String(err)}`));
        return () => {
            live = false;
            clearTimeout(slow);
        };
    }, [client, engine, scope, expanded.join('\n'), revision, allEdges, props.dataVersion]); // eslint-disable-line react-hooks/exhaustive-deps

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
    }, [client, selection, props.dataVersion]);

    /** "Uses N · used by M" for the legend while something is selected. */
    const flow = useMemo(() => (model && selection?.kind === 'node' ? flowRoles(model, selection.key, 1) : undefined), [model, selection]);

    const drawn = useMemo(() => {
        if (!model) return [];
        const key = selection?.kind === 'node' ? selection.key : undefined;
        // The selection's own edges always draw (for an expanded node: everything inside it).
        const roles = key ? flowRoles(model, key, 1) : undefined;
        const around = roles ? (focus ? roles.lit : roles.selected) : undefined;
        return visibleEdges(model, { all: allEdges, around });
    }, [model, allEdges, selection, focus]);

    const nameOf = useCallback(
        (key: string) => view?.nodes.find((n) => n.key === key)?.name ?? view?.ports.find((p) => p.external === key)?.externalName ?? key,
        [view]
    );

    /** Opens a node as its own view (a new canvas); the Map otherwise expands in place. */
    const drill = useCallback(
        (key: string) => {
            setScope(key);
            setExpanded([]);
            setSelection(undefined);
            focusTo();
        },
        [focusTo]
    );
    /**
     * Expands or collapses a node in place, on the same canvas. Expanding glides
     * to the opened node; collapsing steps back to the whole map.
     */
    const toggleExpand = useCallback(
        (key: string) => {
            const collapsing = expanded.includes(key);
            // Expansions nested under a collapsed node stay listed: the engine ignores
            // them while it's collapsed, and re-expanding restores what was open.
            setExpanded((e) => (e.includes(key) ? e.filter((k) => k !== key) : [...e, key]));
            setSelection({ kind: 'node', key });
            focusTo(collapsing ? undefined : key);
        },
        [expanded, focusTo]
    );
    const up = useCallback(() => {
        if (!view || view.breadcrumb.length < 2) return;
        const current = view.scope;
        drill(view.breadcrumb[view.breadcrumb.length - 2].key);
        setSelection({ kind: 'node', key: current });
    }, [view, drill]);

    /**
     * Shows `key` on the same canvas: its ancestors are expanded in place, it is
     * selected and the view glides to it. A file's symbol reveals its file.
     */
    const reveal = useCallback(
        async (key: string) => {
            const d = await client.describe(key);
            if (!d) return;
            const path = d.breadcrumb.map((b) => b.key);
            const plan = revealPlan(path, scope, expanded);
            revealing.current = { key: d.key, path };
            setScope(plan.scope);
            setExpanded(plan.expanded);
            setSelection({ kind: 'node', key: d.key });
            focusTo(d.key);
        },
        [client, scope, expanded, focusTo]
    );

    useEffect(() => {
        if (props.revealRequest) void reveal(props.revealRequest.key);
    }, [props.revealRequest?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

    // ── tours ───────────────────────────────────────────────────────────────

    const setDraft = useCallback(
        (d: Tour | undefined) => {
            setDraftState(d);
            saveDraft(workspaceId, d);
        },
        [workspaceId]
    );
    useEffect(() => {
        setDraftState(loadDraft(workspaceId));
        setPlaying(undefined);
    }, [workspaceId]);

    /** Moves the canvas to what a step explains. */
    const applyStep = useCallback(
        (step: TourStep) => {
            const v = stepView(step);
            if (v.lens && LENSES.some((l) => l.id === v.lens)) setLens(v.lens as LensId);
            if (v.mode === 'flows') {
                setMode('flows');
                if (v.flow) setFlowFocus({ id: v.flow, nonce: ++nonce.current });
                if (v.node) setSelection({ kind: 'node', key: v.node });
                return;
            }
            setMode(v.mode);
            if (!v.node || v.node === 'sys:root') {
                setScope(v.scope ?? 'sys:root');
                setExpanded([]);
                setSelection(v.node ? { kind: 'node', key: v.node } : undefined);
                focusTo();
            } else void reveal(v.node);
        },
        [reveal, focusTo]
    );
    useEffect(() => {
        const step = playing?.tour.steps[playing.index];
        if (step) applyStep(step);
    }, [playing?.tour, playing?.index]); // eslint-disable-line react-hooks/exhaustive-deps

    const play = useCallback(
        (tour: TourDetails, startAt = 0) => {
            setDone(loadProgress(workspaceId, tour.id));
            setPlaying({ tour, index: Math.min(Math.max(0, startAt), tour.steps.length - 1) });
        },
        [workspaceId]
    );
    const markDone = useCallback(
        (stepId: string, value?: boolean) => {
            if (!playing) return;
            setDone((prev) => {
                const next = new Set(prev);
                if (value ?? !next.has(stepId)) next.add(stepId);
                else next.delete(stepId);
                saveProgress(workspaceId, playing.tour.id, next);
                return next;
            });
        },
        [playing, workspaceId]
    );
    const goToStep = useCallback(
        (index: number) => {
            if (!playing) return;
            // Moving on counts the step you were on as done.
            if (index > playing.index) markDone(playing.tour.steps[playing.index]!.id, true);
            setPlaying({ ...playing, index });
        },
        [playing, markDone]
    );
    const closeTour = useCallback(() => {
        if (playing && playing.index === playing.tour.steps.length - 1) markDone(playing.tour.steps[playing.index]!.id, true);
        setPlaying(undefined);
    }, [playing, markDone]);

    const captureNode = useCallback(
        (d: NodeDetails) =>
            setCapture({
                title: d.name,
                body: '',
                target: { node: d.key },
                view: { mode: mode === 'matrix' ? 'matrix' : 'map', focus: d.key, ...(lens !== 'dependencies' ? { lens } : {}) },
            }),
        [mode, lens]
    );
    const captureFlow = useCallback(
        (f: Flow) =>
            setCapture({
                title: f.label,
                body: '',
                target: { flow: f.id, ...(f.handler ? { node: f.handler } : {}) },
                view: { mode: 'flows' },
                code: [{ path: f.file, start: f.line + 1, end: f.line + 1 }],
            }),
        []
    );

    const activate = useCallback(
        (id: string) => {
            const external = keyOfExternal(id);
            if (external) return void reveal(external);
            const n = view?.nodes.find((x) => x.key === id);
            if (!n) return;
            if (n.expanded || n.hasChildren) return toggleExpand(id);
            if (n.kind === 'module') host?.openFile?.(n.path);
        },
        [view, reveal, toggleExpand, host]
    );

    const onKeyDown = (e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            return setSearching(true);
        }
        const target = e.target as HTMLElement;
        if (target.closest('input, textarea, .ca-navigator')) return;
        if (mode === 'flows' || mode === 'tours') return e.key === 'Escape' ? setSelection(undefined) : undefined;
        const key = selection?.kind === 'node' ? selection.key : undefined;
        if (e.key === 'Backspace') return up();
        if (e.key === 'Escape') return setSelection(undefined);
        if ((e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey) return setFocus((f) => !f);
        if (e.key === 'Enter' && key && e.shiftKey) {
            const n = view?.nodes.find((x) => x.key === key);
            if (n?.hasChildren) return drill(key);
        }
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
                {props.toolbarStart}
                {view ? <Breadcrumb items={view.breadcrumb} onGo={drill} /> : <span />}
                <span className="ca-toolbar-gap" />
                {mode === 'flows' || mode === 'tours' ? null : flow && mode === 'map' ? (
                    <span className="ca-legend" aria-label="Selection flow">
                        <span className="ca-legend-out">uses {flow.out.size}</span>
                        <span className="ca-legend-in">used by {flow.in.size}</span>
                    </span>
                ) : (
                    <span className="ca-hint">Click to trace dependencies · double-click to expand</span>
                )}
                {focus ? <span className="ca-chip" title="F toggles focus">Focus: 2 hops</span> : null}
                {view?.skipped.length ? <span className="ca-muted">{view.skipped.length} expansion(s) over budget</span> : null}
                {mode === 'map' && model && model.edges.length > DEFAULT_EDGE_LIMIT ? (
                    <span className="ca-muted ca-edge-count">
                        {allEdges ? `all ${model.edges.length} dependencies` : `heaviest ${DEFAULT_EDGE_LIMIT} of ${model.edges.length} dependencies`}
                        {' · '}
                        <button type="button" className="ca-link" onClick={() => setAllEdges((a) => !a)}>
                            {allEdges ? 'show fewer' : 'show all'}
                        </button>
                    </span>
                ) : null}
                <div className="ca-segmented" role="group" aria-label="View mode">
                    {(['map', 'matrix', 'flows', 'tours'] as const)
                        .filter((m) => (m === 'flows' ? !!client.flows : m === 'tours' ? !!client.tours : true))
                        .map((m) => (
                            <button
                                key={m}
                                type="button"
                                aria-pressed={mode === m}
                                className={mode === m ? 'ca-on' : ''}
                                onClick={() => {
                                    if (m === 'tours') setPlaying(undefined);
                                    setMode(m);
                                }}
                            >
                                {MODE_LABEL[m]}
                            </button>
                        ))}
                </div>
                <label className="ca-lens" hidden={mode === 'flows' || mode === 'tours'}>
                    Lens{' '}
                    <select value={lens} onChange={(e) => setLens(e.target.value as LensId)} title={LENSES.find((l) => l.id === lens)?.description}>
                        {LENSES.map((l) => (
                            <option key={l.id} value={l.id}>
                                {l.label}
                            </option>
                        ))}
                    </select>
                </label>
                {props.ai ? (
                    <>
                        <button type="button" className="ca-search-button" title="Ask about the codebase" aria-pressed={sideTab === 'chat'} onClick={() => setSideTab((t) => (t === 'chat' ? 'inspector' : 'chat'))}>
                            <Icon name="chat" size={14} />
                            Ask
                        </button>
                        <button type="button" className="ca-search-button" title="AI settings: privacy, providers, models" onClick={() => setSettingsOpen(true)}>
                            <Icon name="sliders" size={14} />
                            AI
                        </button>
                    </>
                ) : null}
                {props.toolbarExtras}
                {client.search ? (
                    <button type="button" className="ca-search-button" onClick={() => setSearching(true)}>
                        Search <kbd>⌘K</kbd>
                    </button>
                ) : null}
            </header>
            <div className="ca-body">
                <Navigator client={client} revision={revision} dataVersion={props.dataVersion ?? 0} path={view?.breadcrumb.map((b) => b.key) ?? []} selected={selectedKey} onReveal={(k) => void reveal(k)} onDrill={(k) => void reveal(k)} />
                <section className="ca-canvas" aria-label="Architecture map">
                    {mode === 'tours' ? (
                        <ToursList client={client} workspace={workspaceId} dataVersion={props.dataVersion ?? 0} draft={draft} onPlay={play} onDraftChange={setDraft} />
                    ) : mode === 'flows' ? (
                        <FlowsView
                            client={client}
                            revision={revision}
                            dataVersion={props.dataVersion ?? 0}
                            selected={selectedKey}
                            onSelect={(key) => setSelection({ kind: 'node', key })}
                            onShowOnMap={(keys) => {
                                setMode('map');
                                if (keys[0]) void reveal(keys[0]);
                            }}
                            openFile={host?.openFile ? (p, line) => host.openFile!(p, line) : undefined}
                            focusFlow={flowFocus}
                            onWalk={(f) => play(tourFromFlow(f, flowRows(f).map((r) => r.index)))}
                            onAddToTour={captureFlow}
                        />
                    ) : mode === 'matrix' && view ? (
                        <Matrix
                            view={view}
                            selected={selectedKey}
                            selectedEdge={selection?.kind === 'edge' ? `${selection.source}->${selection.target}` : undefined}
                            onSelect={(k) => setSelection({ kind: 'node', key: k })}
                            onActivate={activate}
                            onSelectEdge={(source, target) => setSelection({ kind: 'edge', source, target })}
                        />
                    ) : model && layout && view ? (
                        <ReactFlowProvider>
                            <MapCanvas
                                model={model}
                                edges={drawn}
                                layout={layout}
                                selected={selectedKey}
                                selectedEdge={selection?.kind === 'edge' ? `${selection.source}->${selection.target}` : undefined}
                                hops={focus ? 2 : 1}
                                lens={lens}
                                focus={focusOn}
                                onSelect={(id) => setSelection(id ? { kind: 'node', key: id } : undefined)}
                                onActivate={activate}
                                onToggle={toggleExpand}
                                onSelectEdge={(source, target) => setSelection({ kind: 'edge', source, target })}
                            />
                        </ReactFlowProvider>
                    ) : null}
                    {status && mode !== 'flows' && mode !== 'tours' ? <div className="ca-status">{status}</div> : null}
                    {view && view.nodes.length === 0 && mode !== 'flows' && mode !== 'tours' ? <div className="ca-status">Nothing to show here.</div> : null}
                    {playing && mode !== 'tours' ? (
                        <TourPlayer
                            tour={playing.tour}
                            index={playing.index}
                            done={done}
                            onIndex={goToStep}
                            onClose={closeTour}
                            onToggleDone={(id) => markDone(id)}
                            onNode={(k) => void reveal(k)}
                            onFile={host?.openFile ? (p, line) => host.openFile!(p, line) : undefined}
                            onAsk={
                                props.ai
                                    ? (q) => {
                                          setChatPrompt({ text: q, nonce: Date.now() });
                                          setSideTab('chat');
                                      }
                                    : undefined
                            }
                            onRemove={
                                playing.tour.id === 'draft' && draft
                                    ? (stepId) => {
                                          const next = removeFromDraft(draft, stepId);
                                          setDraft(next);
                                          if (!next) return setPlaying(undefined);
                                          setPlaying({ tour: { ...next, status: next.steps.map(() => ({})) }, index: Math.min(playing.index, next.steps.length - 1) });
                                      }
                                    : undefined
                            }
                        />
                    ) : null}
                </section>
                <aside className="ca-side">
                    {props.ai ? (
                        <div className="ca-tabs" role="tablist" aria-label="Side panel">
                            {(['inspector', 'chat'] as const).map((t) => (
                                <button key={t} type="button" role="tab" aria-selected={sideTab === t} className={sideTab === t ? 'ca-on' : ''} onClick={() => setSideTab(t)}>
                                    <Icon name={t === 'inspector' ? 'info' : 'sparkles'} size={14} />
                                    {t === 'inspector' ? 'Inspector' : 'Ask'}
                                </button>
                            ))}
                        </div>
                    ) : null}
                    {props.ai && sideTab === 'chat' ? (
                        <ChatPanel
                            ai={props.ai}
                            selection={details ? { key: details.key, name: details.name } : undefined}
                            prompt={chatPrompt}
                            onNode={(k) => void reveal(k)}
                            onFile={host?.openFile ? (p, line) => host.openFile!(p, line) : undefined}
                            onAction={(a) => a.keys[0] && void reveal(a.keys[0])}
                            onOpenSettings={() => setSettingsOpen(true)}
                        />
                    ) : (
                        <Inspector
                            details={details}
                            explanation={explanation}
                            nameOf={nameOf}
                            host={host}
                            expanded={!!selectedKey && expanded.includes(selectedKey)}
                            lens={lens}
                            ai={props.ai}
                            onAsk={(name) => {
                                setChatPrompt({ text: `What does ${name} do, and how does it fit in?`, nonce: Date.now() });
                                setSideTab('chat');
                            }}
                            onReveal={(k) => void reveal(k)}
                            onDrill={drill}
                            onToggleExpand={toggleExpand}
                            onAddToTour={client.tours ? captureNode : undefined}
                        />
                    )}
                </aside>
            </div>
            {props.ai && settingsOpen ? (
                <div className="ca-modal" onClick={(e) => e.target === e.currentTarget && setSettingsOpen(false)}>
                    <div className="ca-modal-body ca-modal-wide">
                        <AiSettingsPanel ai={props.ai} onClose={() => setSettingsOpen(false)} />
                    </div>
                </div>
            ) : null}
            {props.ai ? <PreviewDialog ai={props.ai} /> : null}
            {capture ? (
                <AddToTourDialog
                    capture={capture}
                    draftTitle={draft?.title}
                    onClose={() => setCapture(undefined)}
                    onAdd={(c, title) => {
                        setDraft(addToDraft(draft, c, title));
                        setCapture(undefined);
                    }}
                />
            ) : null}
            {searching && client.search ? <SearchBox client={client} onPick={pick} onClose={() => setSearching(false)} /> : null}
        </div>
    );
}
