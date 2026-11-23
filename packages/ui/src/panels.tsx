/** Navigator (hierarchy tree), Inspector (selection details), breadcrumb and search. */
import { useEffect, useRef, useState } from 'react';
import type { EdgeExplanation, NodeDetails, NodeLink, NodeSummary } from '@codearchy/protocol';
import type { EngineClient, HostActions, SearchResult } from './client.js';
import { lensBadge, type LensId } from './model.js';

const KIND_TITLE: Record<string, string> = { system: 'System', package: 'Package', component: 'Component', module: 'File', symbol: 'Symbol' };

// ─── Breadcrumb ─────────────────────────────────────────────────────────────

export function Breadcrumb(props: { items: Array<{ key: string; name: string }>; onGo(key: string): void }) {
    return (
        <nav className="ca-breadcrumb" aria-label="Breadcrumb">
            {props.items.map((b, i) => (
                <span key={b.key}>
                    {i > 0 ? <span className="ca-sep" aria-hidden> › </span> : null}
                    {i === props.items.length - 1 ? (
                        <strong aria-current="page">{b.name}</strong>
                    ) : (
                        <button type="button" className="ca-link" onClick={() => props.onGo(b.key)}>
                            {b.name}
                        </button>
                    )}
                </span>
            ))}
        </nav>
    );
}

// ─── Navigator ──────────────────────────────────────────────────────────────

export interface NavigatorProps {
    client: EngineClient;
    /** Changes when another workspace is loaded: the tree resets. */
    revision: string;
    /** Changes when the data changes: loaded children refresh, open folders stay open. */
    dataVersion: number;
    /** Keys on the path to the current scope (highlighted and opened). */
    path: string[];
    selected?: string;
    onReveal(key: string): void;
    onDrill(key: string): void;
}

export function Navigator(props: NavigatorProps) {
    const { client, revision } = props;
    const [kids, setKids] = useState(new Map<string, NodeSummary[]>());
    const [open, setOpen] = useState(new Set<string>(['sys:root']));

    const load = (key: string) => {
        if (kids.has(key)) return;
        void client.children(key).then((list) => setKids((m) => new Map(m).set(key, list ?? [])));
    };

    useEffect(() => {
        setKids(new Map());
        setOpen(new Set(['sys:root']));
    }, [revision]);
    useEffect(() => setKids(new Map()), [props.dataVersion]);
    // Follow the scope: its ancestors are opened.
    useEffect(() => {
        setOpen((o) => new Set([...o, ...props.path]));
    }, [props.path.join('\n')]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
        for (const k of open) load(k);
    }, [open, kids]); // eslint-disable-line react-hooks/exhaustive-deps

    const row = (n: NodeSummary, depth: number): JSX.Element => {
        const isOpen = open.has(n.key);
        const onPath = props.path.includes(n.key);
        return (
            <li key={n.key} role="treeitem" aria-expanded={n.hasChildren ? isOpen : undefined} aria-selected={props.selected === n.key}>
                <div
                    className={`ca-nav-row${onPath ? ' ca-on-path' : ''}${props.selected === n.key ? ' ca-selected' : ''}`}
                    style={{ paddingLeft: 6 + depth * 14 }}
                    data-key={n.key}
                    tabIndex={0}
                    onClick={() => props.onReveal(n.key)}
                    onDoubleClick={() => n.hasChildren && props.onDrill(n.key)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') props.onReveal(n.key);
                        if (e.key === 'ArrowRight' && n.hasChildren) setOpen((o) => new Set(o).add(n.key));
                        if (e.key === 'ArrowLeft') setOpen((o) => (o.delete(n.key), new Set(o)));
                    }}
                >
                    <button
                        type="button"
                        className="ca-twisty"
                        aria-label={isOpen ? 'Collapse' : 'Expand'}
                        tabIndex={-1}
                        disabled={!n.hasChildren}
                        onClick={(e) => {
                            e.stopPropagation();
                            setOpen((o) => {
                                const next = new Set(o);
                                if (next.has(n.key)) next.delete(n.key);
                                else next.add(n.key);
                                return next;
                            });
                        }}
                    >
                        {n.hasChildren ? (isOpen ? '▾' : '▸') : ''}
                    </button>
                    <span className="ca-nav-name">{n.name}</span>
                    {n.role ? <span className="ca-chip">{n.role}</span> : null}
                </div>
                {isOpen && n.hasChildren ? <ul role="group">{(kids.get(n.key) ?? []).map((c) => row(c, depth + 1))}</ul> : null}
            </li>
        );
    };

    return (
        <div className="ca-navigator">
            <div className="ca-panel-title">Navigator</div>
            <ul role="tree" aria-label="Architecture hierarchy">
                {(kids.get('sys:root') ?? []).map((n) => row(n, 0))}
            </ul>
        </div>
    );
}

// ─── Inspector ──────────────────────────────────────────────────────────────

export interface InspectorProps {
    details?: NodeDetails;
    explanation?: EdgeExplanation;
    nameOf(key: string): string;
    host?: HostActions;
    expanded: boolean;
    lens: LensId;
    onReveal(key: string): void;
    onDrill(key: string): void;
    onToggleExpand(key: string): void;
}

export function Inspector(props: InspectorProps) {
    const { details: d, explanation: x, host } = props;
    if (x) {
        return (
            <div className="ca-inspector">
                <div className="ca-panel-title">Dependency</div>
                <h2>
                    {props.nameOf(x.source)} → {props.nameOf(x.target)}
                </h2>
                <p className="ca-muted">
                    {x.total} file-to-file dependenc{x.total === 1 ? 'y' : 'ies'}
                    {x.total > x.dependencies.length ? `, heaviest ${x.dependencies.length} shown` : ''}
                </p>
                <ul className="ca-list ca-deps">
                    {x.dependencies.map((dep) => (
                        <li key={`${dep.from}>${dep.to}`}>
                            <div>
                                <FileLink path={dep.from} host={host} /> → <FileLink path={dep.to} host={host} /> <span className="ca-muted">×{dep.weight}</span>
                            </div>
                            <div className="ca-evidence">
                                {dep.implicit
                                    ? 'same package (no import statement)'
                                    : dep.evidence.map((ev, i) => (
                                          <code key={i}>
                                              {host?.openFile && ev.line !== undefined ? (
                                                  <button type="button" className="ca-link" onClick={() => host.openFile!(dep.from, ev.line)}>
                                                      {ev.source}:{ev.line + 1}
                                                  </button>
                                              ) : (
                                                  ev.source
                                              )}
                                          </code>
                                      ))}
                            </div>
                        </li>
                    ))}
                </ul>
            </div>
        );
    }
    if (!d) {
        return (
            <div className="ca-inspector">
                <div className="ca-panel-title">Inspector</div>
                <p className="ca-muted">Select a node or an edge. Double-click a node to drill in; ⊕ expands it in place.</p>
            </div>
        );
    }
    const links = (title: string, list: NodeLink[]) => (
        <section>
            <h3>
                {title} ({list.length})
            </h3>
            {list.length === 0 ? (
                <p className="ca-muted">none</p>
            ) : (
                <ul className="ca-list">
                    {list.map((l) => (
                        <li key={l.key}>
                            <button type="button" className="ca-link" onClick={() => props.onReveal(l.key)}>
                                {l.name}
                            </button>
                            {l.outside ? <span className="ca-muted"> (outside)</span> : null} <span className="ca-muted">×{l.weight}</span>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
    return (
        <div className="ca-inspector" data-key={d.key}>
            <div className="ca-panel-title">{d.virtual ? 'Group' : KIND_TITLE[d.kind]}</div>
            <h2>{d.name}</h2>
            {d.path ? <p className="ca-muted ca-path">{d.path}</p> : null}
            <p>
                {d.kind !== 'module' ? `${d.modules.toLocaleString()} file${d.modules === 1 ? '' : 's'}` : d.language ?? ''}
                {d.role ? (
                    <>
                        {' · '}
                        <span className="ca-chip" title={`${d.roleReason ?? ''} (confidence ${d.roleConfidence ?? '?'})`}>
                            {d.role}
                        </span>
                    </>
                ) : null}
                {d.virtual ? <span className="ca-muted"> · grouped by dependencies</span> : null}
            </p>
            <div className="ca-actions">
                {d.hasChildren ? (
                    <>
                        <button type="button" onClick={() => props.onDrill(d.key)}>
                            Drill in
                        </button>
                        <button type="button" onClick={() => props.onToggleExpand(d.key)}>
                            {props.expanded ? 'Collapse' : 'Expand'}
                        </button>
                    </>
                ) : null}
                {d.kind === 'module' && host?.openFile ? (
                    <button type="button" onClick={() => host.openFile!(d.path)}>
                        Open file
                    </button>
                ) : null}
            </div>
            <HealthAndTests details={d} lens={props.lens} host={host} />
            {links('Depends on', d.dependsOn)}
            {links('Used by', d.usedBy)}
            {d.kind === 'module' ? (
                <section>
                    <h3>Symbols ({d.symbols.length})</h3>
                    <ul className="ca-list">
                        {d.symbols.map((s) => (
                            <li key={s.key} style={{ paddingLeft: s.depth * 12 }}>
                                <span className="ca-muted">{s.kind}</span>{' '}
                                {host?.openFile ? (
                                    <button type="button" className="ca-link" onClick={() => host.openFile!(d.path, s.startLine)}>
                                        {s.name}
                                    </button>
                                ) : (
                                    s.name
                                )}
                                {s.exported ? <span className="ca-muted"> · exported</span> : null}
                            </li>
                        ))}
                    </ul>
                </section>
            ) : (
                <section>
                    <h3>Contains ({d.children.length})</h3>
                    <ul className="ca-list">
                        {d.children.map((c) => (
                            <li key={c.key}>
                                <button type="button" className="ca-link" onClick={() => props.onReveal(c.key)}>
                                    {c.name}
                                </button>{' '}
                                <span className="ca-muted">{c.kind === 'module' ? 'file' : `${c.modules} files`}</span>
                            </li>
                        ))}
                    </ul>
                </section>
            )}
        </div>
    );
}

/** Lens numbers for a node: every coloured value is also stated here. */
function HealthAndTests({ details: d, lens, host }: { details: NodeDetails; lens: LensId; host?: HostActions }) {
    const m = d.metrics;
    const health = lensBadge(m, 'health', d.kind);
    const tests = lensBadge(m, 'tests', d.kind);
    const files = (paths: string[] | undefined) =>
        paths && paths.length ? (
            <ul className="ca-list">
                {paths.map((p) => (
                    <li key={p}>
                        <FileLink path={p} host={host} />
                    </li>
                ))}
            </ul>
        ) : null;
    return (
        <section className={`ca-lens-section${lens !== 'dependencies' ? ' ca-lens-active' : ''}`}>
            <h3>Health &amp; tests</h3>
            <p className={health?.level ? `ca-status-text ca-level-${health.level}` : ''} title={health?.title}>
                {health?.text}
            </p>
            {d.cycleWith?.length ? (
                <>
                    <p className="ca-muted">In a cycle with:</p>
                    {files(d.cycleWith)}
                </>
            ) : null}
            <p title={tests?.title}>{tests?.text ?? 'no code files'}</p>
            {d.kind === 'module' && d.testedBy ? (d.testedBy.length ? <><p className="ca-muted">Tested by:</p>{files(d.testedBy)}</> : null) : null}
            <p className="ca-muted">
                {m.codeModules} code · {m.testModules} test files · dependencies in {m.fanIn} / out {m.fanOut}
            </p>
        </section>
    );
}

function FileLink({ path, host }: { path: string; host?: HostActions }) {
    return host?.openFile ? (
        <button type="button" className="ca-link" onClick={() => host.openFile!(path)}>
            {path}
        </button>
    ) : (
        <span>{path}</span>
    );
}

// ─── Search (⌘K) ────────────────────────────────────────────────────────────

export function SearchBox(props: { client: EngineClient; onPick(result: SearchResult): void; onClose(): void }) {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<SearchResult[]>([]);
    const [active, setActive] = useState(0);
    const input = useRef<HTMLInputElement>(null);
    const seq = useRef(0);

    useEffect(() => input.current?.focus(), []);
    useEffect(() => {
        const n = ++seq.current;
        const t = setTimeout(() => {
            if (!query.trim() || !props.client.search) return setResults([]);
            void props.client.search(query.trim()).then((r) => n === seq.current && (setResults(r), setActive(0)));
        }, 120);
        return () => clearTimeout(t);
    }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

    return (
        <div className="ca-search-backdrop" onClick={props.onClose}>
            <div className="ca-search" role="dialog" aria-label="Search" onClick={(e) => e.stopPropagation()}>
                <input
                    ref={input}
                    value={query}
                    placeholder="Search symbols, files, components…"
                    aria-label="Search"
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Escape') props.onClose();
                        if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, results.length - 1));
                        if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
                        if (e.key === 'Enter' && results[active]) props.onPick(results[active]);
                    }}
                />
                <ul className="ca-list" role="listbox">
                    {results.map((r, i) => (
                        <li key={`${r.key}#${r.name}#${i}`} role="option" aria-selected={i === active} className={i === active ? 'ca-active' : ''} onMouseEnter={() => setActive(i)} onClick={() => props.onPick(r)}>
                            <span className="ca-muted">{r.kind}</span> {r.name} <span className="ca-muted ca-path">{r.path}</span>
                        </li>
                    ))}
                </ul>
            </div>
        </div>
    );
}
