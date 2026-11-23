/**
 * The Map canvas: React Flow over a laid-out MapModel. Click selects,
 * double-click drills, the ⊕ chip expands in place, edges explain on click.
 * Everything outside the selection's neighbourhood is dimmed.
 */
import { memo, useMemo } from 'react';
import { Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import type { MapEdge, MapModel, MapNode } from './model.js';
import type { Layout } from './layout.js';

interface NodeData extends Record<string, unknown> {
    node: MapNode;
    dim: boolean;
    onExpand?: () => void;
    onCollapse?: () => void;
}

type CardNode = Node<NodeData>;

const KIND_LABEL: Record<string, string> = { system: 'System', package: 'Package', component: 'Component', module: 'File', symbol: 'Symbol' };

const NodeCard = memo(function NodeCard({ data, selected }: NodeProps<CardNode>) {
    const v = data.node.view!;
    return (
        <div className={`ca-node ca-kind-${v.kind}${v.virtual ? ' ca-virtual' : ''}${selected ? ' ca-selected' : ''}${data.dim ? ' ca-dim' : ''}`} title={v.path || v.name}>
            <Handle type="target" position={Position.Left} className="ca-handle" />
            <div className="ca-node-head">
                <span className="ca-node-kind">{v.virtual ? 'Group' : KIND_LABEL[v.kind] ?? v.kind}</span>
                {v.role ? <span className="ca-chip">{v.role}</span> : null}
            </div>
            <div className="ca-node-name">{v.name}</div>
            <div className="ca-node-meta">
                {v.kind === 'module' ? null : <span>{v.modules.toLocaleString()} file{v.modules === 1 ? '' : 's'}</span>}
                {v.hasChildren && data.onExpand ? (
                    <button
                        type="button"
                        className="ca-expand nodrag"
                        title="Expand in place (Space)"
                        aria-label={`Expand ${v.name}`}
                        onClick={(e) => {
                            e.stopPropagation();
                            data.onExpand!();
                        }}
                    >
                        ⊕
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
        <div className={`ca-container${selected ? ' ca-selected' : ''}${data.dim ? ' ca-dim' : ''}`}>
            <div className="ca-container-head">
                <span className="ca-node-name">{v.name}</span>
                <span className="ca-node-meta">{v.modules.toLocaleString()} files</span>
                <button
                    type="button"
                    className="ca-expand nodrag"
                    title="Collapse"
                    aria-label={`Collapse ${v.name}`}
                    onClick={(e) => {
                        e.stopPropagation();
                        data.onCollapse?.();
                    }}
                >
                    ⊖
                </button>
            </div>
        </div>
    );
});

const ExternalNode = memo(function ExternalNode({ data, selected }: NodeProps<CardNode>) {
    return (
        <div className={`ca-external${selected ? ' ca-selected' : ''}${data.dim ? ' ca-dim' : ''}`} title="Outside this view">
            <Handle type="target" position={Position.Left} className="ca-handle" />
            <span aria-hidden>↗</span> {data.node.label}
            <Handle type="source" position={Position.Right} className="ca-handle" />
        </div>
    );
});

const NODE_TYPES = { node: NodeCard, container: ContainerFrame, external: ExternalNode };

export interface MapCanvasProps {
    model: MapModel;
    /** The edges to draw (a subset of model.edges when the view is dense). */
    edges: MapEdge[];
    layout: Layout;
    /** Changes when the frontier changes, so the canvas re-fits. */
    frontierHash: string;
    selected?: string;
    selectedEdge?: string;
    /** When set, nodes outside it are dimmed. */
    lit?: Set<string>;
    onSelect(id: string | undefined): void;
    onActivate(id: string): void;
    onExpand(id: string): void;
    onCollapse(id: string): void;
    onSelectEdge(source: string, target: string): void;
}

export function MapCanvas(props: MapCanvasProps) {
    const { model, layout, lit, selected, selectedEdge } = props;

    const nodes = useMemo<CardNode[]>(
        () =>
            model.nodes.map((n) => {
                const box = layout.get(n.id) ?? { x: 0, y: 0, width: n.width, height: n.height };
                return {
                    id: n.id,
                    type: n.type,
                    position: { x: box.x, y: box.y },
                    ...(n.parent ? { parentId: n.parent } : {}),
                    selected: n.id === selected,
                    // Explicit sizes (from the layout) count as measured: without them React
                    // Flow hides every re-created node until it measures it again, and a
                    // double-click's second press lands on the pane instead.
                    width: box.width,
                    height: box.height,
                    style: { width: box.width, height: box.height },
                    data: {
                        node: n,
                        dim: !!lit && !lit.has(n.id),
                        onExpand: () => props.onExpand(n.id),
                        onCollapse: () => props.onCollapse(n.id),
                    },
                    ...(n.type === 'container' ? { selectable: true, zIndex: -1 } : {}),
                };
            }),
        // Callbacks are stable per CodeArchyMap render; the model/layout/selection drive this.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [model, layout, lit, selected]
    );

    const edges = useMemo<Edge[]>(
        () =>
            props.edges.map((e) => {
                const dim = !!lit && !(lit.has(e.source) && lit.has(e.target));
                const isSelected = e.id === selectedEdge;
                return {
                    id: e.id,
                    source: e.source,
                    target: e.target,
                    type: 'smoothstep',
                    label: e.count > 1 ? String(e.count) : undefined,
                    selected: isSelected,
                    className: `ca-edge${e.port ? ' ca-edge-port' : ''}${e.implicit ? ' ca-edge-implicit' : ''}${dim ? ' ca-dim' : ''}${isSelected ? ' ca-edge-selected' : ''}`,
                    style: { strokeWidth: e.strokeWidth },
                    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
                    interactionWidth: 14,
                };
            }),
        [props.edges, lit, selectedEdge]
    );

    return (
        <ReactFlow
            key={props.frontierHash}
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            fitView
            fitViewOptions={{ padding: 0.15, maxZoom: 1.2, minZoom: 0.35 }}
            minZoom={0.1}
            // Double-click drills in. d3-zoom would otherwise swallow the event
            // (it stops propagation before React's root listener sees it).
            zoomOnDoubleClick={false}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            proOptions={{ hideAttribution: true }}
            onNodeClick={(_, n) => props.onSelect(n.id)}
            onNodeDoubleClick={(_, n) => props.onActivate(n.id)}
            onEdgeClick={(_, e) => props.onSelectEdge(e.source, e.target)}
            onPaneClick={() => props.onSelect(undefined)}
        >
            <Background gap={24} size={1} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable className="ca-minimap" />
        </ReactFlow>
    );
}
