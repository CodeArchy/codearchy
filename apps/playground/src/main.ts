/**
 * CodeArchy playground: a debug UI for the engine running in the browser.
 * Everything a repository supplies (paths, names, import specifiers) is
 * rendered as text, never as HTML.
 */
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { View } from '@codearchy/protocol';
import { CodeArchyMap } from '@codearchy/ui';
import { demoAi } from './demoAi.js';
import '@codearchy/ui/styles.css';
import { WorkerEngine, canPickDirectory, pickDirectory, sourceFromDrop, sourceFromFileList, type EngineSource } from '@codearchy/platform-browser/client';
import type { FileDetail, FileRow, Summary, TreeRow } from './protocol.js';

// ─── engine connection: the shared browser engine, in a module worker ───────

const engine = new WorkerEngine(new Worker(new URL('engine.worker.js', import.meta.url), { type: 'module' }));
engine.onEvent((e) => {
    if (e.type === 'progress') setStatus(`${e.phase} ${e.current.toLocaleString()} / ${e.total.toLocaleString()}`, e.total ? e.current / e.total : undefined);
    else void refresh(`${e.paths.length} file(s) changed on disk: ${e.paths.slice(0, 3).join(', ')}${e.paths.length > 3 ? '…' : ''}`);
});

// ─── DOM helpers ────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {}, ...children: Array<Node | string>) {
    const { dataset, ...rest } = props;
    const node = Object.assign(document.createElement(tag), rest);
    if (dataset) Object.assign(node.dataset, dataset);
    node.append(...children);
    return node;
}

function setStatus(text: string, fraction?: number): void {
    $('status').textContent = text;
    const bar = $<HTMLProgressElement>('progress');
    bar.hidden = fraction === undefined;
    if (fraction !== undefined) bar.value = fraction;
}

const ROW_LIMIT = 1000;

/** Renders a filtered table; `cells` gives the text of each column. */
function table<T>(rows: T[], headers: string[], cells: (r: T) => Array<string | number>, filter: string, onPick?: (r: T) => void): HTMLElement {
    const f = filter.trim().toLowerCase();
    const matched = f ? rows.filter((r) => cells(r).some((c) => String(c).toLowerCase().includes(f))) : rows;
    const body = el('tbody');
    for (const r of matched.slice(0, ROW_LIMIT)) {
        const tr = el('tr', {}, ...cells(r).map((c) => el('td', { textContent: String(c) })));
        if (onPick) {
            tr.tabIndex = 0;
            tr.onclick = () => onPick(r);
            tr.onkeydown = (e) => e.key === 'Enter' && onPick(r);
        }
        body.append(tr);
    }
    const note = matched.length > ROW_LIMIT ? `Showing ${ROW_LIMIT.toLocaleString()} of ${matched.length.toLocaleString()}; filter to narrow.` : `${matched.length.toLocaleString()} rows`;
    return el('div', {}, el('p', { className: 'note', textContent: note }), el('table', {}, el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', { textContent: h })))), body));
}

// ─── state + views ──────────────────────────────────────────────────────────

type Tab = 'map' | 'tree' | 'view' | 'files' | 'edges' | 'unresolved' | 'search';
const TABS: Tab[] = ['map', 'tree', 'view', 'files', 'edges', 'unresolved', 'search'];
/** The View tab's request: what the Map will ask the engine for. */
let viewScope = 'sys:root';
let viewExpanded: string[] = [];
let summary: Summary | undefined;
let tab: Tab = 'map';
let loads = 0;
/** Bumped when a watched folder changes: the Map refetches in place. */
let dataVersion = 0;
let mapRoot: Root | undefined;
// The smoke test drives host events through the real engine worker.
(globalThis as { __codearchyEngine?: unknown }).__codearchyEngine = engine;
/** `?ai=demo`: a scripted AI side, to see and test the chat, cards and settings. */
const ai = new URLSearchParams(location.search).get('ai') === 'demo' ? demoAi(engine) : undefined;

function renderMap(): void {
    mapRoot ??= createRoot($('map'));
    mapRoot.render(
        createElement(CodeArchyMap, {
            client: engine,
            layoutWorkerUrl: new URL('elk-worker.js', location.href).href,
            hostKind: 'web',
            revision: `${summary?.name ?? ''}#${loads}`,
            dataVersion,
            ai,
        })
    );
}
/** Expanded rows of the hierarchy tree (indexes into summary.tree). */
let expanded = new Set<number>();
let treeChildren: number[][] = [];
let searchSeq = 0;

function renderStats(s: Summary): void {
    const t = s.stats;
    const card = (label: string, value: number | string, key: string) =>
        el('div', { className: 'card' }, el('div', { className: 'value', textContent: typeof value === 'number' ? value.toLocaleString() : value, dataset: { stat: key } }), el('div', { className: 'label', textContent: label }));
    const langs = Object.entries(s.languages).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} ${n}`).join(' · ');
    $('stats').replaceChildren(
        el('div', { className: 'cards' },
            card('files', t.files, 'files'),
            card('symbols', t.symbols, 'symbols'),
            card('edges', t.edges, 'edges'),
            card('imports', t.imports, 'imports'),
            card('unresolved', t.unresolved, 'unresolved'),
            card('components', t.components, 'components'),
            card('parsed', t.parsed, 'parsed'),
            card('reused', t.reused + t.unchanged, 'reused'),
            card('ms', t.durationMs, 'ms'),
        ),
        el('p', { className: 'note' },
            `${s.name} · storage: `, el('strong', { textContent: s.storage === 'opfs' ? 'OPFS (persistent)' : 'memory', dataset: { stat: 'storage' } }),
            ` · ${t.workers ? `${t.workers} parse workers` : 'parsed in-process'} · hierarchy ${t.hierarchyMs} ms · ${s.discovered.toLocaleString()} source files discovered · ${langs}`),
    );
    for (const [id, n] of [['files', t.files], ['edges', t.edges], ['unresolved', t.unresolved]] as const) {
        $(`tab-${id}`).textContent = `${id[0].toUpperCase()}${id.slice(1)} (${n.toLocaleString()})`;
    }
}

function renderList(): void {
    for (const t of TABS) $(`tab-${t}`).setAttribute('aria-selected', String(t === tab));
    const filter = $<HTMLInputElement>('filter').value;
    $<HTMLInputElement>('filter').placeholder = tab === 'search' ? 'Symbol name prefix (e.g. OrderSer)' : 'Filter';
    const list = $('list');
    const onMap = tab === 'map' && !!summary;
    $('map').hidden = !onMap;
    document.querySelector('main')!.hidden = onMap;
    $<HTMLInputElement>('filter').hidden = onMap;
    if (onMap) return renderMap();
    if (!summary) return list.replaceChildren(el('p', { className: 'note', textContent: 'Load the sample or open a folder.' }));
    if (tab === 'tree') {
        list.replaceChildren(renderTree(summary.tree, filter));
    } else if (tab === 'view') {
        const seq = ++searchSeq;
        void engine.view({ scope: viewScope, expanded: viewExpanded }).then((v) => {
            if (seq === searchSeq && tab === 'view' && v) list.replaceChildren(renderView(v));
        });
    } else if (tab === 'files') {
        list.replaceChildren(table<FileRow>(summary.files, ['path', 'language', 'symbols', 'imports', 'out', 'in'], (r) => [r.path, r.language, r.symbols, r.imports, r.out, r.in], filter, (r) => showFile(r.path)));
    } else if (tab === 'edges') {
        list.replaceChildren(table(summary.edges, ['from', 'to'], (e) => [e[0], e[1]], filter, (e) => showFile(e[0])));
    } else if (tab === 'unresolved') {
        list.replaceChildren(
            el('p', { className: 'note', textContent: 'Imports that resolve to no file in the workspace: external packages, the standard library, or a resolver gap worth a look.' }),
            table(summary.unresolved, ['file', 'line', 'import'], (u) => [u.file, u.line === undefined ? '' : u.line + 1, u.source], filter, (u) => showFile(u.file)),
        );
    } else {
        const seq = ++searchSeq;
        void engine.search(filter).then((hits) => {
            if (seq !== searchSeq || tab !== 'search') return;
            list.replaceChildren(table(hits, ['name', 'kind', 'path', 'line'], (h) => [h.name, h.kind, h.path, h.line === undefined ? '' : h.line + 1], '', (h) => showFile(h.path)));
        });
    }
}

const KIND_BADGE: Record<string, string> = { system: 'S', package: 'P', component: 'C', module: 'M' };

/** The hierarchy as an expandable tree; with a filter, the matching rows as a flat list. */
function renderTree(rows: TreeRow[], filter: string): HTMLElement {
    const box = el('div', { className: 'tree', role: 'tree' });
    const line = (i: number, depth: number) => {
        const r = rows[i];
        const hasKids = treeChildren[i].length > 0;
        const open = expanded.has(i);
        const row = el('div', { className: `row ${r.kind}`, role: 'treeitem', tabIndex: 0, dataset: { key: r.key } },
            el('span', { className: 'twisty', textContent: hasKids ? (open ? '▾' : '▸') : ' ' }),
            el('span', { className: 'badge', textContent: KIND_BADGE[r.kind] ?? '?', title: r.kind }),
            el('span', { className: 'name', textContent: r.name }),
            el('span', { className: 'meta', textContent: `${r.modules.toLocaleString()} file${r.modules === 1 ? '' : 's'}` }),
            ...(r.virtual ? [el('span', { className: 'tag', textContent: 'cluster', title: 'grouped by dependency communities (or alphabetically)' })] : []),
            ...(r.role ? [el('span', { className: 'tag', textContent: r.role, title: r.roleReason ?? '' })] : []),
        );
        row.style.paddingLeft = `${depth * 16 + 4}px`;
        row.setAttribute('aria-expanded', String(open));
        row.onclick = () => {
            if (r.kind === 'module') return void showFile(r.path);
            if (open) expanded.delete(i);
            else expanded.add(i);
            renderList();
        };
        row.onkeydown = (e) => e.key === 'Enter' && row.click();
        return row;
    };
    const f = filter.trim().toLowerCase();
    if (f) {
        const hits = rows.map((_, i) => i).filter((i) => rows[i].name.toLowerCase().includes(f) || rows[i].path.toLowerCase().includes(f));
        for (const i of hits.slice(0, ROW_LIMIT)) box.append(line(i, 0));
        return el('div', {}, el('p', { className: 'note', textContent: `${hits.length.toLocaleString()} matching nodes` }), box);
    }
    let shown = 0;
    const walk = (i: number, depth: number) => {
        if (shown++ >= ROW_LIMIT) return;
        box.append(line(i, depth));
        if (expanded.has(i)) for (const c of treeChildren[i]) walk(c, depth + 1);
    };
    if (rows.length) walk(0, 0);
    return el('div', {}, el('p', { className: 'note', textContent: 'System › Package › Component › Module. Hover a role for its reason.' }), box);
}

/** A textual view debugger: exactly what a Map canvas receives for this scope and expansion. */
function renderView(v: View): HTMLElement {
    const go = (scope: string, expanded: string[] = []) => {
        viewScope = scope;
        viewExpanded = expanded;
        renderList();
    };
    const nameOf = (key: string) => v.nodes.find((n) => n.key === key)?.name ?? key;
    const crumbs = el('nav', { className: 'crumbs', ariaLabel: 'Breadcrumb' });
    v.breadcrumb.forEach((b, i) => {
        if (i) crumbs.append(' › ');
        crumbs.append(i === v.breadcrumb.length - 1 ? el('strong', { textContent: b.name }) : el('a', { href: '#', textContent: b.name, onclick: (e: Event) => (e.preventDefault(), go(b.key)) }));
    });
    const nodeRows = v.nodes.map((n) => {
        const actions = el('span', { className: 'actions' });
        if (n.hasChildren) {
            actions.append(el('button', { type: 'button', textContent: 'Drill', dataset: { action: 'drill', key: n.key }, onclick: () => go(n.key) }));
            const open = viewExpanded.includes(n.key);
            actions.append(el('button', { type: 'button', textContent: open ? 'Collapse' : 'Expand', dataset: { action: 'expand', key: n.key }, onclick: () => go(viewScope, open ? viewExpanded.filter((k) => k !== n.key) : [...viewExpanded, n.key]) }));
        }
        const depth = n.group ? v.nodes.filter((m) => m.expanded && (m.key === n.group)).length : 0;
        const name = el('span', { textContent: `${n.expanded ? '▣ ' : ''}${n.name}` });
        name.style.paddingLeft = `${depth * 16}px`;
        return el('tr', { dataset: { key: n.key } },
            el('td', {}, name), el('td', { textContent: n.kind }), el('td', { textContent: String(n.modules) }),
            el('td', { textContent: n.role ?? '' }), el('td', { textContent: `${n.fanIn} / ${n.fanOut}` }), el('td', {}, actions));
    });
    const explain = async (source: string, target: string) => {
        const x = await engine.explain(source, target);
        if (!x) return;
        $('detail').replaceChildren(
            el('h2', { textContent: `${nameOf(source)} → ${nameOf(target)}`, title: `${source} → ${target}` }),
            el('p', { className: 'note', textContent: `${x.total} module dependenc${x.total === 1 ? 'y' : 'ies'}${x.total > x.dependencies.length ? `, heaviest ${x.dependencies.length} shown` : ''}` }),
            el('ul', {}, ...x.dependencies.map((d) => el('li', {}, `${d.from} → ${d.to} ×${d.weight}${d.implicit ? ' (same package)' : ''} `, el('code', { textContent: d.evidence.map((ev) => `${ev.source}${ev.line === undefined ? '' : `:${ev.line + 1}`}`).join(', ') })))),
        );
    };
    const edgeTable = table(v.edges, ['from', 'to', 'weight', 'deps'], (e) => [nameOf(e.source), nameOf(e.target), e.weight, e.count], '', (e) => void explain(e.source, e.target));
    const portTable = table(v.ports, ['node', 'direction', 'outside', 'weight'], (p) => [nameOf(p.node), p.direction === 'out' ? '→ out' : '← in', p.externalName, p.weight], '', (p) => void (p.direction === 'out' ? explain(p.node, p.external) : explain(p.external, p.node)));
    return el('div', { className: 'view' },
        crumbs,
        el('p', { className: 'note', textContent: `${v.nodes.length} nodes · ${v.edges.length} edges · ${v.ports.length} port stubs · frontier ${v.frontierHash}${v.skipped.length ? ` · over budget, not expanded: ${v.skipped.join(', ')}` : ''}` }),
        el('table', {}, el('thead', {}, el('tr', {}, ...['node', 'kind', 'files', 'role', 'in / out', ''].map((h) => el('th', { textContent: h })))), el('tbody', {}, ...nodeRows)),
        el('h3', { textContent: 'Edges (click to explain)' }), edgeTable,
        el('h3', { textContent: 'Port stubs (dependencies leaving this scope)' }), portTable,
    );
}

async function showFile(path: string): Promise<void> {
    const d = await engine.call<FileDetail | undefined>('file', { path });
    const pane = $('detail');
    if (!d) return pane.replaceChildren(el('p', { className: 'note', textContent: `${path} is not in the index.` }));
    const link = (p: string) => el('a', { href: '#', textContent: p, onclick: (e: Event) => { e.preventDefault(); void showFile(p); } });
    const section = (title: string, items: Node[]) => el('section', {}, el('h3', { textContent: `${title} (${items.length})` }), items.length ? el('ul', {}, ...items.map((i) => el('li', {}, i))) : el('p', { className: 'note', textContent: 'none' }));
    pane.replaceChildren(
        el('h2', { textContent: d.path }),
        el('p', { className: 'note', textContent: [d.language, d.parser, d.namespace && `namespace ${d.namespace}`].filter(Boolean).join(' · ') }),
        section('Symbols', d.symbols.map((s) => el('span', { textContent: `${s.kind} ${s.container ? `${s.container}.` : ''}${s.name}${s.exported ? ' (exported)' : ''} · line ${s.startLine + 1}` }))),
        section('Imports', d.imports.map((i) => el('span', {}, el('code', { textContent: i.source }), ' → ', ...(i.targets.length ? i.targets.flatMap((t, n) => (n ? [', ', link(t)] : [link(t)])) : [el('em', { textContent: 'unresolved' })])))),
        section('Same-package dependencies', d.implicit.map(link)),
        section('Used by', d.dependents.map(link)),
    );
}

async function load(source: EngineSource, label: string): Promise<void> {
    for (const b of document.querySelectorAll('header button')) (b as HTMLButtonElement).disabled = true;
    setStatus(`indexing ${label}…`, 0);
    try {
        const opened = await engine.open(source);
        summary = await engine.call<Summary>('debug');
        setStatus(`indexed ${summary.name} in ${summary.stats.durationMs.toLocaleString()} ms${opened.live ? ' · watching for changes' : ''}`);
        document.body.dataset.state = 'ready';
        renderStats(summary);
        treeChildren = summary.tree.map(() => []);
        summary.tree.forEach((r, i) => r.parent >= 0 && treeChildren[r.parent].push(i));
        expanded = new Set([0, ...treeChildren[0] ?? []]);
        viewScope = 'sys:root';
        viewExpanded = [];
        loads++;
        $('detail').replaceChildren(el('p', { className: 'note', textContent: 'Pick a row to inspect a file.' }));
        renderList();
    } catch (err) {
        setStatus(`failed: ${(err as Error).message.split('\n')[0]}`);
        console.error(err);
    } finally {
        for (const b of document.querySelectorAll('header button')) (b as HTMLButtonElement).disabled = false;
    }
}

/** A watched folder changed: refresh the stats and lists, and the Map in place. */
async function refresh(message: string): Promise<void> {
    summary = await engine.call<Summary>('debug');
    dataVersion++;
    setStatus(message);
    renderStats(summary);
    treeChildren = summary.tree.map(() => []);
    summary.tree.forEach((r, i) => r.parent >= 0 && treeChildren[r.parent].push(i));
    renderList();
}

// ─── wiring ─────────────────────────────────────────────────────────────────

$('load-sample').onclick = async () => {
    const files: Record<string, string> = await (await fetch(new URL('fixture.json', location.href))).json();
    await load({ kind: 'texts', name: 'sample (fixtures/polyglot)', files }, 'the sample');
};
$('open-folder').onclick = async () => {
    if (!canPickDirectory()) return $<HTMLInputElement>('folder-input').click(); // Firefox / Safari: snapshot via <input>
    try {
        const source = await pickDirectory();
        if (source) await load(source, 'the folder');
    } catch (err) {
        setStatus(`could not open the folder: ${(err as Error).message}`);
    }
};
$<HTMLInputElement>('folder-input').onchange = (ev) => {
    const input = ev.target as HTMLInputElement;
    const source = sourceFromFileList(input.files ?? []);
    input.value = '';
    if (source) void load(source, source.kind === 'files' ? source.name : 'the folder');
};
// Drop a folder, a .zip or files anywhere on the page.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!e.dataTransfer) return;
    void sourceFromDrop(e.dataTransfer).then((source) => source && load(source, 'the dropped item'));
});
for (const t of TABS) {
    $(`tab-${t}`).onclick = () => {
        tab = t;
        renderList();
    };
}
let filterTimer: ReturnType<typeof setTimeout> | undefined;
$('filter').oninput = () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(renderList, 120);
};
renderList();
document.body.dataset.state = 'idle';
// Test hook (Playwright opens sources the UI can't create, e.g. a watched OPFS folder).
(window as Window & { codearchyPlayground?: unknown }).codearchyPlayground = { load };
