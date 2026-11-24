/**
 * Flows mode: the system's entrypoints (routes, commands, jobs, main) and,
 * for the chosen one, what happens next as a sequence across swimlanes, one
 * lane per component or package. Each step is a call the engine matched to a
 * symbol; steps matched by name only are marked, and so are shared helpers it
 * didn't follow.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { EngineClient, EntryPointKind, Flow, FlowSummary, SinkKind } from '@codearchy/protocol';
import { flowModules, flowRows, groupFlows, splitLabel } from './flowModel.js';
import { Icon, type IconName } from './icons.js';
import { Resizer, usePanelSize } from './Resizer.js';

const KIND_ICON: Record<EntryPointKind, IconName> = { http: 'globe', ui: 'laptop', cli: 'terminal', event: 'bolt', job: 'clock', main: 'play' };
const SINK_ICON: Record<SinkKind, IconName> = { database: 'database', http: 'globe', queue: 'layers', cache: 'gauge', storage: 'boxes' };
const SINK_LABEL: Record<SinkKind, string> = { database: 'Database', http: 'HTTP', queue: 'Queue', cache: 'Cache', storage: 'Storage' };

export interface FlowsViewProps {
    client: EngineClient;
    /** Changes when a different workspace is loaded. */
    revision: string;
    /** Changes when the workspace's files change: lists and traces refetch. */
    dataVersion: number;
    /** The node shown in the Inspector. */
    selected?: string;
    onSelect(key: string): void;
    /** Leave Flows for the Map, showing these modules. */
    onShowOnMap(keys: string[]): void;
    openFile?(path: string, line?: number): void;
    /** Show this flow (a tour step, a link); a new `nonce` repeats it. */
    focusFlow?: { id: string; nonce: number };
    /** "Walk through": play the flow as a tour. */
    onWalk?(flow: Flow): void;
    /** "Add to tour": capture the flow as a step of the draft tour. */
    onAddToTour?(flow: Flow): void;
}

export function FlowsView(props: FlowsViewProps) {
    const { client } = props;
    const [flows, setFlows] = useState<FlowSummary[]>();
    const [query, setQuery] = useState('');
    const [current, setCurrent] = useState<string>();
    const [flow, setFlow] = useState<Flow>();
    const [error, setError] = useState('');

    useEffect(() => {
        let live = true;
        if (!client.flows) return;
        client.flows().then(
            (list) => {
                if (!live) return;
                setFlows(list);
                setError('');
                // Keep the current flow when it still exists, else start with the first.
                setCurrent((c) => (c && list.some((f) => f.id === c) ? c : list[0]?.id));
            },
            (err: unknown) => live && setError(err instanceof Error ? err.message : String(err))
        );
        return () => {
            live = false;
        };
    }, [client, props.revision, props.dataVersion]);

    useEffect(() => {
        let live = true;
        if (!current || !client.flow) {
            setFlow(undefined);
            return;
        }
        void client.flow(current).then((f) => live && setFlow(f));
        return () => {
            live = false;
        };
    }, [client, current, props.dataVersion]);

    useEffect(() => {
        if (props.focusFlow) setCurrent(props.focusFlow.id);
    }, [props.focusFlow?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

    const listWidth = usePanelSize('flows', 280, 180, 560);
    const groups = useMemo(() => groupFlows(flows ?? [], query), [flows, query]);
    const total = flows?.length ?? 0;

    if (error) return <div className="ca-flows-empty" role="alert">Couldn't load flows: {error}</div>;
    if (!flows) return <div className="ca-flows-empty">Finding entrypoints…</div>;
    if (total === 0) {
        return (
            <div className="ca-flows-empty">
                <div className="ca-empty-icon">
                    <Icon name="flow" size={22} />
                </div>
                <strong>No entrypoints found</strong>
                <p className="ca-muted">
                    Flows start where requests, commands and jobs enter the code: HTTP routes (Express, NestJS, FastAPI, Flask, Django, Spring, ASP.NET, gin, Laravel, Rails and more),
                    CLI commands, queue workers and listeners, UI routes and <code>main</code>. None of those were found in this workspace.
                </p>
            </div>
        );
    }

    return (
        <div className="ca-flows" style={{ ['--ca-flows-w' as string]: `${listWidth.size}px` }}>
            <nav className="ca-flows-list" aria-label="Entrypoints">
                <div className="ca-flows-filter">
                    <input type="search" placeholder={`Filter ${total} entrypoint${total === 1 ? '' : 's'}`} aria-label="Filter entrypoints" value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
                {groups.length === 0 ? <p className="ca-muted ca-flows-none">Nothing matches “{query}”.</p> : null}
                {groups.map((g) => (
                    <section key={g.kind} aria-label={g.title}>
                        <h3 className="ca-panel-title">
                            <Icon name={KIND_ICON[g.kind]} size={12} /> {g.title} <span className="ca-count">{g.flows.length}</span>
                        </h3>
                        <ul>
                            {g.flows.map((f) => {
                                const { verb, rest } = splitLabel(f.label);
                                return (
                                    <li key={f.id}>
                                        <button type="button" className={`ca-flow-item${f.id === current ? ' ca-on' : ''}`} aria-current={f.id === current ? 'true' : undefined} onClick={() => setCurrent(f.id)} title={`${f.label} · ${f.file}:${f.line + 1}`}>
                                            <span className="ca-flow-item-label">
                                                {verb ? <span className={`ca-verb ca-verb-${verb.toLowerCase()}`}>{verb}</span> : null}
                                                <span className="ca-flow-item-name">{rest || '/'}</span>
                                            </span>
                                            <span className="ca-flow-item-meta">
                                                {f.framework} · {f.file.split('/').pop()}
                                            </span>
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    </section>
                ))}
            </nav>
            <Resizer panel={listWidth} side="left" label="Entrypoints width" className="ca-flows-resizer" />
            <section className="ca-flow" aria-label="Flow">
                {flow ? <FlowSequence flow={flow} {...props} /> : <div className="ca-flows-empty">Choose an entrypoint to see its flow.</div>}
            </section>
        </div>
    );
}

/** The arrow spans the caller's column up to (not including) the callee's, whose box it points at. */
function arrowStyle(from: number, to: number, row: number): CSSProperties {
    const [start, end] = from < to ? [from, to - 1] : [to + 1, from];
    return { gridColumn: `${start + 1} / ${end + 2}`, gridRow: row, ['--span' as string]: end - start + 1 };
}

function FlowSequence({ flow, selected, onSelect, onShowOnMap, openFile, onWalk, onAddToTour }: { flow: Flow } & FlowsViewProps) {
    const rows = useMemo(() => flowRows(flow), [flow]);
    const { verb, rest } = splitLabel(flow.label);
    const lanes = flow.lanes;
    const root = flow.steps[0];
    // A tour step (or a selection elsewhere) on this flow: bring its call into view.
    const grid = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = grid.current?.querySelector<HTMLElement>('.ca-step.ca-on');
        el?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    }, [selected, flow.id]);
    return (
        <>
            <header className="ca-flow-head">
                <div className="ca-flow-title">
                    <Icon name={KIND_ICON[flow.kind]} size={16} />
                    {verb ? <span className={`ca-verb ca-verb-${verb.toLowerCase()}`}>{verb}</span> : null}
                    <h2>{rest || '/'}</h2>
                    <span className="ca-chip">{flow.framework}</span>
                </div>
                <div className="ca-flow-actions">
                    {openFile ? (
                        <button type="button" className="ca-button ca-button-soft" onClick={() => openFile(flow.file, flow.line)}>
                            <Icon name="external" size={14} /> Open declaration
                        </button>
                    ) : null}
                    <button type="button" className="ca-button ca-button-soft" onClick={() => onShowOnMap(flowModules(flow))}>
                        <Icon name="map" size={14} /> Show on map
                    </button>
                    {onWalk ? (
                        <button type="button" className="ca-button ca-button-soft" onClick={() => onWalk(flow)}>
                            <Icon name="play" size={14} /> Walk through
                        </button>
                    ) : null}
                    {onAddToTour ? (
                        <button type="button" className="ca-button" onClick={() => onAddToTour(flow)}>
                            <Icon name="plus" size={14} /> Add to tour
                        </button>
                    ) : null}
                </div>
                <p className="ca-flow-summary ca-muted">
                    {flow.steps.length} step{flow.steps.length === 1 ? '' : 's'} across {lanes.length} part{lanes.length === 1 ? '' : 's'}
                    {root && root.file !== flow.file ? ` · handler ${root.name} in ${root.file}` : ''}
                </p>
                {flow.sinks.length ? (
                    <div className="ca-flow-sinks" aria-label="Where it leaves the system">
                        <span className="ca-muted">Reaches</span>
                        {flow.sinks.map((s) => (
                            <span key={`${s.kind}:${s.name}`} className={`ca-sink ca-sink-${s.kind}`} title={`${SINK_LABEL[s.kind]}: ${s.name} (imported by ${flow.steps[s.step]?.file ?? ''})`}>
                                <Icon name={SINK_ICON[s.kind]} size={12} />
                                {s.name}
                            </span>
                        ))}
                    </div>
                ) : null}
                {flow.approximate || flow.truncated ? (
                    <p className="ca-card-note">
                        <Icon name="info" size={14} />
                        <span>
                            {flow.approximate ? 'Some calls were matched by name only (no import or same-file evidence); they are dashed. ' : ''}
                            {flow.truncated ? 'The trace stops at its depth and size limits, so deeper calls are not shown.' : ''}
                        </span>
                    </p>
                ) : null}
            </header>
            <div className="ca-flow-scroll">
                <div ref={grid} className="ca-flow-grid" role="list" aria-label="Steps" style={{ gridTemplateColumns: `repeat(${lanes.length}, minmax(170px, 1fr))` }}>
                    {lanes.map((l, i) => (
                        <div key={l.key} className="ca-lane-head" style={{ gridColumn: i + 1, gridRow: 1 }} title={l.key}>
                            <Icon name={l.kind === 'package' ? 'boxes' : 'layers'} size={12} />
                            <span>{l.name}</span>
                        </div>
                    ))}
                    {lanes.map((l, i) => (
                        <div key={`life:${l.key}`} className="ca-lifeline" aria-hidden="true" style={{ gridColumn: i + 1, gridRow: `2 / span ${Math.max(1, rows.length)}` }} />
                    ))}
                    {rows.map((r, ri) => {
                        const row = ri + 2;
                        const cross = r.from !== undefined && r.from !== r.lane;
                        const s = r.step;
                        const mod = `mod:${s.file}`;
                        const indent = !cross && r.from !== undefined ? Math.min(s.depth, 5) * 14 : 0;
                        const classes = ['ca-step', s.resolution === 'name' ? 'ca-step-guess' : '', s.crossCutting ? 'ca-step-shared' : '', s.depth === 0 ? 'ca-step-entry' : '', selected === s.key || selected === mod ? 'ca-on' : '']
                            .filter(Boolean)
                            .join(' ');
                        return (
                            <div key={r.index} style={{ display: 'contents' }} role="listitem">
                                {cross ? (
                                    <div
                                        className={`ca-flow-arrow ${r.from! < r.lane ? 'ca-right' : 'ca-left'}`}
                                        aria-hidden="true"
                                        style={arrowStyle(r.from!, r.lane, row)}
                                    />
                                ) : null}
                                <div className={classes} style={{ gridColumn: r.lane + 1, gridRow: row, marginLeft: indent }}>
                                    <button
                                        type="button"
                                        className="ca-step-main"
                                        onClick={() => onSelect(mod)}
                                        onDoubleClick={() => openFile?.(s.file, s.line)}
                                        title={`${s.name}\n${s.file}:${s.line + 1}${s.callSite ? ` · called from line ${s.callSite.line + 1}` : ''}`}
                                    >
                                        <span className="ca-step-name">
                                            {s.depth > 0 && !cross ? <span className="ca-muted">↳ </span> : null}
                                            {s.name}
                                        </span>
                                        <span className="ca-step-meta">
                                            {s.file.split('/').pop()}:{s.line + 1}
                                            {s.resolution === 'name' ? <span className="ca-step-tag">by name</span> : null}
                                            {s.crossCutting ? <span className="ca-step-tag">shared helper</span> : null}
                                        </span>
                                        {r.sinks.length ? (
                                            <span className="ca-step-sinks">
                                                {r.sinks.map((k) => (
                                                    <span key={k.name} className={`ca-sink ca-sink-${k.kind}`}>
                                                        <Icon name={SINK_ICON[k.kind]} size={11} />
                                                        {k.name}
                                                    </span>
                                                ))}
                                            </span>
                                        ) : null}
                                    </button>
                                    {openFile ? (
                                        <button type="button" className="ca-icon-button ca-step-open" aria-label={`Open ${s.name}`} title="Open in editor" onClick={() => openFile(s.file, s.line)}>
                                            <Icon name="external" size={13} />
                                        </button>
                                    ) : null}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </>
    );
}
