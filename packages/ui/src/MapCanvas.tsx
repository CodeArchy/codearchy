/**
 * The Map canvas: React Flow over a laid-out MapModel, on one persistent
 * canvas. Expanding or collapsing never opens a new canvas: nodes glide from
 * their old to their new positions, an expanding node grows into its
 * container while its children fade in, and the viewport follows.
 *
 * Selection traces flow: the selected node's own dependencies are animated
 * (in the direction of the dependency) and coloured by role (uses / used
 * by), its neighbours stay bright and everything else fades. Hovering
 * previews the same without fading.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { AUTHORSHIP_ORIGINS, flowRoles, lensBadge, type FlowRoles, type LensId, type MapEdge, type MapModel, type MapNode } from './model.js';
import type { AuthorshipOrigin } from '@codearchy/protocol';
import type { Box, Layout } from './layout.js';

interface NodeData extends Record<string, unknown> {
    node: MapNode;
    dim: boolean;
    lens: LensId;
    entering: boolean;
    role?: 'selected' | 'neighbour';
    onToggle?: () => void;
}

type CardNode = Node<NodeData>;

const KIND_LABEL: Record<string, string> = { system: 'System', package: 'Package', component: 'Component', module: 'File', symbol: 'Symbol' };

/** Small line icons by kind (inherit the text colour). */
function KindIcon({ kind, virtual }: { kind: string; virtual?: boolean }) {
    const common = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
    if (virtual)
        return (
            <svg {...common}>
                <circle cx="8" cy="8" r="5.5" strokeDasharray="2.2 2" />
                <circle cx="8" cy="8" r="1.6" />
            </svg>
        );
    if (kind === 'package')
        return (
            <svg {...common}>
                <path d="M8 1.8 14 5v6L8 14.2 2 11V5z" />
                <path d="M2 5l6 3.2L14 5M8 8.2v6" />
            </svg>
        );
    if (kind === 'module')
        return (
            <svg {...common}>
                <path d="M4 1.8h5.5L12.5 5v9.2H4z" />
                <path d="M9.5 1.8V5h3" />
            </svg>
        );
    return (
        <svg {...common}>
            <rect x="2" y="2.5" width="12" height="4" rx="1.2" />
            <rect x="2" y="9.5" width="12" height="4" rx="1.2" />
        </svg>
    );
}

/** Lines by authorship origin as one thin stacked bar (the badge's text carries the numbers). */
export function AuthorshipBar({ shares }: { shares: Record<AuthorshipOrigin, number> }) {
    return (
        <div className="ca-authorship-bar" aria-hidden="true">
            {AUTHORSHIP_ORIGINS.map(({ origin }) => (shares[origin] ? <span key={origin} className={`ca-auth-${origin}`} style={{ width: `${shares[origin]}%` }} /> : null))}
        </div>
    );
}

const NodeCard = memo(function NodeCard({ data, selected }: NodeProps<CardNode>) {
    const v = data.node.view!;
    const badge = lensBadge(v.metrics, data.lens, v.kind, v.authorship, v.owner);
    const classes = [
        'ca-node',
        `ca-kind-${v.kind}`,
        v.virtual ? 'ca-virtual' : '',
        selected ? 'ca-selected' : '',
        data.role === 'neighbour' ? 'ca-neighbour' : '',
        data.dim ? 'ca-dim' : '',
        data.entering ? 'ca-entering' : '',
        badge?.level ? `ca-level-${badge.level}` : '',
    ];
    return (
        <div className={classes.filter(Boolean).join(' ')} title={v.path || v.name}>
            <Handle type="target" position={Position.Left} className="ca-handle" />
            <div className="ca-node-head">
                <span className="ca-node-kind">
                    <KindIcon kind={v.kind} virtual={v.virtual} />
                    {v.virtual ? 'Group' : KIND_LABEL[v.kind] ?? v.kind}
                </span>
                {v.role ? <span className="ca-chip">{v.role}</span> : null}
            </div>
            <div className="ca-node-name">{v.name}</div>
            {badge ? (
                <div className={`ca-lens-badge${badge.shares ? ' ca-lens-badge-bar' : ''}`} title={badge.title}>
                    <span>{badge.text}</span>
                    {/* On the badge's own row, so the card keeps the height the layout gave it. */}
                    {badge.shares ? <AuthorshipBar shares={badge.shares} /> : null}
                </div>
            ) : null}
            <div className="ca-node-meta">
                {v.kind === 'module' ? <span>{v.fanIn + v.fanOut ? `${v.fanOut} out · ${v.fanIn} in` : 'no dependencies here'}</span> : <span>{v.modules.toLocaleString()} file{v.modules === 1 ? '' : 's'}</span>}
                {v.hasChildren && data.onToggle ? (
                    <button
                        type="button"
                        className="ca-expand nodrag"
                        title="Expand here (double-click)"
                        aria-label={`Expand ${v.name}`}
                        onClick={(e) => {
                            e.stopPropagation();
                            data.onToggle!();
                        }}
                    >
                        +
                    </button>
                ) : null}
            </div>
            <Handle type="source" position={Position.Right} className="ca-handle" />
        </div>
    );
});

const ContainerFrame = memo(function ContainerFrame({ data, selected }: NodeProps<CardNode>) {
    const v = data.node.view!;
    return (
        <div className={`ca-container${selected ? ' ca-selected' : ''}${data.dim ? ' ca-dim' : ''}${data.role === 'neighbour' ? ' ca-neighbour' : ''}`}>
            <div className="ca-container-head" title="Double-click to collapse">
                <span className="ca-node-kind">
                    <KindIcon kind={v.kind} virtual={v.virtual} />
                </span>
                <span className="ca-node-name">{v.name}</span>
                <span className="ca-node-meta">{v.modules.toLocaleString()} files</span>
                <button
                    type="button"
                    className="ca-expand nodrag"
                    title="Collapse"
                    aria-label={`Collapse ${v.name}`}
                    onClick={(e) => {
                        e.stopPropagation();
                        data.onToggle?.();
                    }}
                >
                    −
                </button>
            </div>
        </div>
    );
});

const ExternalNode = memo(function ExternalNode({ data, selected }: NodeProps<CardNode>) {
    return (
        <div className={`ca-external${selected ? ' ca-selected' : ''}${data.dim ? ' ca-dim' : ''}${data.entering ? ' ca-entering' : ''}`} title="Outside this view">
            <Handle type="target" position={Position.Left} className="ca-handle" />
            <span aria-hidden>↗</span> {data.node.label}
            <Handle type="source" position={Position.Right} className="ca-handle" />
        </div>
    );
});

const NODE_TYPES = { node: NodeCard, container: ContainerFrame, external: ExternalNode };

/** Where the viewport should go once the current transition settles. */
export interface FocusRequest {
    /** A node to bring into view, or undefined for the whole map. */
    key?: string;
    nonce: number;
}

export interface MapCanvasProps {
    model: MapModel;
    /** The edges to draw (a subset of model.edges when the view is dense). */
    edges: MapEdge[];
    layout: Layout;
    selected?: string;
    selectedEdge?: string;
    /** 2 = focus mode (neighbours of neighbours stay bright). */
    hops: number;
    lens: LensId;
    focus?: FocusRequest;
    onSelect(id: string | undefined): void;
    onActivate(id: string): void;
    onToggle(id: string): void;
    onSelectEdge(source: string, target: string): void;
}

const DURATION = 420;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerp = (a: Box, b: Box, k: number): Box => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, width: a.width + (b.width - a.width) * k, height: a.height + (b.height - a.height) * k });
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Glides boxes from what is on screen to `layout`. Nodes that weren't on
 * screen before are reported as entering (they fade in); everything else moves.
 */
function useTransition(layout: Layout, ids: string[], onSettled: () => void): { boxes: Layout; entering: Set<string> } {
    const [boxes, setBoxes] = useState<Layout>(layout);
    const [entering, setEntering] = useState<Set<string>>(new Set());
    const shown = useRef<Layout>(layout);
    const known = useRef<Set<string>>(new Set(ids));
    const settled = useRef(onSettled);
    settled.current = onSettled;

    useEffect(() => {
        const fresh = ids.filter((id) => !known.current.has(id));
        known.current = new Set(ids);
        setEntering(new Set(fresh));
        const from = shown.current;
        if (reducedMotion() || from === layout) {
            shown.current = layout;
            setBoxes(layout);
            settled.current();
            return;
        }
        let raf = 0;
        const start = performance.now();
        const frame = (now: number) => {
            const k = Math.min(1, (now - start) / DURATION);
            const e = ease(k);
            const next: Layout = new Map();
            for (const [id, to] of layout) next.set(id, lerp(from.get(id) ?? to, to, e));
            shown.current = next;
            setBoxes(next);
            if (k < 1) raf = requestAnimationFrame(frame);
            else {
                shown.current = layout;
                setEntering(new Set());
                settled.current();
            }
        };
        raf = requestAnimationFrame(frame);
        return () => cancelAnimationFrame(raf);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [layout]);

    return { boxes, entering };
}

export function MapCanvas(props: MapCanvasProps) {
    const { model, selected, selectedEdge, lens, hops } = props;
    const flow = useReactFlow();
    const [hovered, setHovered] = useState<string>();
    const pendingFocus = useRef<FocusRequest | undefined>(undefined);
    const lastFocus = useRef(0);
    const mounted = useRef(false);

    // A focus request runs when the transition it belongs to settles.
    if (props.focus && props.focus.nonce !== lastFocus.current) {
        lastFocus.current = props.focus.nonce;
        pendingFocus.current = props.focus;
    }

    const ids = useMemo(() => model.nodes.map((n) => n.id), [model]);
    const { boxes, entering } = useTransition(props.layout, ids, () => {
        const f = pendingFocus.current;
        if (!f || !mounted.current) return;
        pendingFocus.current = undefined;
        const duration = reducedMotion() ? 0 : 500;
        // Let React Flow apply the final positions before fitting to them.
        requestAnimationFrame(() => {
            if (f.key && model.nodes.some((n) => n.id === f.key)) {
                void flow.fitView({ nodes: [{ id: f.key }], duration, padding: 0.3, maxZoom: 1.1 });
            } else {
                void flow.fitView({ duration, padding: 0.15, maxZoom: 1.1, minZoom: 0.35 });
            }
        });
    });

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    // Selection lights the flow; a hover previews it without fading anything.
    const roles: FlowRoles | undefined = useMemo(() => (selected ? flowRoles(model, selected, hops) : undefined), [model, selected, hops]);
    const preview: FlowRoles | undefined = useMemo(() => (!selected && hovered ? flowRoles(model, hovered, 1) : undefined), [model, selected, hovered]);

    const nodes = useMemo<CardNode[]>(
        () =>
            model.nodes.map((n) => {
                const box = boxes.get(n.id) ?? { x: 0, y: 0, width: n.width, height: n.height };
                const role = roles ? (roles.selected.has(n.id) ? 'selected' : roles.lit.has(n.id) ? 'neighbour' : undefined) : undefined;
                return {
                    id: n.id,
                    type: n.type,
                    position: { x: box.x, y: box.y },
                    ...(n.parent ? { parentId: n.parent } : {}),
                    selected: n.id === selected,
                    // Explicit sizes count as measured: without them React Flow hides each
                    // re-created node until it measures it, and clicks land on the pane.
                    width: box.width,
                    height: box.height,
                    style: { width: box.width, height: box.height },
                    data: {
                        node: n,
                        dim: !!roles && !roles.lit.has(n.id),
                        lens,
                        entering: entering.has(n.id),
                        ...(role ? { role } : {}),
                        onToggle: () => props.onToggle(n.id),
                    },
                    // No zIndex for containers: React Flow already draws children above their
                    // parent, and a negative zIndex would put the container under the pane (its
                    // header would stop receiving clicks).
                };
            }),
        // Callbacks are stable per CodeArchyMap render; the model, boxes and selection drive this.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [model, boxes, roles, selected, lens, entering]
    );

    const edges = useMemo<Edge[]>(
        () =>
            props.edges.map((e) => {
                const r = roles ?? preview;
                const role = r ? (r.out.has(e.id) ? 'out' : r.in.has(e.id) ? 'in' : r.internal.has(e.id) ? 'internal' : undefined) : undefined;
                const faded = !!roles && !role;
                const isSelected = e.id === selectedEdge;
                const classes = [
                    'ca-edge',
                    e.port ? 'ca-edge-port' : '',
                    e.implicit ? 'ca-edge-implicit' : '',
                    e.cyclic && lens === 'health' ? 'ca-edge-cyclic' : '',
                    role ? `ca-edge-${role}` : '',
                    faded ? 'ca-faded' : '',
                    isSelected ? 'ca-edge-selected' : '',
                ];
                return {
                    id: e.id,
                    source: e.source,
                    target: e.target,
                    type: 'smoothstep',
                    pathOptions: { borderRadius: 10, offset: 18 },
                    // The selection's own dependencies flow, in the dependency's direction.
                    animated: !!roles && !!role,
                    label: (role || isSelected) && e.count > 1 ? String(e.count) : undefined,
                    selected: isSelected,
                    // Lines pass behind cards; the flow stands out by colour, weight and motion.
                    className: classes.filter(Boolean).join(' '),
                    style: { strokeWidth: role ? Math.max(2, e.strokeWidth) : e.strokeWidth },
                    markerEnd: {
                        type: MarkerType.ArrowClosed,
                        width: 14,
                        height: 14,
                        ...(role === 'out' ? { color: 'var(--ca-flow-out)' } : role === 'in' ? { color: 'var(--ca-flow-in)' } : {}),
                    },
                    interactionWidth: 14,
                };
            }),
        [props.edges, roles, preview, selectedEdge, lens]
    );

    return (
        <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            fitView
            fitViewOptions={{ padding: 0.15, maxZoom: 1.1, minZoom: 0.35 }}
            minZoom={0.1}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            // Double-click expands in place; d3-zoom would otherwise swallow it.
            zoomOnDoubleClick={false}
            proOptions={{ hideAttribution: true }}
            onNodeClick={(_, n) => props.onSelect(n.id)}
            onNodeDoubleClick={(_, n) => props.onActivate(n.id)}
            onNodeMouseEnter={(_, n) => setHovered(n.id)}
            onNodeMouseLeave={() => setHovered(undefined)}
            onEdgeClick={(_, e) => props.onSelectEdge(e.source, e.target)}
            onPaneClick={() => props.onSelect(undefined)}
        >
            <Background gap={24} size={1} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable className="ca-minimap" />
        </ReactFlow>
    );
}
