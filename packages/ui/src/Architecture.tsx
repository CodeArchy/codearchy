/**
 * Architecture: the high-level system design, a tab of its own beside the Map
 * (like v1's System view). "Design with AI" has the architect model design
 * it: subsystems, services and layers with architect-level names, what each
 * is responsible for, the systems around it and how they relate, and the
 * overall pattern; the design is kept per workspace. Before that (or without
 * AI) it shows the system as the code is organised, from the index and flows.
 *
 * Drawn as plain SVG in layered rows: click a box for what it is and the code
 * it consists of, double-click to open its code on the Map.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ARCH_LAYERS, type AiClient, type ArchLayer, type ArchNode, type Architecture, type EngineClient } from '@codearchy/protocol';
import { Icon } from './icons.js';

const LAYER_LABEL: Record<ArchLayer, string> = {
    actors: 'Who calls in',
    interface: 'Interface',
    application: 'Application',
    domain: 'Domain',
    data: 'Data',
    infrastructure: 'Infrastructure',
    shared: 'Shared',
    external: 'External systems',
};
const BOX = { w: 184, h: 66, gapX: 26, rowGap: 74, gutter: 132, pad: 24 };

export interface ArchitectureViewProps {
    client: EngineClient;
    ai?: AiClient;
    revision: string;
    dataVersion: number;
    selected?: string;
    onSelect(key: string): void;
    /** Opens a part on the Map. */
    onShowOnMap(key: string): void;
}

interface Placed {
    node: ArchNode;
    x: number;
    y: number;
}

/** Rows by layer; within a row, boxes ordered by where their neighbours are (fewer crossings), wrapped to the width. */
export function layoutArchitecture(a: Architecture, width: number): { boxes: Map<string, Placed>; rows: Array<{ layer: ArchLayer; y: number; h: number }>; width: number; height: number } {
    const perRow = Math.max(1, Math.floor((width - BOX.gutter - BOX.pad * 2 + BOX.gapX) / (BOX.w + BOX.gapX)));
    const byLayer = ARCH_LAYERS.map((layer) => ({ layer, nodes: a.nodes.filter((n) => n.layer === layer) })).filter((r) => r.nodes.length);
    const neighbours = new Map<string, string[]>();
    for (const e of a.edges) {
        neighbours.set(e.source, [...(neighbours.get(e.source) ?? []), e.target]);
        neighbours.set(e.target, [...(neighbours.get(e.target) ?? []), e.source]);
    }
    const boxes = new Map<string, Placed>();
    const rows: Array<{ layer: ArchLayer; y: number; h: number }> = [];
    let y = BOX.pad;
    let widest = 0;
    for (const { layer, nodes } of byLayer) {
        // Order by the mean position of neighbours already placed (barycentre), else by size.
        const ordered = [...nodes].sort((p, q) => {
            const at = (n: ArchNode) => {
                const xs = (neighbours.get(n.id) ?? []).map((k) => boxes.get(k)?.x).filter((x): x is number => x !== undefined);
                return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : Number.POSITIVE_INFINITY;
            };
            return at(p) - at(q) || (q.files ?? 0) - (p.files ?? 0) || p.label.localeCompare(q.label);
        });
        const lines = Math.ceil(ordered.length / perRow);
        for (let line = 0; line < lines; line++) {
            const slice = ordered.slice(line * perRow, (line + 1) * perRow);
            const rowWidth = slice.length * BOX.w + (slice.length - 1) * BOX.gapX;
            const left = BOX.gutter + Math.max(0, (Math.min(perRow, ordered.length) * (BOX.w + BOX.gapX) - BOX.gapX - rowWidth) / 2);
            slice.forEach((node, i) => boxes.set(node.id, { node, x: left + i * (BOX.w + BOX.gapX), y: y + line * (BOX.h + 28) }));
            widest = Math.max(widest, left + rowWidth);
        }
        const h = lines * BOX.h + (lines - 1) * 28;
        rows.push({ layer, y, h });
        y += h + BOX.rowGap;
    }
    return { boxes, rows, width: Math.max(width, widest + BOX.pad), height: y - BOX.rowGap + BOX.pad };
}

/** A curve from one box to another: bottom → top going down, top → bottom going up, an arc within a row. */
function edgePath(s: Placed, t: Placed): { d: string; mx: number; my: number } {
    const sx = s.x + BOX.w / 2;
    const tx = t.x + BOX.w / 2;
    if (Math.abs(s.y - t.y) < 1) {
        const top = s.y - 22;
        return { d: `M ${sx} ${s.y} C ${sx} ${top}, ${tx} ${top}, ${tx} ${t.y}`, mx: (sx + tx) / 2, my: top + 6 };
    }
    const down = t.y > s.y;
    const sy = down ? s.y + BOX.h : s.y;
    const ty = down ? t.y : t.y + BOX.h;
    const dy = (ty - sy) / 2;
    return { d: `M ${sx} ${sy} C ${sx} ${sy + dy}, ${tx} ${ty - dy}, ${tx} ${ty}`, mx: (sx + tx) / 2, my: (sy + ty) / 2 };
}

export function ArchitectureView(props: ArchitectureViewProps) {
    const { client, ai } = props;
    const [base, setBase] = useState<Architecture>();
    const [described, setDescribed] = useState<Architecture>();
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [hover, setHover] = useState<string>();
    /** The box whose details are open. */
    const [picked, setPicked] = useState<string>();
    const [width, setWidth] = useState(900);
    const wrap = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let live = true;
        setError('');
        client.architecture?.().then(
            (a) => live && setBase(a),
            (e: unknown) => live && setError(e instanceof Error ? e.message : String(e))
        );
        ai?.describeArchitecture?.().then((a) => live && setDescribed(a), () => undefined);
        return () => {
            live = false;
        };
    }, [client, ai, props.revision, props.dataVersion]);
    useEffect(() => {
        const el = wrap.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(([e]) => e && setWidth(Math.max(480, e.contentRect.width)));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const a = described ?? base;
    const layout = useMemo(() => (a ? layoutArchitecture(a, width) : undefined), [a, width]);
    const focus = hover ?? picked;
    const pickedNode = a?.nodes.find((n) => n.id === picked);
    const lit = useMemo(() => {
        if (!a || !focus) return undefined;
        const ids = new Set([focus]);
        for (const e of a.edges) if (e.source === focus || e.target === focus) ids.add(e.source).add(e.target);
        return ids;
    }, [a, focus]);

    const describe = async () => {
        if (!ai?.describeArchitecture) return;
        setBusy(true);
        setError('');
        try {
            setDescribed(await ai.describeArchitecture({ generate: true }));
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    if (!client.architecture) return <div className="ca-flows-empty">This engine can't draw the architecture yet.</div>;
    if (error && !a) return <div className="ca-flows-empty" role="alert">Couldn't build the architecture: {error}</div>;
    if (!a || !layout) return <div className="ca-flows-empty">Drawing the architecture…</div>;

    return (
        <div className="ca-arch" ref={wrap}>
            <header className="ca-arch-head">
                <div className="ca-arch-title">
                    <span className="ca-arch-kicker">
                        {a.source === 'ai' ? `System design · by ${a.model} · ${new Date(a.createdAt).toLocaleDateString()}` : 'As the code is organised'}
                    </span>
                    <h2>{a.pattern}</h2>
                    <p>{a.summary}</p>
                    {a.source !== 'ai' && ai?.describeArchitecture ? (
                        <p className="ca-muted ca-arch-nudge">
                            <strong>Design with AI</strong> turns this into a high-level design: subsystems, services and layers named by what they do, the systems around them, and the pattern.
                        </p>
                    ) : null}
                </div>
                {ai?.describeArchitecture ? (
                    <button type="button" className={`ca-button ${a.source === 'ai' ? 'ca-button-soft' : 'ca-button-primary'}`} disabled={busy} onClick={() => void describe()}>
                        <Icon name="sparkles" size={14} className={busy ? 'ca-spin' : undefined} /> {busy ? 'Designing…' : a.source === 'ai' ? 'Redesign' : 'Design with AI'}
                    </button>
                ) : null}
            </header>
            {busy ? (
                <p className="ca-card-note ca-arch-busy" role="status">
                    <Icon name="info" size={13} /> <span>The architect model is reading the code's structure and designing the system. A local model can take a minute.</span>
                </p>
            ) : null}
            {error ? (
                <p className="ca-card-note ca-arch-error" role="alert">
                    <Icon name="alert" size={13} /> <span>{error}</span>
                </p>
            ) : null}
            <svg className="ca-arch-svg" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label={`Architecture: ${a.pattern}`}>
                <defs>
                    <marker id="ca-arch-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                        <path d="M 0 0 L 10 5 L 0 10 z" className="ca-arch-arrowhead" />
                    </marker>
                </defs>
                {layout.rows.map((r) => (
                    <g key={r.layer} className={`ca-arch-row ca-arch-row-${r.layer}`}>
                        <rect x={8} y={r.y - 12} width={layout.width - 16} height={r.h + 24} rx={12} />
                        <text x={20} y={r.y + r.h / 2} dominantBaseline="middle">
                            {LAYER_LABEL[r.layer]}
                        </text>
                    </g>
                ))}
                {a.edges.map((e) => {
                    const s = layout.boxes.get(e.source);
                    const t = layout.boxes.get(e.target);
                    if (!s || !t) return null;
                    const p = edgePath(s, t);
                    const on = !!lit && lit.has(e.source) && lit.has(e.target) && (e.source === focus || e.target === focus);
                    const dim = !!lit && !on;
                    return (
                        <g key={`${e.source}->${e.target}`} className={`ca-arch-edge ca-arch-edge-${e.kind}${on ? ' ca-on' : ''}${dim ? ' ca-dim' : ''}`}>
                            <path d={p.d} markerEnd="url(#ca-arch-arrow)" style={{ strokeWidth: Math.min(4, 1.2 + Math.log2(1 + (e.weight ?? 1)) * 0.5) }} />
                            {on || !lit ? <EdgeLabel x={p.mx} y={p.my} text={e.label} /> : null}
                            <title>{`${s.node.label} → ${t.node.label}: ${e.label}`}</title>
                        </g>
                    );
                })}
                {[...layout.boxes.values()].map((b) => (
                    <ArchBox
                        key={b.node.id}
                        placed={b}
                        selected={picked === b.node.id}
                        dim={!!lit && !lit.has(b.node.id)}
                        onHover={setHover}
                        onSelect={() => {
                            setPicked((p) => (p === b.node.id ? undefined : b.node.id));
                            if (b.node.parts.length === 1) props.onSelect(b.node.parts[0]!);
                        }}
                        onOpen={() => b.node.parts[0] && props.onShowOnMap(b.node.parts[0])}
                    />
                ))}
            </svg>
            <p className="ca-muted ca-arch-hint">
                Click a box for what it is and its code · double-click to open its code on the Map · {a.nodes.filter((n) => n.kind === 'part').length} parts, {a.nodes.filter((n) => n.kind === 'external').length} external systems
            </p>
            {pickedNode ? <ArchDetails node={pickedNode} architecture={a} nameOf={(k) => base?.nodes.find((n) => n.id === k)?.label ?? k.replace(/^\w+:/, '').split('/').pop() ?? k} onShowOnMap={props.onShowOnMap} onPick={setPicked} onClose={() => setPicked(undefined)} /> : null}
        </div>
    );
}

const TYPE_LABEL = { subsystem: 'Subsystem', layer: 'Layer', service: 'Service' } as const;

/** What a box is: its role in the design, the code it consists of, and what it talks to. */
function ArchDetails({ node: n, architecture: a, nameOf, onShowOnMap, onPick, onClose }: { node: ArchNode; architecture: Architecture; nameOf(key: string): string; onShowOnMap(key: string): void; onPick(id: string): void; onClose(): void }) {
    const label = (id: string) => a.nodes.find((x) => x.id === id)?.label ?? id;
    const out = a.edges.filter((e) => e.source === n.id);
    const into = a.edges.filter((e) => e.target === n.id);
    return (
        <aside className="ca-arch-details" aria-label={`${n.label} details`}>
            <header>
                <span className="ca-chip">{n.kind === 'part' ? (n.type ? TYPE_LABEL[n.type] : 'Part') : n.kind === 'external' ? 'External system' : 'Caller'}</span>
                <span className="ca-toolbar-gap" />
                <button type="button" className="ca-icon-button" aria-label="Close" onClick={onClose}>
                    <Icon name="close" size={14} />
                </button>
            </header>
            <h3>{n.label}</h3>
            {n.description ? <p>{n.description}</p> : null}
            {n.parts.length ? (
                <section>
                    <h4>
                        Code <span className="ca-muted">{n.files ? `${n.files} file${n.files === 1 ? '' : 's'}` : ''}</span>
                    </h4>
                    <div className="ca-arch-parts">
                        {n.parts.map((k) => (
                            <button key={k} type="button" className="ca-pill" title={`Open ${k} on the Map`} onClick={() => onShowOnMap(k)}>
                                {nameOf(k)}
                            </button>
                        ))}
                    </div>
                </section>
            ) : null}
            {out.length || into.length ? (
                <section>
                    <h4>Relationships</h4>
                    <ul className="ca-list">
                        {out.map((e) => (
                            <li key={`o${e.target}`}>
                                → <button type="button" className="ca-link" onClick={() => onPick(e.target)}>{label(e.target)}</button> <span className="ca-muted">{e.label}</span>
                            </li>
                        ))}
                        {into.map((e) => (
                            <li key={`i${e.source}`}>
                                ← <button type="button" className="ca-link" onClick={() => onPick(e.source)}>{label(e.source)}</button> <span className="ca-muted">{e.label}</span>
                            </li>
                        ))}
                    </ul>
                </section>
            ) : null}
        </aside>
    );
}

function EdgeLabel({ x, y, text }: { x: number; y: number; text: string }) {
    const w = Math.min(150, text.length * 6.2 + 12);
    return (
        <g className="ca-arch-edge-label" transform={`translate(${x - w / 2}, ${y - 9})`}>
            <rect width={w} height={18} rx={9} />
            <text x={w / 2} y={9} dominantBaseline="central" textAnchor="middle">
                {text.length > 24 ? `${text.slice(0, 23)}…` : text}
            </text>
        </g>
    );
}

function ArchBox({ placed: { node: n, x, y }, selected, dim, onHover, onSelect, onOpen }: { placed: Placed; selected: boolean; dim: boolean; onHover(id: string | undefined): void; onSelect(): void; onOpen(): void }) {
    const files = n.files ? `${n.files} file${n.files === 1 ? '' : 's'}` : '';
    const sub = n.kind === 'part' ? [n.type ?? n.role, files].filter(Boolean).join(' · ') : n.kind === 'external' ? (n.sink ?? 'external system') : 'caller';
    const cls = `ca-arch-box ca-arch-${n.kind}${n.type ? ` ca-arch-type-${n.type}` : ''}${n.sink ? ` ca-arch-sink-${n.sink}` : ''}${selected ? ' ca-selected' : ''}${dim ? ' ca-dim' : ''}`;
    return (
        <g
            className={cls}
            transform={`translate(${x}, ${y})`}
            tabIndex={0}
            role="button"
            aria-label={`${n.label}: ${n.description}`}
            onMouseEnter={() => onHover(n.id)}
            onMouseLeave={() => onHover(undefined)}
            onFocus={() => onHover(n.id)}
            onBlur={() => onHover(undefined)}
            onClick={onSelect}
            onDoubleClick={onOpen}
            onKeyDown={(e) => {
                if (e.key === 'Enter') onOpen();
                if (e.key === ' ') (e.preventDefault(), onSelect());
            }}
        >
            <title>{n.description}</title>
            {n.sink === 'database' || n.sink === 'cache' ? (
                <>
                    <path className="ca-arch-shape" d={`M 0 10 a ${BOX.w / 2} 10 0 0 1 ${BOX.w} 0 v ${BOX.h - 20} a ${BOX.w / 2} 10 0 0 1 -${BOX.w} 0 z`} />
                    <path className="ca-arch-shape-line" d={`M 0 10 a ${BOX.w / 2} 10 0 0 0 ${BOX.w} 0`} />
                </>
            ) : (
                <rect className="ca-arch-shape" width={BOX.w} height={BOX.h} rx={n.kind === 'actor' ? BOX.h / 2 : n.type === 'service' ? 20 : n.type === 'layer' ? 4 : 12} />
            )}
            {n.kind === 'part' ? <rect className="ca-arch-accent" x={0} y={8} width={4} height={BOX.h - 16} rx={2} /> : null}
            <text className="ca-arch-label" x={BOX.w / 2} y={BOX.h / 2 - 7} textAnchor="middle" dominantBaseline="central">
                {n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label}
            </text>
            <text className="ca-arch-sub" x={BOX.w / 2} y={BOX.h / 2 + 12} textAnchor="middle" dominantBaseline="central">
                {sub}
            </text>
        </g>
    );
}

