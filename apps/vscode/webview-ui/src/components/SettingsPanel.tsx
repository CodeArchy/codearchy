/**
 * CodeArchy's settings, in the Map: every `codearchy.*` setting the extension
 * contributes (the host reads them from its manifest, so new ones appear here
 * on their own), grouped, searchable, for you (User) or this workspace.
 * Changes apply at once; the host checks every value against the schema, and
 * changes made in VS Code's own settings show up here too.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '@codearchy/ui';
import { postMessage } from '../vscode';
import './settingsPanel.css';

interface Setting {
    key: string;
    type: 'boolean' | 'string' | 'number' | 'integer' | 'array' | 'object';
    default?: unknown;
    description: string;
    enum?: unknown[];
    enumDescriptions?: string[];
    items?: { type?: string; enum?: unknown[]; enumDescriptions?: string[] };
    minimum?: number;
    maximum?: number;
    scope?: string;
    deprecated?: string;
    user?: unknown;
    workspace?: unknown;
    value: unknown;
}
interface Snapshot {
    settings: Setting[];
    hasWorkspace: boolean;
}
type Target = 'user' | 'workspace';

// ─── requests to the host ──────────────────────────────────────────────────

const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
let nextId = 1;
const changed = new Set<() => void>();
window.addEventListener('message', (ev: MessageEvent) => {
    const msg = ev.data as { type?: string; payload?: { id: number; result?: unknown; error?: string } };
    if (msg?.type === 'settingsChanged') return changed.forEach((l) => l());
    if (msg?.type !== 'settingsResponse' || !msg.payload) return;
    const p = pending.get(msg.payload.id);
    pending.delete(msg.payload.id);
    if (msg.payload.error) p?.reject(new Error(msg.payload.error));
    else p?.resolve(msg.payload.result);
});
function settingsRequest<T>(method: 'get' | 'update' | 'open', params: Record<string, unknown> = {}): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        postMessage('settingsRequest', { id, method, params });
    });
}

// ─── grouping and labels ───────────────────────────────────────────────────

const GROUPS: Array<{ id: string; label: string; icon: IconName; test(key: string): boolean }> = [
    { id: 'general', label: 'General', icon: 'sliders', test: () => false },
    { id: 'indexing', label: 'Indexing', icon: 'boxes', test: (k) => /^codearchy\.(includedLanguages|excludePatterns|maxFileSize|maxFiles)$/.test(k) },
    { id: 'ai', label: 'AI', icon: 'sparkles', test: (k) => /^codearchy\.(ai[A-Z]|ollama\.)/.test(k) },
    { id: 'authorship', label: 'Authorship', icon: 'user', test: (k) => k.startsWith('codearchy.authorship.') },
];
const groupOf = (key: string) => GROUPS.find((g) => g.test(key))?.id ?? 'general';

const WORDS: Record<string, string> = { ui: 'UI', url: 'URL', ai: 'AI', ollama: 'Ollama' };
/** `codearchy.authorship.agentLogs` → "Agent logs"; `codearchy.ollama.url` → "Ollama URL". */
export function settingLabel(key: string): string {
    const parts = key.split('.').slice(1);
    const words = parts
        .filter((p, i) => !(i === 0 && parts.length > 1 && GROUPS.some((g) => g.id === p)))
        .flatMap((p) => p.replace(/([a-z])([A-Z])/g, '$1 $2').split(' '))
        .map((w) => WORDS[w.toLowerCase()] ?? w.toLowerCase());
    const text = words.join(' ');
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Settings' markdown, lightly: `code`, **bold**, [links](…) and VS Code's `#setting#` references. */
function Markdown({ text }: { text: string }) {
    const out: ReactNode[] = [];
    const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\([^)]*\)|#([\w.]+)#/g;
    let at = 0;
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(text))) {
        if (m.index > at) out.push(text.slice(at, m.index));
        if (m[1] !== undefined) out.push(<code key={i++}>{m[1]}</code>);
        else if (m[2] !== undefined) out.push(<strong key={i++}>{m[2]}</strong>);
        else if (m[3] !== undefined) out.push(m[3]);
        else out.push(<code key={i++}>{m[4]}</code>);
        at = m.index + m[0].length;
    }
    if (at < text.length) out.push(text.slice(at));
    return <>{out}</>;
}

// ─── the panel ─────────────────────────────────────────────────────────────

export function SettingsPanel({ onClose }: { onClose(): void }) {
    const [snap, setSnap] = useState<Snapshot>();
    const [failure, setFailure] = useState<string>();
    const [tab, setTab] = useState('general');
    const [target, setTarget] = useState<Target>('user');
    const [query, setQuery] = useState('');
    const [errors, setErrors] = useState<Record<string, string>>({});

    const load = useCallback(() => {
        settingsRequest<Snapshot>('get').then(setSnap, (e: Error) => setFailure(e.message));
    }, []);
    useEffect(() => {
        load();
        changed.add(load);
        return () => void changed.delete(load);
    }, [load]);

    const update = (key: string, value: unknown) => {
        setErrors(({ [key]: _, ...rest }) => rest);
        settingsRequest('update', { key, value, target }).then(load, (e: Error) => setErrors((x) => ({ ...x, [key]: e.message })));
    };

    const shown = useMemo(() => {
        const all = snap?.settings ?? [];
        const q = query.trim().toLowerCase();
        if (q) return all.filter((s) => `${s.key} ${settingLabel(s.key)} ${s.description}`.toLowerCase().includes(q));
        return all.filter((s) => groupOf(s.key) === tab);
    }, [snap, tab, query]);

    return (
        <div className="ca-settings ca-vs-settings" role="dialog" aria-label="CodeArchy settings">
            <div className="ca-settings-head">
                <span className="ca-settings-icon">
                    <Icon name="sliders" size={18} />
                </span>
                <div>
                    <h2>Settings</h2>
                    <p className="ca-muted">CodeArchy’s settings, applied at once. The same as in VS Code’s Settings.</p>
                </div>
                <span className="ca-toolbar-gap" />
                <button type="button" className="ca-button ca-button-ghost" onClick={onClose} aria-label="Close">
                    <Icon name="close" /> Close
                </button>
            </div>

            <div className="ca-vs-settings-bar">
                <input className="ca-vs-settings-search" type="search" placeholder="Search settings" aria-label="Search settings" value={query} onChange={(e) => setQuery(e.target.value)} />
                <div className="ca-segmented" role="radiogroup" aria-label="Apply to">
                    {(['user', 'workspace'] as const).map((t) => (
                        <button
                            key={t}
                            type="button"
                            role="radio"
                            aria-checked={target === t}
                            className={target === t ? 'ca-on' : ''}
                            disabled={t === 'workspace' && snap && !snap.hasWorkspace}
                            title={t === 'user' ? 'Your settings, in every workspace' : snap?.hasWorkspace ? 'This workspace only (.vscode/settings.json): overrides yours' : 'Open a folder to set workspace settings'}
                            onClick={() => setTarget(t)}
                        >
                            {t === 'user' ? 'User' : 'Workspace'}
                        </button>
                    ))}
                </div>
            </div>

            {!query ? (
                <div className="ca-settings-tabs" role="tablist">
                    {GROUPS.map((g) => (
                        <button key={g.id} type="button" role="tab" aria-selected={tab === g.id} className={tab === g.id ? 'ca-on' : ''} onClick={() => setTab(g.id)}>
                            <Icon name={g.icon} size={14} /> {g.label}
                        </button>
                    ))}
                </div>
            ) : null}

            <div className="ca-settings-body ca-vs-settings-list">
                {failure ? <p className="ca-muted">{failure}</p> : !snap ? <p className="ca-muted">Loading…</p> : shown.length === 0 ? <p className="ca-muted">No settings match “{query}”.</p> : null}
                {shown.map((s) => (
                    <SettingRow key={s.key} setting={s} target={target} error={errors[s.key]} onChange={(v) => update(s.key, v)} onReset={() => update(s.key, undefined)} />
                ))}
            </div>

            <div className="ca-dialog-actions">
                <button type="button" className="ca-button ca-button-ghost" onClick={() => void settingsRequest('open').catch(() => undefined)}>
                    <Icon name="external" size={13} /> Open in VS Code Settings
                </button>
            </div>
        </div>
    );
}

function SettingRow({ setting: s, target, error, onChange, onReset }: { setting: Setting; target: Target; error?: string; onChange(v: unknown): void; onReset(): void }) {
    const own = target === 'user' ? s.user : s.workspace;
    const set = own !== undefined;
    // What this scope shows: its own value, else what it inherits (the user's, then the default).
    const shown = set ? own : target === 'workspace' ? (s.user ?? s.default) : s.default;
    const machineWide = target === 'workspace' && (s.scope === 'application' || s.scope === 'machine');
    const overridden = target === 'user' && s.workspace !== undefined;
    const id = `set-${s.key}`;
    return (
        <section className={`ca-vs-setting${set ? ' ca-vs-modified' : ''}`} aria-labelledby={`${id}-label`}>
            <div className="ca-vs-setting-head">
                <label id={`${id}-label`} htmlFor={id}>
                    <strong>{settingLabel(s.key)}</strong> <code className="ca-muted">{s.key}</code>
                </label>
                {set ? (
                    <button type="button" className="ca-link" onClick={onReset} title={`Remove the ${target} value: back to ${target === 'workspace' ? 'yours' : 'the default'}`}>
                        Reset
                    </button>
                ) : null}
            </div>
            <p className="ca-muted ca-vs-setting-desc">
                <Markdown text={s.description} />
            </p>
            {s.deprecated ? <p className="ca-vs-setting-note">Deprecated: {s.deprecated}</p> : null}
            {machineWide ? <p className="ca-vs-setting-note">Applies to the whole machine: set it under User.</p> : <Control id={id} setting={s} value={shown} onChange={onChange} />}
            {overridden ? <p className="ca-vs-setting-note">This workspace sets its own value, which applies here.</p> : null}
            {error ? (
                <p className="ca-vs-setting-error" role="alert">
                    {error}
                </p>
            ) : null}
        </section>
    );
}

function Control({ id, setting: s, value, onChange }: { id: string; setting: Setting; value: unknown; onChange(v: unknown): void }) {
    if (s.type === 'boolean') {
        return (
            <label className="ca-vs-switch">
                <input id={id} type="checkbox" role="switch" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
                <span>{value === true ? 'On' : 'Off'}</span>
            </label>
        );
    }
    if (s.type === 'string' && s.enum) {
        const i = s.enum.indexOf(value);
        return (
            <>
                <select id={id} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
                    {s.enum.map((v, j) => (
                        <option key={String(v)} value={String(v)} title={s.enumDescriptions?.[j]}>
                            {String(v)}
                        </option>
                    ))}
                </select>
                {i >= 0 && s.enumDescriptions?.[i] ? (
                    <p className="ca-muted ca-vs-setting-desc">
                        <Markdown text={s.enumDescriptions[i]!} />
                    </p>
                ) : null}
            </>
        );
    }
    if (s.type === 'number' || s.type === 'integer') return <TextControl id={id} value={value === undefined ? '' : String(value)} number setting={s} onCommit={(t) => onChange(t === '' ? undefined : Number(t))} />;
    if (s.type === 'string') return <TextControl id={id} value={String(value ?? '')} setting={s} onCommit={(t) => onChange(t)} />;
    if (s.type === 'array' && s.items?.enum) {
        const list = Array.isArray(value) ? value : [];
        return (
            <div className="ca-vs-checks" id={id} role="group">
                {s.items.enum.map((v, j) => (
                    <label key={String(v)} title={s.items?.enumDescriptions?.[j]}>
                        <input type="checkbox" checked={list.includes(v)} onChange={(e) => onChange(e.target.checked ? [...list, v] : list.filter((x) => x !== v))} /> {String(v)}
                    </label>
                ))}
            </div>
        );
    }
    if (s.type === 'array') {
        const list = Array.isArray(value) ? value.map(String) : [];
        return <ListControl id={id} value={list} onCommit={onChange} />;
    }
    return (
        <button type="button" className="ca-button" onClick={() => void settingsRequest('open').catch(() => undefined)}>
            Edit in VS Code Settings
        </button>
    );
}

/** Text and numbers: applied on Enter or when leaving the field (not on every key). */
function TextControl({ id, value, number, setting, onCommit }: { id: string; value: string; number?: boolean; setting: Setting; onCommit(text: string): void }) {
    const [text, setText] = useState(value);
    useEffect(() => setText(value), [value]);
    const commit = () => text !== value && onCommit(text.trim());
    return (
        <input
            id={id}
            className="ca-vs-input"
            type={number ? 'number' : 'text'}
            value={text}
            {...(number && setting.minimum !== undefined ? { min: setting.minimum } : {})}
            {...(number && setting.maximum !== undefined ? { max: setting.maximum } : {})}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && commit()}
        />
    );
}

/** A list of text, one per line: applied when leaving the field. */
function ListControl({ id, value, onCommit }: { id: string; value: string[]; onCommit(list: string[]): void }) {
    const joined = value.join('\n');
    const [text, setText] = useState(joined);
    useEffect(() => setText(joined), [joined]);
    return (
        <textarea
            id={id}
            className="ca-vs-input"
            rows={Math.min(8, Math.max(3, value.length + 1))}
            value={text}
            placeholder="One per line"
            onChange={(e) => setText(e.target.value)}
            onBlur={() => {
                const list = text
                    .split('\n')
                    .map((l) => l.trim())
                    .filter(Boolean);
                if (list.join('\n') !== joined) onCommit(list);
            }}
        />
    );
}
