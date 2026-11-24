/**
 * A small, consistent icon set for the UI: 24-unit grid, 1.75 stroke, round
 * joins, drawn in `currentColor` so icons follow the theme (VS Code's, or
 * light/dark on the web). Decorative by default (aria-hidden); a button that
 * shows only an icon carries its own aria-label.
 */
import type { ReactNode } from 'react';

export type IconName =
    | 'sparkles'
    | 'send'
    | 'stop'
    | 'plus'
    | 'sliders'
    | 'chat'
    | 'target'
    | 'copy'
    | 'check'
    | 'alert'
    | 'key'
    | 'lock'
    | 'layers'
    | 'code'
    | 'laptop'
    | 'cloud'
    | 'refresh'
    | 'close'
    | 'info'
    | 'chevron'
    | 'shield'
    | 'user'
    | 'gauge'
    | 'file'
    | 'boxes'
    | 'trash'
    | 'retry'
    | 'flow'
    | 'terminal'
    | 'clock'
    | 'bolt'
    | 'database'
    | 'globe'
    | 'play'
    | 'external'
    | 'map';

const PATHS: Record<IconName, ReactNode> = {
    sparkles: (
        <>
            <path d="M11 3.5 12.7 8.3 17.5 10l-4.8 1.7L11 16.5 9.3 11.7 4.5 10l4.8-1.7z" />
            <path d="M18 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />
        </>
    ),
    send: <path d="M12 19.5v-15M5.5 11 12 4.5 18.5 11" />,
    stop: <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />,
    plus: <path d="M12 5v14M5 12h14" />,
    sliders: (
        <>
            <path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1" />
            <circle cx="15" cy="7" r="2" />
            <circle cx="9" cy="12" r="2" />
            <circle cx="17" cy="17" r="2" />
        </>
    ),
    chat: <path d="M20.5 11.5a8 8 0 0 1-11.7 7.1L4 19.5l.9-4.4A8 8 0 1 1 20.5 11.5z" />,
    target: (
        <>
            <circle cx="12" cy="12" r="7.5" />
            <circle cx="12" cy="12" r="2.5" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
        </>
    ),
    copy: (
        <>
            <rect x="9" y="9" width="11" height="11" rx="2.2" />
            <path d="M5.5 15H5a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 5 3.5h8.5A1.5 1.5 0 0 1 15 5v.5" />
        </>
    ),
    check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
    alert: <path d="M12 3.5 21.5 20h-19zM12 10v4.5M12 17.2v.1" />,
    key: (
        <>
            <circle cx="8" cy="15.5" r="4" />
            <path d="m11 12.5 8.5-8.5M16.5 7l2.5 2.5M14.5 9l1.8 1.8" />
        </>
    ),
    lock: (
        <>
            <rect x="5" y="10.5" width="14" height="10" rx="2.2" />
            <path d="M8.5 10.5V7.8a3.5 3.5 0 0 1 7 0v2.7" />
        </>
    ),
    layers: <path d="m12 3.5 9 4.8-9 4.8-9-4.8zM3 12.8l9 4.8 9-4.8M3 16.8l9 4.7 9-4.7" />,
    code: <path d="m8.5 7.5-5 4.5 5 4.5M15.5 7.5l5 4.5-5 4.5M13.5 5l-3 14" />,
    laptop: <path d="M4.5 6a1.5 1.5 0 0 1 1.5-1.5h12A1.5 1.5 0 0 1 19.5 6v9h-15zM2.5 18.5h19" />,
    cloud: <path d="M7 18.5a4.5 4.5 0 0 1-.5-9 6 6 0 0 1 11.4 1.3A3.9 3.9 0 0 1 17.5 18.5z" />,
    refresh: <path d="M20 12a8 8 0 1 1-2.4-5.7M20 4.5V9h-4.5" />,
    close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
    info: (
        <>
            <circle cx="12" cy="12" r="8.5" />
            <path d="M12 11v5.5M12 7.8v.1" />
        </>
    ),
    chevron: <path d="m9 6 6 6-6 6" />,
    shield: <path d="M12 3.5 19.5 6v5.5c0 4.6-3.2 8-7.5 9-4.3-1-7.5-4.4-7.5-9V6z" />,
    user: (
        <>
            <circle cx="12" cy="8.5" r="3.8" />
            <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
        </>
    ),
    gauge: <path d="M4 17.5a8 8 0 1 1 16 0M12 17.5l3.5-5.5" />,
    file: <path d="M6.5 3.5h7l4 4v13h-11zM13.5 3.5v4h4" />,
    boxes: <path d="m12 3.5 8 4.5v8L12 20.5 4 16V8zM4 8l8 4.5L20 8M12 12.5v8" />,
    trash: <path d="M5 7h14M9.5 7V5h5v2M7 7l.8 12.5h8.4L17 7" />,
    retry: <path d="M4 12a8 8 0 1 0 2.4-5.7M4 4.5V9h4.5" />,
    flow: (
        <>
            <circle cx="6" cy="6" r="2.5" />
            <circle cx="18" cy="18" r="2.5" />
            <path d="M8.5 6H14a3.5 3.5 0 0 1 0 7h-4a3.5 3.5 0 0 0 0 7h5.5" />
        </>
    ),
    terminal: (
        <>
            <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
            <path d="m7.5 9.5 3 2.5-3 2.5M12.5 15h4" />
        </>
    ),
    clock: (
        <>
            <circle cx="12" cy="12" r="8.5" />
            <path d="M12 7.5V12l3 2" />
        </>
    ),
    bolt: <path d="M13 3.5 5.5 13.5H12l-1 7 7.5-10H12z" />,
    database: (
        <>
            <ellipse cx="12" cy="6" rx="7" ry="2.5" />
            <path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" />
        </>
    ),
    globe: (
        <>
            <circle cx="12" cy="12" r="8.5" />
            <path d="M3.5 12h17M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5S9.7 5.9 12 3.5z" />
        </>
    ),
    play: <path d="M8 5.5v13l10-6.5z" />,
    external: <path d="M13.5 4.5h6v6M19.5 4.5 11 13M17.5 14v4.5a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18.5V8.5A1.5 1.5 0 0 1 6 7h4.5" />,
    map: <path d="m3.5 6.5 5.5-2 6 2 5.5-2v13l-5.5 2-6-2-5.5 2zM9 4.5v13M15 6.5v13" />,
};

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
    return (
        <svg
            className={`ca-icon${className ? ` ${className}` : ''}`}
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
        >
            {PATHS[name]}
        </svg>
    );
}
