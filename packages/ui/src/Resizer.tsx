/**
 * Resizable panels: a drag handle between two panes (pointer or keyboard),
 * with each width remembered per viewer. Double-click resets the default.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

const STORE = 'codearchy.layout';

function readSizes(): Record<string, number> {
    try {
        const raw = JSON.parse(globalThis.localStorage?.getItem(STORE) ?? '{}') as unknown;
        return raw && typeof raw === 'object' ? (raw as Record<string, number>) : {};
    } catch {
        return {};
    }
}

function writeSize(key: string, value: number): void {
    try {
        globalThis.localStorage?.setItem(STORE, JSON.stringify({ ...readSizes(), [key]: Math.round(value) }));
    } catch {
        // storage blocked: the width just isn't remembered
    }
}

export interface PanelSize {
    size: number;
    set(size: number): void;
    reset(): void;
    min: number;
    max: number;
    initial: number;
}

/** A panel width in px, clamped to [min, max] and remembered under `key`. */
export function usePanelSize(key: string, initial: number, min: number, max: number): PanelSize {
    const clamp = useCallback((n: number) => Math.min(max, Math.max(min, n)), [min, max]);
    const [size, setSize] = useState(() => {
        const saved = readSizes()[key];
        return typeof saved === 'number' && Number.isFinite(saved) ? clamp(saved) : initial;
    });
    const timer = useRef<ReturnType<typeof setTimeout>>();
    const set = useCallback(
        (n: number) => {
            const v = clamp(n);
            setSize(v);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => writeSize(key, v), 200);
        },
        [clamp, key]
    );
    useEffect(() => () => clearTimeout(timer.current), []);
    return { size, set, reset: () => set(initial), min, max, initial };
}

export interface ResizerProps {
    panel: PanelSize;
    /** Which side of the handle the panel is on: dragging away from it grows the panel. */
    side: 'left' | 'right';
    label: string;
    className?: string;
}

export function Resizer({ panel, side, label, className }: ResizerProps) {
    const drag = useRef<{ x: number; size: number }>();
    const [active, setActive] = useState(false);
    const sign = side === 'left' ? 1 : -1;

    const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, size: panel.size };
        setActive(true);
    };
    const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
        if (!drag.current) return;
        panel.set(drag.current.size + sign * (e.clientX - drag.current.x));
    };
    const end = (e: PointerEvent<HTMLDivElement>) => {
        if (!drag.current) return;
        drag.current = undefined;
        setActive(false);
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    };
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        const step = e.shiftKey ? 64 : 16;
        if (e.key === 'ArrowLeft') panel.set(panel.size - sign * step);
        else if (e.key === 'ArrowRight') panel.set(panel.size + sign * step);
        else if (e.key === 'Home') panel.set(panel.min);
        else if (e.key === 'End') panel.set(panel.max);
        else if (e.key === 'Enter') panel.reset();
        else return;
        e.preventDefault();
        e.stopPropagation();
    };

    return (
        <div
            className={`ca-resizer ca-resizer-${side}${active ? ' ca-active' : ''}${className ? ` ${className}` : ''}`}
            role="separator"
            aria-orientation="vertical"
            aria-label={label}
            aria-valuenow={Math.round(panel.size)}
            aria-valuemin={panel.min}
            aria-valuemax={panel.max}
            tabIndex={0}
            title={`${label}: drag to resize, double-click to reset`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={end}
            onPointerCancel={end}
            onDoubleClick={panel.reset}
            onKeyDown={onKeyDown}
        />
    );
}
