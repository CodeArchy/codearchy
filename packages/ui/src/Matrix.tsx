/**
 * Dependency structure matrix (DSM) of the current view: rows depend on
 * columns. Providers come first, so ordinary dependencies sit below the
 * diagonal; cells above it are feedback, which only happens inside a cycle
 * (marked ⟳). A matrix stays readable at hundreds of rows, where a node-link
 * diagram turns into a hairball.
 *
 * Cells grow to fill the canvas (small views get big, labelled cells;
 * large ones shrink to stay scannable), and the weight is written in a cell
 * once there's room for it.
 *
 * Only non-empty cells are rendered (absolutely positioned over a CSS grid),
 * so a few hundred rows stay cheap. Values are in each cell's tooltip and
 * accessible label; colour is a sequential ramp by weight.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { View } from '@codearchy/protocol';
import { heatStep, matrixOrder } from './model.js';

export interface MatrixProps {
    view: View;
    selected?: string;
    selectedEdge?: string;
    onSelect(key: string): void;
    onActivate(key: string): void;
    onSelectEdge(source: string, target: string): void;
}

export function Matrix(props: MatrixProps) {
    const { view } = props;
    const order = useMemo(() => matrixOrder(view), [view]);
    const [hover, setHover] = useState<{ row: number; col: number }>();
    const n = order.keys.length;
    const wrap = useRef<HTMLDivElement>(null);
    const [box, setBox] = useState({ width: 0, height: 0 });
    useEffect(() => {
        const el = wrap.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(([e]) => e && setBox({ width: e.contentRect.width, height: e.contentRect.height }));
        ro.observe(el);
        return () => ro.disconnect();
    }, [n === 0]); // eslint-disable-line react-hooks/exhaustive-deps
    const nameOfKey = (k: string) => view.nodes.find((x) => x.key === k)?.name ?? k;
    const longest = Math.max(4, ...order.keys.map((k) => nameOfKey(k).length));
    const labelWidth = Math.min(280, Math.max(120, longest * 7.2 + 28));
    const headerHeight = Math.min(180, Math.max(80, longest * 6.6 + 16));
    const cell = matrixCell(n, box.width - labelWidth - 24, box.height - headerHeight - 72);
    const font = Math.max(10, Math.min(13, Math.round(cell * 0.32)));
    const indexOf = useMemo(() => new Map(order.keys.map((k, i) => [k, i])), [order]);
    const nameOf = useMemo(() => new Map(view.nodes.map((x) => [x.key, x.name])), [view]);
    const max = Math.max(1, ...view.edges.map((e) => e.weight));

    if (n === 0) return <div className="ca-status">Nothing to show here.</div>;

    const cells = view.edges
        .map((e) => ({ e, row: indexOf.get(e.source), col: indexOf.get(e.target) }))
        .filter((c): c is { e: (typeof view.edges)[number]; row: number; col: number } => c.row !== undefined && c.col !== undefined);
    const feedback = cells.filter((c) => c.col > c.row).length;

    return (
        <div className="ca-matrix-wrap" ref={wrap} style={{ ['--ca-matrix-font' as string]: `${font}px` }}>
            <p className="ca-muted ca-matrix-legend">
                Rows depend on columns. Below the diagonal: dependencies on earlier (lower-level) items. Above it: feedback, only inside a cycle
                {feedback ? ` (⟳ ${feedback} cell${feedback === 1 ? '' : 's'})` : ' (none here)'}. Darker means more dependencies.
            </p>
            <div className="ca-matrix" style={{ width: labelWidth + n * cell, height: headerHeight + n * cell }} role="grid" aria-rowcount={n} aria-colcount={n}>
                {order.keys.map((k, i) => (
                    <button
                        key={`c${k}`}
                        type="button"
                        className={`ca-matrix-col${hover?.col === i ? ' ca-hover' : ''}${props.selected === k ? ' ca-selected' : ''}`}
                        style={{ left: labelWidth + i * cell, width: cell, height: headerHeight }}
                        title={nameOf.get(k)}
                        onClick={() => props.onSelect(k)}
                        onDoubleClick={() => props.onActivate(k)}
                    >
                        <span>{nameOf.get(k)}</span>
                    </button>
                ))}
                {order.keys.map((k, i) => (
                    <button
                        key={`r${k}`}
                        type="button"
                        className={`ca-matrix-row${hover?.row === i ? ' ca-hover' : ''}${props.selected === k ? ' ca-selected' : ''}`}
                        style={{ top: headerHeight + i * cell, width: labelWidth, height: cell }}
                        title={nameOf.get(k)}
                        data-key={k}
                        onClick={() => props.onSelect(k)}
                        onDoubleClick={() => props.onActivate(k)}
                    >
                        {order.cycleOf.has(k) ? <span className="ca-cycle-mark" aria-label="in a cycle">⟳ </span> : null}
                        {nameOf.get(k)}
                    </button>
                ))}
                <div
                    className="ca-matrix-grid"
                    style={{ left: labelWidth, top: headerHeight, width: n * cell, height: n * cell, backgroundSize: `${cell}px ${cell}px` }}
                    onMouseLeave={() => setHover(undefined)}
                >
                    {order.keys.map((k, i) => (
                        <div key={`d${k}`} className="ca-matrix-diag" style={{ left: i * cell, top: i * cell, width: cell, height: cell }} aria-hidden />
                    ))}
                    {cells.map(({ e, row, col }) => {
                        const id = `${e.source}->${e.target}`;
                        const isFeedback = col > row;
                        const label = `${nameOf.get(e.source)} depends on ${nameOf.get(e.target)}: weight ${e.weight}, ${e.count} file dependenc${e.count === 1 ? 'y' : 'ies'}${isFeedback ? ', feedback in a cycle' : ''}`;
                        return (
                            <button
                                key={id}
                                type="button"
                                className={`ca-matrix-cell ca-heat-${heatStep(e.weight, max)}${isFeedback ? ' ca-feedback' : ''}${props.selectedEdge === id ? ' ca-selected' : ''}`}
                                style={{ left: col * cell, top: row * cell, width: cell, height: cell }}
                                title={label}
                                aria-label={label}
                                data-edge={id}
                                onMouseEnter={() => setHover({ row, col })}
                                onClick={() => props.onSelectEdge(e.source, e.target)}
                            >
                                {cell >= 30 ? <span aria-hidden="true">{e.weight}</span> : null}
                            </button>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}

/** Cell size that fits `n` rows into the space available, within readable bounds. */
export function matrixCell(n: number, width: number, height: number): number {
    if (n <= 0) return 26;
    const fallback = n > 80 ? 12 : n > 40 ? 18 : 26;
    if (!(width > 0 && height > 0)) return fallback;
    const fit = Math.floor(Math.min(width, Math.max(height, width * 0.6)) / n);
    return Math.max(n > 80 ? 10 : 14, Math.min(64, fit));
}
