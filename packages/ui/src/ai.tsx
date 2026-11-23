/**
 * The AI side of the shared UI: chat, summary cards, settings and the
 * "ask before sending" preview. Everything goes through an AiClient, so the
 * same components run in VS Code and the web app.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AiCard, AiClient, AiProviderInfo, AiRole, AiSettings, AiState, CanvasAction, ChatCitation, ChatEvent, PrivacyTier, SendPreview } from '@codearchy/protocol';
import { parseAnswer, type Block, type Inline } from './answer.js';

// ── Answers ─────────────────────────────────────────────────────────────────

export interface AnswerLinks {
    onNode(key: string): void;
    onFile?(path: string, line?: number): void;
}

function InlineView({ nodes, links }: { nodes: Inline[]; links: AnswerLinks }): ReactNode {
    return nodes.map((n, i) => {
        switch (n.t) {
            case 'text':
                return <Fragment key={i}>{n.text}</Fragment>;
            case 'code':
                return <code key={i}>{n.text}</code>;
            case 'bold':
                return (
                    <strong key={i}>
                        <InlineView nodes={n.children} links={links} />
                    </strong>
                );
            case 'node':
                return (
                    <button key={i} type="button" className="ca-link ca-cite" title="Show on the map" onClick={() => links.onNode(n.key)}>
                        <InlineView nodes={n.label} links={links} />
                    </button>
                );
            case 'file':
                return links.onFile ? (
                    <button key={i} type="button" className="ca-link ca-cite" title={`Open ${n.path}${n.line ? `:${n.line}` : ''}`} onClick={() => links.onFile!(n.path, n.line ? n.line - 1 : undefined)}>
                        <InlineView nodes={n.label} links={links} />
                    </button>
                ) : (
                    <InlineView key={i} nodes={n.label} links={links} />
                );
        }
    });
}

export function Answer({ text, links }: { text: string; links: AnswerLinks }) {
    const blocks = useMemo(() => parseAnswer(text), [text]);
    return (
        <div className="ca-answer">
            {blocks.map((b: Block, i) => {
                switch (b.t) {
                    case 'p':
                        return (
                            <p key={i}>
                                <InlineView nodes={b.inline} links={links} />
                            </p>
                        );
                    case 'h':
                        return (
                            <p key={i} className="ca-answer-h">
                                <InlineView nodes={b.inline} links={links} />
                            </p>
                        );
                    case 'pre':
                        return <pre key={i}>{b.text}</pre>;
                    case 'ul':
                    case 'ol': {
                        const Tag = b.t;
                        return (
                            <Tag key={i}>
                                {b.items.map((item, j) => (
                                    <li key={j}>
                                        <InlineView nodes={item} links={links} />
                                    </li>
                                ))}
                            </Tag>
                        );
                    }
                }
            })}
        </div>
    );
}

// ── Chat ────────────────────────────────────────────────────────────────────

interface Turn {
    question: string;
    answer: string;
    status: string[];
    citations: ChatCitation[];
    actions: CanvasAction[];
    done: boolean;
    error?: string;
    meta?: string;
}

export interface ChatPanelProps extends AnswerLinks {
    ai: AiClient;
    /** The node selected in the map, offered as context. */
    selection?: { key: string; name: string };
    onAction(action: CanvasAction): void;
    onOpenSettings(): void;
    /** A question to put in the box (e.g. from "Ask about this"); a new nonce repeats it. */
    prompt?: { text: string; nonce: number };
}

export function ChatPanel(props: ChatPanelProps) {
    const { ai } = props;
    const [state, setState] = useState<AiState>();
    const [turns, setTurns] = useState<Turn[]>([]);
    const [draft, setDraft] = useState(props.prompt?.text ?? '');
    const [useSelection, setUseSelection] = useState(true);
    const conversation = useRef(newConversationId());
    const busy = turns.length > 0 && !turns[turns.length - 1]!.done;
    const end = useRef<HTMLDivElement>(null);

    useEffect(() => {
        void ai.state().then(setState);
        const off = ai.subscribe((e) => {
            if (e.type === 'state') setState(e.state);
        });
        return () => {
            off();
        };
    }, [ai]);
    useEffect(() => {
        if (props.prompt) {
            setDraft(props.prompt.text);
            setUseSelection(true);
        }
    }, [props.prompt?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
        end.current?.scrollIntoView?.({ block: 'end' });
    }, [turns]);

    const update = (patch: (t: Turn) => Turn) => setTurns((all) => [...all.slice(0, -1), patch(all[all.length - 1]!)]);

    const send = useCallback(() => {
        const question = draft.trim();
        if (!question || busy) return;
        setDraft('');
        setTurns((all) => [...all, { question, answer: '', status: [], citations: [], actions: [], done: false }]);
        const selection = useSelection ? props.selection?.key : undefined;
        void ai
            .ask(conversation.current, question, { selection }, (e: ChatEvent) => {
                if (e.type === 'text') update((t) => ({ ...t, answer: t.answer + e.delta }));
                else if (e.type === 'restart') update((t) => ({ ...t, answer: '' }));
                else if (e.type === 'status') update((t) => ({ ...t, status: [...t.status, e.text] }));
                else if (e.type === 'action') update((t) => ({ ...t, actions: [...t.actions, e.action] }));
                else if (e.type === 'error') update((t) => ({ ...t, done: true, error: e.message }));
                else if (e.type === 'done')
                    update((t) => ({
                        ...t,
                        done: true,
                        answer: e.answer,
                        citations: e.citations,
                        actions: e.actions,
                        meta: `${e.provider} · ${e.model}${e.mode === 'rag' ? ' · from search results' : ''} · ${e.usage.inputTokens + e.usage.outputTokens} tokens`,
                    }));
            })
            .catch((err: unknown) => update((t) => ({ ...t, done: true, error: err instanceof Error ? err.message : String(err) })));
    }, [ai, draft, busy, useSelection, props.selection?.key]);

    const chat = state?.resolved.chat;
    const unavailable = chat && !chat.ok ? chat.reason : undefined;

    return (
        <div className="ca-chat" aria-label="Ask about the codebase">
            <div className="ca-panel-title ca-chat-head">
                <span className="ca-toolbar-gap" />
                {chat?.ok ? (
                    <span className="ca-muted" title={chat.why}>
                        {chat.provider} · {chat.model}
                    </span>
                ) : null}
                {turns.length ? (
                    <button
                        type="button"
                        className="ca-link"
                        onClick={() => {
                            ai.reset(conversation.current);
                            conversation.current = newConversationId();
                            setTurns([]);
                        }}
                    >
                        New chat
                    </button>
                ) : null}
            </div>
            <div className="ca-chat-log">
                {unavailable ? (
                    <div className="ca-chat-empty">
                        <p>{unavailable}.</p>
                        <button type="button" className="ca-primary" onClick={props.onOpenSettings}>
                            Set up AI
                        </button>
                    </div>
                ) : turns.length === 0 ? (
                    <p className="ca-muted ca-chat-empty">Ask how something works, where a feature lives, or what depends on what. Answers cite the map and the code.</p>
                ) : null}
                {turns.map((t, i) => (
                    <div key={i} className="ca-turn">
                        <div className="ca-question">{t.question}</div>
                        {t.status.length && !t.done ? <div className="ca-chat-status">{t.status[t.status.length - 1]}</div> : null}
                        {t.answer ? <Answer text={t.answer} links={props} /> : !t.done ? <div className="ca-chat-status">Thinking…</div> : null}
                        {t.error ? <div className="ca-chat-error" role="alert">{t.error}</div> : null}
                        {t.done && t.actions.length ? (
                            <div className="ca-actions">
                                {t.actions.map((a, j) => (
                                    <button key={j} type="button" onClick={() => props.onAction(a)}>
                                        Show me{t.actions.length > 1 ? ` (${j + 1})` : ''}
                                    </button>
                                ))}
                            </div>
                        ) : null}
                        {t.done && t.meta ? <div className="ca-muted ca-chat-meta">{t.meta}</div> : null}
                    </div>
                ))}
                <div ref={end} />
            </div>
            <form
                className="ca-chat-form"
                onSubmit={(e) => {
                    e.preventDefault();
                    send();
                }}
            >
                {props.selection ? (
                    <label className="ca-chat-context">
                        <input type="checkbox" checked={useSelection} onChange={(e) => setUseSelection(e.target.checked)} /> About <strong>{props.selection.name}</strong>
                    </label>
                ) : null}
                <textarea
                    aria-label="Question"
                    rows={3}
                    value={draft}
                    disabled={!!unavailable}
                    placeholder={unavailable ? 'AI is not set up' : 'Ask about the codebase…'}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            send();
                        }
                    }}
                />
                <div className="ca-actions">
                    {busy ? (
                        <button type="button" onClick={() => ai.cancel(conversation.current)}>
                            Stop
                        </button>
                    ) : (
                        <button type="submit" className="ca-primary" disabled={!draft.trim() || !!unavailable}>
                            Ask
                        </button>
                    )}
                </div>
            </form>
        </div>
    );
}

function newConversationId(): string {
    return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ── Summary cards (in the Inspector) ────────────────────────────────────────

export function CardSection({ ai, nodeKey, onReveal, nameOf }: { ai: AiClient; nodeKey: string; onReveal(key: string): void; nameOf(key: string): string }) {
    const [card, setCard] = useState<AiCard>();
    const [working, setWorking] = useState(false);
    const [error, setError] = useState<string>();
    useEffect(() => {
        let live = true;
        setCard(undefined);
        setError(undefined);
        void ai.card(nodeKey).then((c) => {
            if (live) setCard(c);
        });
        const off = ai.subscribe((e) => {
            if (e.type === 'card' && e.card.key === nodeKey) setCard(e.card);
        });
        return () => {
            live = false;
            off();
        };
    }, [ai, nodeKey]);
    if (!card) return null;
    const summarize = async () => {
        setWorking(true);
        setError(undefined);
        try {
            const c = await ai.card(nodeKey, { generate: true });
            if (c) setCard(c);
            if (c?.source !== 'ai' && c?.note) setError(c.note);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setWorking(false);
        }
    };
    return (
        <section className="ca-card" aria-label="Summary">
            <h3>
                {card.title}{' '}
                <span className="ca-chip" title={card.source === 'ai' ? `Written by ${card.provider} · ${card.model}` : 'Built from docs, names and structure (no AI)'}>
                    {card.source === 'ai' ? `AI · ${card.model}` : 'auto-summary'}
                </span>
            </h3>
            <p>{card.purpose}</p>
            {card.responsibilities.length ? (
                <ul className="ca-list">
                    {card.responsibilities.map((r, i) => (
                        <li key={i}>{r}</li>
                    ))}
                </ul>
            ) : null}
            {card.keyNodes.length ? (
                <p className="ca-muted">
                    Key parts:{' '}
                    {card.keyNodes.map((k, i) => (
                        <Fragment key={k}>
                            {i ? ', ' : ''}
                            <button type="button" className="ca-link" title={k} onClick={() => onReveal(k)}>
                                {readableName(k, nameOf)}
                            </button>
                        </Fragment>
                    ))}
                </p>
            ) : null}
            {card.risks.length ? (
                <ul className="ca-list ca-risks">
                    {card.risks.map((r, i) => (
                        <li key={i}>
                            <span aria-hidden="true">⚠</span> {r}
                        </li>
                    ))}
                </ul>
            ) : null}
            {card.source === 'ai' ? (
                <p className="ca-muted">AI-written · confidence {Math.round(card.confidence * 100)}%</p>
            ) : (
                <div className="ca-actions">
                    <button type="button" disabled={working} onClick={() => void summarize()}>
                        {working ? 'Summarizing…' : 'Summarize with AI'}
                    </button>
                </div>
            )}
            {error ? <p className="ca-muted" role="status">{error}</p> : null}
        </section>
    );
}

/** A node's name when the view knows it, else the last part of its key (`dir:rust/src` → src). */
function readableName(key: string, nameOf: (key: string) => string): string {
    const name = nameOf(key);
    if (name !== key) return name;
    const tail = key.slice(key.indexOf(':') + 1);
    const hash = tail.lastIndexOf('#');
    if (hash >= 0) return tail.slice(hash + 1).replace(/~\d+$/, '');
    return tail.slice(tail.lastIndexOf('/') + 1) || tail;
}

// ── Settings ────────────────────────────────────────────────────────────────

const TIERS: Array<{ id: PrivacyTier; label: string; text: string }> = [
    { id: 'local-only', label: 'Local only', text: 'Nothing leaves this machine. Only models running here are used.' },
    { id: 'structure', label: 'Structure', text: 'Names, paths, signatures, docs and dependencies may go to a cloud model. Code does not.' },
    { id: 'excerpts', label: 'Structure + code excerpts', text: 'As above, plus short code excerpts when an answer needs them.' },
];
const ROLES: Array<{ id: AiRole; label: string; text: string }> = [
    { id: 'chat', label: 'Chat', text: 'Answers questions' },
    { id: 'summarizer', label: 'Summarizer', text: 'Summarizes files and components (many calls)' },
    { id: 'architect', label: 'Architect', text: 'Summarizes packages and the system' },
];

export function AiSettingsPanel({ ai, onClose }: { ai: AiClient; onClose(): void }) {
    const [state, setState] = useState<AiState>();
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        void ai.state().then(setState);
        const off = ai.subscribe((e) => {
            if (e.type === 'state') setState(e.state);
        });
        return () => {
            off();
        };
    }, [ai]);
    const run = async (task: () => Promise<AiState>) => {
        setBusy(true);
        try {
            setState(await task());
        } finally {
            setBusy(false);
        }
    };
    const patch = (p: Partial<AiSettings>) => void run(() => ai.updateSettings(p));
    if (!state) return <div className="ca-settings">Loading…</div>;
    const s = state.settings;
    return (
        <div className="ca-settings" role="dialog" aria-label="AI settings">
            <div className="ca-settings-head">
                <h2>AI settings</h2>
                <span className="ca-toolbar-gap" />
                <button type="button" disabled={busy} onClick={() => void run(() => ai.refresh())}>
                    {busy ? 'Checking…' : 'Check providers'}
                </button>
                <button type="button" onClick={onClose} aria-label="Close">
                    Close
                </button>
            </div>

            <section>
                <h3>Privacy</h3>
                {TIERS.map((t) => (
                    <label key={t.id} className="ca-radio">
                        <input type="radio" name="ca-tier" checked={s.tier === t.id} onChange={() => patch({ tier: t.id })} />
                        <span>
                            <strong>{t.label}</strong> <span className="ca-muted">{t.text}</span>
                        </span>
                    </label>
                ))}
                <label className="ca-radio">
                    <input type="checkbox" checked={s.askBeforeSend} onChange={(e) => patch({ askBeforeSend: e.target.checked })} />
                    <span>
                        <strong>Ask before sending</strong> <span className="ca-muted">Show each cloud request, with secrets removed, before it goes.</span>
                    </span>
                </label>
            </section>

            <section>
                <h3>Providers</h3>
                <ul className="ca-providers">
                    {state.providers.map((p) => (
                        <ProviderRow key={p.id} provider={p} defaultModel={s.defaults[p.id]} onKey={(k) => run(() => ai.setKey(p.id, k))} onModel={(m) => patch({ defaults: { ...s.defaults, [p.id]: m } })} />
                    ))}
                </ul>
            </section>

            <section>
                <h3>Roles</h3>
                {ROLES.map((r) => {
                    const setting = s.roles[r.id];
                    const resolved = state.resolved[r.id];
                    const value = !setting || setting === 'auto' ? 'auto' : `${setting.provider}\u0000${setting.model}`;
                    return (
                        <div key={r.id} className="ca-role">
                            <label>
                                <strong>{r.label}</strong> <span className="ca-muted">{r.text}</span>
                                <select
                                    value={value}
                                    onChange={(e) => {
                                        const v = e.target.value;
                                        const [provider, model] = v.split('\u0000');
                                        patch({ roles: { ...s.roles, [r.id]: v === 'auto' ? 'auto' : { provider: provider!, model: model! } } });
                                    }}
                                >
                                    <option value="auto">Automatic</option>
                                    {state.providers
                                        .filter((p) => p.allowed && p.models.length)
                                        .flatMap((p) =>
                                            p.models.map((m) => (
                                                <option key={`${p.id}/${m.id}`} value={`${p.id}\u0000${m.id}`}>
                                                    {p.label} · {m.label}
                                                </option>
                                            )),
                                        )}
                                </select>
                            </label>
                            <div className="ca-muted">{resolved.ok ? `${resolved.provider} · ${resolved.model}. ${resolved.why}.` : resolved.reason}</div>
                        </div>
                    );
                })}
            </section>

            <section>
                <h3>Daily budgets</h3>
                <p className="ca-muted">A hard stop per cloud provider, in tokens. Leave empty for no limit.</p>
                {state.providers
                    .filter((p) => !p.onDevice)
                    .map((p) => (
                        <label key={p.id} className="ca-budget">
                            {p.label}{' '}
                            <input
                                type="number"
                                min={0}
                                step={10000}
                                placeholder="no limit"
                                defaultValue={s.budgets[p.id]?.tokensPerDay ?? ''}
                                onBlur={(e) => {
                                    const n = e.target.value === '' ? undefined : Math.max(0, Number(e.target.value));
                                    patch({ budgets: { ...s.budgets, [p.id]: { ...s.budgets[p.id], tokensPerDay: n } } });
                                }}
                            />
                        </label>
                    ))}
            </section>
        </div>
    );
}

function ProviderRow({ provider: p, defaultModel, onKey, onModel }: { provider: AiProviderInfo; defaultModel?: string; onKey(key: string | null): Promise<void>; onModel(model: string): void }) {
    const [key, setKey] = useState('');
    const status = !p.allowed ? p.blockedReason ?? 'Not allowed by the privacy tier' : stateLabel(p);
    return (
        <li className="ca-provider" data-provider={p.id}>
            <div className="ca-provider-head">
                <strong>{p.label}</strong>
                {p.onDevice ? <span className="ca-chip">on this machine</span> : <span className="ca-chip">cloud</span>}
                <span className={`ca-chip ca-state-${p.allowed ? p.state ?? 'unknown' : 'blocked'}`}>{status}</span>
            </div>
            {p.detail && p.allowed ? <div className="ca-muted">{p.detail}</div> : null}
            {p.setup && p.allowed && p.state !== 'ready' ? (
                <details className="ca-setup">
                    <summary>{p.setup.title}</summary>
                    <ol>
                        {p.setup.steps.map((step, i) => (
                            <li key={i}>
                                <code>{step}</code>
                            </li>
                        ))}
                    </ol>
                </details>
            ) : null}
            {p.acceptsKey && p.allowed ? (
                <form
                    className="ca-key"
                    onSubmit={(e) => {
                        e.preventDefault();
                        if (key.trim()) void onKey(key.trim()).then(() => setKey(''));
                    }}
                >
                    <input type="password" autoComplete="off" spellCheck={false} aria-label={`${p.label} API key`} placeholder={p.hasKey ? 'Key saved · enter a new one to replace it' : 'API key'} value={key} onChange={(e) => setKey(e.target.value)} />
                    <button type="submit" disabled={!key.trim()}>
                        Save
                    </button>
                    {p.hasKey ? (
                        <button type="button" onClick={() => void onKey(null)}>
                            Remove
                        </button>
                    ) : null}
                </form>
            ) : null}
            {p.allowed && p.models.length ? (
                <label className="ca-muted">
                    Model{' '}
                    <select value={defaultModel ?? ''} onChange={(e) => onModel(e.target.value)}>
                        <option value="">Automatic</option>
                        {p.models.map((m) => (
                            <option key={m.id} value={m.id}>
                                {m.label}
                                {m.tools === false ? ' (no tools)' : ''}
                            </option>
                        ))}
                    </select>
                </label>
            ) : null}
        </li>
    );
}

function stateLabel(p: AiProviderInfo): string {
    switch (p.state) {
        case 'ready':
            return `ready · ${p.models.length} model${p.models.length === 1 ? '' : 's'}`;
        case 'needs-key':
            return 'needs an API key';
        case 'unauthorized':
            return 'key rejected';
        case 'unreachable':
            return 'not reachable';
        case 'error':
            return 'error';
        default:
            return 'not checked';
    }
}

// ── Ask before sending ──────────────────────────────────────────────────────

export function PreviewDialog({ ai }: { ai: AiClient }) {
    const [queue, setQueue] = useState<SendPreview[]>([]);
    useEffect(() => {
        const off = ai.subscribe((e) => {
            if (e.type === 'preview') setQueue((q) => [...q, e.preview]);
        });
        return () => {
            off();
        };
    }, [ai]);
    const p = queue[0];
    if (!p) return null;
    const answer = (send: boolean) => {
        ai.answerPreview(p.id, send);
        setQueue((q) => q.slice(1));
    };
    const redacted = p.redactions.reduce((n, r) => n + r.count, 0);
    return (
        <div className="ca-modal" role="dialog" aria-modal="true" aria-label="Send this request?">
            <div className="ca-modal-body">
                <h2>Send this to {p.providerLabel}?</h2>
                <p className="ca-muted">
                    {p.model} · about {p.estimatedInputTokens.toLocaleString()} tokens · {p.role}
                    {redacted ? ` · ${redacted} secret${redacted === 1 ? '' : 's'} removed` : ''}
                </p>
                <details>
                    <summary>What will be sent</summary>
                    {p.system ? <pre className="ca-preview">{p.system}</pre> : null}
                    {p.messages.map((m, i) => (
                        <pre key={i} className="ca-preview">
                            <strong>{m.role}:</strong> {m.content}
                        </pre>
                    ))}
                </details>
                <div className="ca-actions">
                    <button type="button" className="ca-primary" onClick={() => answer(true)}>
                        Send
                    </button>
                    <button type="button" onClick={() => answer(false)}>
                        Don't send
                    </button>
                </div>
            </div>
        </div>
    );
}
