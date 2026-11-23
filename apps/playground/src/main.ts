/**
 * CodeArchy playground: a debug UI for the engine running in the browser.
 * Everything a repository supplies (paths, names, import specifiers) is
 * rendered as text, never as HTML.
 */
import type { FileDetail, FileRow, Request, Response, SearchHit, Source, Summary } from './protocol.js';

// ─── engine connection ──────────────────────────────────────────────────────

const engine = new Worker(new URL('engine.worker.js', import.meta.url), { type: 'module' });
const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
let nextId = 1;

engine.onmessage = (ev: MessageEvent<Response>) => {
    const msg = ev.data;
    if (msg.type === 'progress') return setStatus(`${msg.phase} ${msg.current.toLocaleString()} / ${msg.total.toLocaleString()}`, msg.total ? msg.current / msg.total : undefined);
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.type === 'result') p?.resolve(msg.result);
    else p?.reject(new Error(msg.message));
};
engine.onerror = (ev) => setStatus(`engine failed to load: ${ev.message || 'see the console'}`);

type Body<R> = R extends unknown ? Omit<R, 'id'> : never;
function call<T>(req: Body<Request>): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        engine.postMessage({ ...req, id } as Request);
    });
}

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

type Tab = 'files' | 'edges' | 'unresolved' | 'search';
let summary: Summary | undefined;
let tab: Tab = 'files';
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
            card('parsed', t.parsed, 'parsed'),
            card('reused', t.reused + t.unchanged, 'reused'),
            card('ms', t.durationMs, 'ms'),
        ),
        el('p', { className: 'note' },
            `${s.name} · storage: `, el('strong', { textContent: s.storage === 'opfs' ? 'OPFS (persistent)' : 'memory', dataset: { stat: 'storage' } }),
            ` · ${t.workers ? `${t.workers} parse workers` : 'parsed in-process'} · ${s.discovered.toLocaleString()} source files discovered · ${langs}`),
    );
    for (const [id, n] of [['files', t.files], ['edges', t.edges], ['unresolved', t.unresolved]] as const) {
        $(`tab-${id}`).textContent = `${id[0].toUpperCase()}${id.slice(1)} (${n.toLocaleString()})`;
    }
}

function renderList(): void {
    for (const t of ['files', 'edges', 'unresolved', 'search'] as const) $(`tab-${t}`).setAttribute('aria-selected', String(t === tab));
    const filter = $<HTMLInputElement>('filter').value;
    $<HTMLInputElement>('filter').placeholder = tab === 'search' ? 'Symbol name prefix (e.g. OrderSer)' : 'Filter';
    const list = $('list');
    if (!summary) return list.replaceChildren(el('p', { className: 'note', textContent: 'Load the sample or open a folder.' }));
    if (tab === 'files') {
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
        void call<SearchHit[]>({ type: 'search', query: filter }).then((hits) => {
            if (seq !== searchSeq || tab !== 'search') return;
            list.replaceChildren(table(hits, ['symbol', 'kind', 'file', 'line'], (h) => [h.container ? `${h.container}.${h.name}` : h.name, h.kind, h.path, h.line + 1], '', (h) => showFile(h.path)));
        });
    }
}

async function showFile(path: string): Promise<void> {
    const d = await call<FileDetail | undefined>({ type: 'file', path });
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

async function load(source: Source, label: string): Promise<void> {
    for (const b of document.querySelectorAll('header button')) (b as HTMLButtonElement).disabled = true;
    setStatus(`indexing ${label}…`, 0);
    try {
        summary = await call<Summary>({ type: 'open', source });
        setStatus(`indexed ${summary.name} in ${summary.stats.durationMs.toLocaleString()} ms`);
        document.body.dataset.state = 'ready';
        renderStats(summary);
        $('detail').replaceChildren(el('p', { className: 'note', textContent: 'Pick a row to inspect a file.' }));
        renderList();
    } catch (err) {
        setStatus(`failed: ${(err as Error).message.split('\n')[0]}`);
        console.error(err);
    } finally {
        for (const b of document.querySelectorAll('header button')) (b as HTMLButtonElement).disabled = false;
    }
}

// ─── wiring ─────────────────────────────────────────────────────────────────

$('load-sample').onclick = () => void load({ kind: 'sample' }, 'the sample');
$('open-folder').onclick = async () => {
    const picker = (window as Window & { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
    if (!picker) return $<HTMLInputElement>('folder-input').click(); // Firefox / Safari: snapshot via <input>
    try {
        const handle = await picker.call(window);
        await load({ kind: 'handle', handle }, handle.name);
    } catch (err) {
        if ((err as DOMException).name !== 'AbortError') setStatus(`could not open the folder: ${(err as Error).message}`);
    }
};
$<HTMLInputElement>('folder-input').onchange = (ev) => {
    const input = ev.target as HTMLInputElement;
    const files = [...(input.files ?? [])].filter((f) => !/(^|\/)(node_modules|\.git)\//.test((f as File & { webkitRelativePath: string }).webkitRelativePath));
    if (files.length === 0) return;
    const name = (files[0] as File & { webkitRelativePath: string }).webkitRelativePath.split('/')[0] || 'folder';
    input.value = '';
    void load({ kind: 'files', name, files }, name);
};
for (const t of ['files', 'edges', 'unresolved', 'search'] as const) {
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
