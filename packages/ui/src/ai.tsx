/**
 * The AI side of the shared UI: chat, summary cards, settings and the
 * "ask before sending" preview. Everything goes through an AiClient, so the
 * same components run in VS Code and the web app.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { AiCard, AiClient, AiLocalModel, AiProviderInfo, AiPullProgress, AiRole, AiSettings, AiState, CanvasAction, PrivacyTier, SendPreview } from '@codearchy/protocol';
import { parseAnswer, type Block, type Inline } from './answer.js';
import { Icon, type IconName } from './icons.js';
import { formatBytes, SpeakingBars } from './voice.js';
import type { ChatSession, ChatSnapshot, ChatTurn } from './chatSession.js';

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
                    <button key={i} type="button" className="ca-link ca-cite ca-cite-file" title={`Open ${n.path}${n.line ? `:${n.line}` : ''}`} onClick={() => links.onFile!(n.path, n.line ? n.line - 1 : undefined)}>
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

// ── Small shared pieces ─────────────────────────────────────────────────────

/** A button that shows only an icon (the label is for screen readers and the tooltip). */
function IconButton({ icon, label, onClick, disabled, className, pressed }: { icon: IconName; label: string; onClick(): void; disabled?: boolean; className?: string; pressed?: boolean }) {
    return (
        <button type="button" className={`ca-icon-button${className ? ` ${className}` : ''}`} aria-label={label} title={label} onClick={onClick} disabled={disabled} {...(pressed !== undefined ? { 'aria-pressed': pressed } : {})}>
            <Icon name={icon} />
        </button>
    );
}

type Tone = 'ok' | 'warn' | 'off' | 'bad';
const StatusDot = ({ tone }: { tone: Tone }) => <span className={`ca-dot ca-dot-${tone}`} aria-hidden="true" />;

function useAiState(ai: AiClient): [AiState | undefined, (s: AiState) => void] {
    const [state, setState] = useState<AiState>();
    useEffect(() => {
        let live = true;
        void ai.state().then((s) => {
            if (live) setState(s);
        });
        const off = ai.subscribe((e) => {
            if (e.type === 'state') setState(e.state);
        });
        return () => {
            live = false;
            off();
        };
    }, [ai]);
    return [state, setState];
}

// ── Chat ────────────────────────────────────────────────────────────────────

export interface ChatPanelProps extends AnswerLinks {
    ai: AiClient;
    /** The conversation (history, the answer being written, narration): it outlives this panel. */
    session: ChatSession;
    /** The node selected in the map, offered as context. */
    selection?: { key: string; name: string };
    onAction(action: CanvasAction): void;
    onOpenSettings(): void;
    /** A question to put in the box (e.g. from "Ask about this"); a new nonce repeats it. */
    prompt?: { text: string; nonce: number };
    /** Turns an answer's walkthrough into tour steps. */
    onMakeTour?(turn: ChatTurn): void;
}

function useChat(session: ChatSession): ChatSnapshot {
    return useSyncExternalStore(
        (on) => session.subscribe(on),
        () => session.snapshot()
    );
}

export function ChatPanel(props: ChatPanelProps) {
    const { ai, session } = props;
    const [state] = useAiState(ai);
    const chatState = useChat(session);
    const turns = chatState.turns;
    const speech = session.speech;
    const [draft, setDraft] = useState(props.prompt?.text ?? '');
    const [useSelection, setUseSelection] = useState(true);
    const [followUp, setFollowUp] = useState<ChatTurn>();
    const busy = turns.length > 0 && !turns[turns.length - 1]!.done;
    const end = useRef<HTMLDivElement>(null);
    const box = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        if (props.prompt) {
            setDraft(props.prompt.text);
            setUseSelection(true);
            box.current?.focus();
        }
    }, [props.prompt?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
        end.current?.scrollIntoView?.({ block: 'end' });
    }, [turns.length, turns.at(-1)?.answer.length, turns.at(-1)?.done]);
    // The box grows with its text, up to a limit.
    useEffect(() => {
        const el = box.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    }, [draft]);

    const ask = useCallback(
        (text: string) => {
            if (!text.trim() || busy) return;
            setDraft('');
            setFollowUp(undefined);
            session.ask(text, { ...(useSelection && props.selection ? { selection: props.selection.key } : {}) });
        },
        [session, busy, useSelection, props.selection?.key] // eslint-disable-line react-hooks/exhaustive-deps
    );

    const chat = state?.resolved.chat;
    const unavailable = chat && !chat.ok ? chat.reason : undefined;
    const provider = chat?.ok ? state?.providers.find((p) => p.id === chat.provider) : undefined;
    const name = props.selection?.name;
    const suggestions = [
        ...(name ? [`What does ${name} do?`, `What depends on ${name}, and why?`] : []),
        'What are the main parts of this codebase?',
        'Where does a request enter the system?',
    ].slice(0, 4);

    return (
        <div className="ca-chat" aria-label="Ask about the codebase">
            <div className="ca-chat-head">
                {chat?.ok ? (
                    <span className="ca-model-chip" title={chat.why}>
                        <StatusDot tone="ok" />
                        <Icon name={provider?.onDevice ? 'laptop' : 'cloud'} size={13} />
                        <span className="ca-model-name">
                            {chat.provider} · {chat.model}
                        </span>
                    </span>
                ) : (
                    <span className="ca-model-chip ca-muted">
                        <StatusDot tone="warn" /> No model
                    </span>
                )}
                <span className="ca-toolbar-gap" />
                {speech ? (
                    <IconButton
                        icon={chatState.narrate ? 'volume' : 'mute'}
                        label={chatState.narrate ? 'Narration on: answers are spoken and the canvas follows' : 'Narration off'}
                        className={chatState.narrate ? 'ca-on' : ''}
                        pressed={chatState.narrate}
                        onClick={() => session.setNarrate(!chatState.narrate)}
                    />
                ) : null}
                {turns.length ? <IconButton icon="plus" label="New chat" onClick={() => session.newChat()} /> : null}
                <IconButton icon="sliders" label="AI settings" onClick={props.onOpenSettings} />
            </div>

            <div className="ca-chat-log" aria-live="polite">
                {unavailable ? (
                    <div className="ca-chat-empty">
                        <span className="ca-empty-icon ca-empty-warn">
                            <Icon name="sparkles" size={22} />
                        </span>
                        <p className="ca-empty-title">Set up a model to ask questions</p>
                        <p className="ca-muted">{unavailable}.</p>
                        <button type="button" className="ca-button ca-button-primary" onClick={props.onOpenSettings}>
                            <Icon name="sliders" /> Set up AI
                        </button>
                    </div>
                ) : turns.length === 0 && chatState.loaded ? (
                    <div className="ca-chat-empty">
                        <span className="ca-empty-icon">
                            <Icon name="sparkles" size={22} />
                        </span>
                        <p className="ca-empty-title">Ask about this codebase</p>
                        <p className="ca-muted">
                            Answers come from the map and cite the parts and lines they rely on.{speech && chatState.narrate ? ' They\'re spoken as they\'re written, and the canvas shows each part as it\'s mentioned.' : ''}
                        </p>
                        <div className="ca-suggestions">
                            {suggestions.map((s) => (
                                <button key={s} type="button" className="ca-suggestion" onClick={() => ask(s)}>
                                    {s}
                                </button>
                            ))}
                        </div>
                    </div>
                ) : null}

                {turns.map((t, i) => {
                    const playing = chatState.playing?.turn === t.id;
                    return (
                        <div key={t.id} className={`ca-turn${playing ? ' ca-turn-playing' : ''}`}>
                            <div className="ca-msg ca-msg-user">
                                <div className="ca-bubble">{t.question}</div>
                            </div>
                            <div className="ca-msg ca-msg-ai">
                                <span className="ca-avatar" aria-hidden="true">
                                    <Icon name="sparkles" size={14} />
                                </span>
                                <div className="ca-msg-body">
                                    {!t.done ? (
                                        <div className="ca-thinking" role="status">
                                            <span className="ca-typing" aria-hidden="true">
                                                <i />
                                                <i />
                                                <i />
                                            </span>
                                            <span>{t.status[t.status.length - 1] ?? 'Thinking…'}</span>
                                        </div>
                                    ) : t.status.length ? (
                                        <details className="ca-steps">
                                            <summary>
                                                <Icon name="chevron" size={12} className="ca-steps-chevron" /> Looked at {t.status.length} thing{t.status.length === 1 ? '' : 's'}
                                            </summary>
                                            <ul>
                                                {t.status.map((s, j) => (
                                                    <li key={j}>{s}</li>
                                                ))}
                                            </ul>
                                        </details>
                                    ) : null}
                                    {t.answer ? <Answer text={t.answer} links={props} /> : null}
                                    {playing ? (
                                        <div className="ca-narrating" role="status" aria-live="off">
                                            <SpeakingBars active={!!chatState.playing?.phrase} />
                                            <span className="ca-narrating-phrase">{chatState.playing?.phrase ?? 'Getting ready to speak…'}</span>
                                            <button type="button" className="ca-icon-button" aria-label="Stop the walkthrough" title="Stop" onClick={() => session.stop()}>
                                                <Icon name="stop" size={13} />
                                            </button>
                                        </div>
                                    ) : null}
                                    {t.error ? (
                                        <div className="ca-chat-error" role="alert">
                                            <Icon name="alert" />
                                            <span>{t.error}</span>
                                            {i === turns.length - 1 ? (
                                                <button type="button" className="ca-button ca-button-ghost" onClick={() => ask(t.question)}>
                                                    <Icon name="retry" /> Retry
                                                </button>
                                            ) : null}
                                        </div>
                                    ) : null}
                                    {t.done && !t.error ? (
                                        <div className="ca-msg-actions">
                                            {speech && t.answer && !playing ? (
                                                <button type="button" className="ca-button ca-button-soft" title="Hear it again, with the canvas following" onClick={() => session.play(t.id)}>
                                                    <Icon name="play" size={13} /> Play walkthrough
                                                </button>
                                            ) : null}
                                            {t.actions.map((a, j) => (
                                                <button key={j} type="button" className="ca-button ca-button-soft" onClick={() => props.onAction(a)}>
                                                    <Icon name="target" /> Show me{t.actions.length > 1 ? ` (${j + 1})` : ''}
                                                </button>
                                            ))}
                                            <button
                                                type="button"
                                                className="ca-button ca-button-ghost"
                                                onClick={() => {
                                                    setFollowUp(t);
                                                    box.current?.focus();
                                                }}
                                            >
                                                <Icon name="chat" size={13} /> Follow up
                                            </button>
                                            {props.onMakeTour && t.citations.some((c) => c.type === 'node') ? (
                                                <button type="button" className="ca-icon-button" aria-label="Make a tour from this answer" title="Make a tour from this answer" onClick={() => props.onMakeTour!(t)}>
                                                    <Icon name="map" size={14} />
                                                </button>
                                            ) : null}
                                            <CopyButton text={t.answer} />
                                            {t.meta ? <span className="ca-muted ca-chat-meta">{t.meta}</span> : null}
                                        </div>
                                    ) : null}
                                </div>
                            </div>
                        </div>
                    );
                })}
                <div ref={end} />
            </div>

            <form
                className="ca-composer"
                onSubmit={(e) => {
                    e.preventDefault();
                    ask(draft);
                }}
            >
                <div className={`ca-composer-box${unavailable ? ' ca-disabled' : ''}`}>
                    {followUp ? (
                        <span className="ca-context-chip" title="Your question continues this conversation">
                            <Icon name="chat" size={13} /> Following up on <strong>{followUp.question.length > 48 ? `${followUp.question.slice(0, 47)}…` : followUp.question}</strong>
                            <button type="button" aria-label="Not a follow-up" onClick={() => setFollowUp(undefined)}>
                                <Icon name="close" size={12} />
                            </button>
                        </span>
                    ) : null}
                    {props.selection && useSelection ? (
                        <span className="ca-context-chip" title="The answer focuses on the selected part of the map">
                            <Icon name="target" size={13} /> About <strong>{props.selection.name}</strong>
                            <button type="button" aria-label={`Don't focus on ${props.selection.name}`} onClick={() => setUseSelection(false)}>
                                <Icon name="close" size={12} />
                            </button>
                        </span>
                    ) : props.selection ? (
                        <button type="button" className="ca-context-add" onClick={() => setUseSelection(true)}>
                            <Icon name="plus" size={12} /> About {props.selection.name}
                        </button>
                    ) : null}
                    <div className="ca-composer-row">
                        <textarea
                            ref={box}
                            aria-label="Question"
                            rows={1}
                            value={draft}
                            disabled={!!unavailable}
                            placeholder={unavailable ? 'Set up a model first' : followUp ? 'Ask a follow-up…' : 'Ask about the codebase…'}
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                                    e.preventDefault();
                                    ask(draft);
                                }
                            }}
                        />
                        {busy ? (
                            <IconButton icon="stop" label="Stop" className="ca-send ca-send-stop" onClick={() => session.cancel()} />
                        ) : (
                            <button type="submit" className="ca-icon-button ca-send" aria-label="Send" title="Send (Enter)" disabled={!draft.trim() || !!unavailable}>
                                <Icon name="send" />
                            </button>
                        )}
                    </div>
                </div>
                <div className="ca-composer-hint ca-muted">
                    <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
                </div>
            </form>
        </div>
    );
}

function CopyButton({ text }: { text: string }) {
    const [copied, setCopied] = useState(false);
    if (!text) return null;
    return (
        <button
            type="button"
            className="ca-icon-button"
            aria-label={copied ? 'Copied' : 'Copy the answer'}
            title={copied ? 'Copied' : 'Copy the answer'}
            onClick={() => {
                void navigator.clipboard?.writeText(text).then(
                    () => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                    },
                    () => undefined,
                );
            }}
        >
            <Icon name={copied ? 'check' : 'copy'} />
        </button>
    );
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
    const isAi = card.source === 'ai';
    return (
        <section className={`ca-card${isAi ? ' ca-card-ai' : ''}`} aria-label="Summary">
            <div className="ca-card-head">
                <Icon name={isAi ? 'sparkles' : 'info'} size={14} />
                <h3>{card.title}</h3>
                <span className="ca-chip" title={isAi ? `Written by ${card.provider} · ${card.model}` : 'Built from docs, names and structure (no AI)'}>
                    {isAi ? `AI · ${card.model}` : 'auto-summary'}
                </span>
            </div>
            <p>{card.purpose}</p>
            {card.responsibilities.length ? (
                <ul className="ca-card-list">
                    {card.responsibilities.map((r, i) => (
                        <li key={i}>{r}</li>
                    ))}
                </ul>
            ) : null}
            {card.keyNodes.length ? (
                <p className="ca-card-keys">
                    <span className="ca-muted">Key parts</span>
                    {card.keyNodes.map((k) => (
                        <button key={k} type="button" className="ca-pill" title={k} onClick={() => onReveal(k)}>
                            {readableName(k, nameOf)}
                        </button>
                    ))}
                </p>
            ) : null}
            {card.risks.length ? (
                <ul className="ca-card-risks">
                    {card.risks.map((r, i) => (
                        <li key={i}>
                            <Icon name="alert" size={13} /> {r}
                        </li>
                    ))}
                </ul>
            ) : null}
            {isAi ? (
                <p className="ca-card-foot ca-muted">AI-written · confidence {Math.round(card.confidence * 100)}%</p>
            ) : (
                <div className="ca-card-foot">
                    <button type="button" className="ca-button ca-button-soft" disabled={working} onClick={() => void summarize()}>
                        <Icon name="sparkles" className={working ? 'ca-spin' : undefined} />
                        {working ? 'Summarizing…' : 'Summarize with AI'}
                    </button>
                </div>
            )}
            {error ? (
                <p className="ca-card-note" role="status">
                    <Icon name="info" size={13} /> {error}
                </p>
            ) : null}
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

const TIERS: Array<{ id: PrivacyTier; label: string; text: string; icon: IconName }> = [
    { id: 'local-only', label: 'Local only', text: 'Nothing leaves this machine. Only models running here are used.', icon: 'lock' },
    { id: 'structure', label: 'Structure', text: 'Names, paths, signatures, docs and dependencies may go to a cloud model. Code does not.', icon: 'layers' },
    { id: 'excerpts', label: 'Structure + code excerpts', text: 'As above, plus short code excerpts when an answer needs them.', icon: 'code' },
];
const ROLES: Array<{ id: AiRole; label: string; text: string; icon: IconName }> = [
    { id: 'chat', label: 'Chat', text: 'Answers questions', icon: 'chat' },
    { id: 'summarizer', label: 'Summarizer', text: 'Summarizes files and components (many calls)', icon: 'file' },
    { id: 'architect', label: 'Architect', text: 'Summarizes packages and the system', icon: 'boxes' },
];
type SettingsTab = 'privacy' | 'providers' | 'models' | 'budgets';
const TABS: Array<{ id: SettingsTab; label: string; icon: IconName }> = [
    { id: 'privacy', label: 'Privacy', icon: 'shield' },
    { id: 'providers', label: 'Providers', icon: 'cloud' },
    { id: 'models', label: 'Models', icon: 'sparkles' },
    { id: 'budgets', label: 'Budgets', icon: 'gauge' },
];

export function AiSettingsPanel({ ai, onClose }: { ai: AiClient; onClose(): void }) {
    const [state, setState] = useAiState(ai);
    const [busy, setBusy] = useState(false);
    const [tab, setTab] = useState<SettingsTab>('privacy');
    const run = async (task: () => Promise<AiState>) => {
        setBusy(true);
        try {
            setState(await task());
        } finally {
            setBusy(false);
        }
    };
    const patch = (p: Partial<AiSettings>) => void run(() => ai.updateSettings(p));
    if (!state) return <div className="ca-settings ca-muted">Loading…</div>;
    const s = state.settings;
    const chat = state.resolved.chat;
    const local = state.providers.filter((p) => p.onDevice);
    const cloud = state.providers.filter((p) => !p.onDevice);

    return (
        <div className="ca-settings" role="dialog" aria-label="AI settings">
            <div className="ca-settings-head">
                <span className="ca-settings-icon">
                    <Icon name="sliders" size={18} />
                </span>
                <h2>AI settings</h2>
                <span className="ca-toolbar-gap" />
                <button type="button" className="ca-button ca-button-ghost" onClick={onClose} aria-label="Close">
                    <Icon name="close" /> Close
                </button>
            </div>

            <div className={`ca-banner ${chat.ok ? 'ca-banner-ok' : 'ca-banner-warn'}`} role="status">
                <StatusDot tone={chat.ok ? 'ok' : 'warn'} />
                {chat.ok ? (
                    <span>
                        Chat uses <strong>{chat.provider} · {chat.model}</strong>
                        <span className="ca-muted"> · {chat.why}</span>
                    </span>
                ) : (
                    <span>
                        <strong>No model is ready for chat yet.</strong> <span className="ca-muted">Choose a privacy level, then set up a provider.</span>
                    </span>
                )}
            </div>

            <div className="ca-settings-tabs" role="tablist" aria-label="AI settings sections">
                {TABS.map((t) => (
                    <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'ca-on' : ''} onClick={() => setTab(t.id)}>
                        <Icon name={t.icon} /> {t.label}
                    </button>
                ))}
            </div>

            <div className="ca-settings-body" role="tabpanel">
                {tab === 'privacy' ? (
                    <section>
                        <p className="ca-section-intro ca-muted">What may leave this machine. On-device models may always see everything: nothing leaves.</p>
                        <div className="ca-tiles" role="radiogroup" aria-label="Privacy level">
                            {TIERS.map((t) => (
                                <label key={t.id} className={`ca-tile${s.tier === t.id ? ' ca-on' : ''}`}>
                                    <input type="radio" name="ca-tier" checked={s.tier === t.id} onChange={() => patch({ tier: t.id })} />
                                    <span className="ca-tile-icon">
                                        <Icon name={t.icon} size={18} />
                                    </span>
                                    <span className="ca-tile-text">
                                        <strong>{t.label}</strong> <span className="ca-muted">{t.text}</span>
                                    </span>
                                    <span className="ca-tile-check" aria-hidden="true">
                                        <Icon name="check" size={14} />
                                    </span>
                                </label>
                            ))}
                        </div>
                        <label className="ca-switch-row">
                            <input type="checkbox" role="switch" className="ca-switch" checked={s.askBeforeSend} onChange={(e) => patch({ askBeforeSend: e.target.checked })} />
                            <span>
                                <strong>Ask before sending</strong> <span className="ca-muted">Show each cloud request, with secrets removed, before it goes.</span>
                            </span>
                        </label>
                    </section>
                ) : null}

                {tab === 'providers' ? (
                    <section>
                        <div className="ca-section-head">
                            <p className="ca-section-intro ca-muted">Models on this machine, your Copilot plan, or your own API keys. Keys are stored securely and never shown again.</p>
                            <button type="button" className="ca-button ca-button-soft" disabled={busy} onClick={() => void run(() => ai.refresh())}>
                                <Icon name="refresh" className={busy ? 'ca-spin' : undefined} /> {busy ? 'Checking…' : 'Check providers'}
                            </button>
                        </div>
                        {local.length ? <ProviderGroup title="On this machine" icon="laptop" providers={local} settings={s} ai={ai} run={run} patch={patch} /> : null}
                        {cloud.length ? <ProviderGroup title="Cloud" icon="cloud" providers={cloud} settings={s} ai={ai} run={run} patch={patch} /> : null}
                    </section>
                ) : null}

                {tab === 'models' ? (
                    <section>
                        <p className="ca-section-intro ca-muted">Which model does each job. Automatic picks a ready model you allow, preferring this machine for the many summary calls.</p>
                        {ROLES.map((r) => {
                            const setting = s.roles[r.id];
                            const resolved = state.resolved[r.id];
                            const value = !setting || setting === 'auto' ? 'auto' : `${setting.provider}\u0000${setting.model}`;
                            return (
                                <div key={r.id} className="ca-role">
                                    <span className="ca-role-icon">
                                        <Icon name={r.icon} />
                                    </span>
                                    <div className="ca-role-main">
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
                                        <div className="ca-role-resolved">
                                            <StatusDot tone={resolved.ok ? 'ok' : 'warn'} />
                                            <span className="ca-muted">{resolved.ok ? `${resolved.provider} · ${resolved.model}. ${resolved.why}.` : resolved.reason}</span>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </section>
                ) : null}

                {tab === 'budgets' ? (
                    <section>
                        <p className="ca-section-intro ca-muted">A hard daily stop per cloud provider, in tokens. Leave empty for no limit.</p>
                        {cloud.map((p) => (
                            <label key={p.id} className="ca-budget">
                                <span className="ca-budget-name">{p.label}</span>
                                <span className="ca-input-suffix">
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
                                    <span className="ca-muted">tokens a day</span>
                                </span>
                            </label>
                        ))}
                    </section>
                ) : null}
            </div>
        </div>
    );
}

function ProviderGroup(props: {
    title: string;
    icon: IconName;
    providers: AiProviderInfo[];
    settings: AiSettings;
    ai: AiClient;
    run(task: () => Promise<AiState>): Promise<void>;
    patch(p: Partial<AiSettings>): void;
}) {
    return (
        <div className="ca-provider-group">
            <h3>
                <Icon name={props.icon} size={14} /> {props.title}
            </h3>
            <ul className="ca-providers">
                {props.providers.map((p) => (
                    <ProviderRow
                        key={p.id}
                        ai={props.ai}
                        provider={p}
                        defaultModel={props.settings.defaults[p.id]}
                        onKey={(k) => props.run(() => props.ai.setKey(p.id, k))}
                        onModel={(m) => props.patch({ defaults: { ...props.settings.defaults, [p.id]: m } })}
                    />
                ))}
            </ul>
        </div>
    );
}

function ProviderRow({ ai, provider: p, defaultModel, onKey, onModel }: { ai: AiClient; provider: AiProviderInfo; defaultModel?: string; onKey(key: string | null): Promise<void>; onModel(model: string): void }) {
    const [key, setKey] = useState('');
    const status = !p.allowed ? p.blockedReason ?? 'Not allowed by the privacy level' : stateLabel(p);
    const tone: Tone = !p.allowed ? 'off' : p.state === 'ready' ? 'ok' : p.state === 'unauthorized' || p.state === 'error' ? 'bad' : 'warn';
    const showSetup = !!p.setup && p.allowed && p.state !== 'ready';
    return (
        <li className={`ca-provider${p.allowed ? '' : ' ca-provider-off'}`} data-provider={p.id}>
            <div className="ca-provider-head">
                <StatusDot tone={tone} />
                <strong>{p.label}</strong>
                {p.hasKey ? (
                    <span className="ca-chip ca-chip-key" title="An API key is saved">
                        <Icon name="key" size={11} /> key saved
                    </span>
                ) : null}
                <span className="ca-toolbar-gap" />
                <span className={`ca-chip ca-state-${p.allowed ? p.state ?? 'unknown' : 'blocked'}`}>{status}</span>
            </div>
            {p.detail && p.allowed ? <div className="ca-provider-detail ca-muted">{p.detail}</div> : null}
            {showSetup ? (
                <details className="ca-setup">
                    <summary>
                        <Icon name="chevron" size={12} className="ca-steps-chevron" /> {p.setup!.title}
                    </summary>
                    <ol>
                        {p.setup!.steps.map((step, i) => (
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
                    <span className="ca-key-input">
                        <Icon name="key" size={14} />
                        <input type="password" autoComplete="off" spellCheck={false} aria-label={`${p.label} API key`} placeholder={p.hasKey ? 'Key saved · enter a new one to replace it' : 'Paste an API key'} value={key} onChange={(e) => setKey(e.target.value)} />
                    </span>
                    <button type="submit" className="ca-button ca-button-soft" disabled={!key.trim()}>
                        Save
                    </button>
                    {p.hasKey ? (
                        <button type="button" className="ca-icon-button" aria-label="Remove" title="Remove the saved key" onClick={() => void onKey(null)}>
                            <Icon name="trash" />
                        </button>
                    ) : null}
                </form>
            ) : null}
            {p.allowed && p.models.length ? (
                <label className="ca-provider-model">
                    <span className="ca-muted">Model</span>
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
            {p.managesModels && p.allowed && p.state === 'ready' && ai.localModels ? <ModelManager ai={ai} provider={p.id} inUse={defaultModel} onUse={onModel} /> : null}
        </li>
    );
}

/** Popular models worth suggesting (any Ollama tag can be typed). Sizes are the download. */
const SUGGESTED_MODELS: Array<{ id: string; note: string }> = [
    { id: 'qwen3:8b', note: '5.2 GB · tools · a strong all-rounder' },
    { id: 'gemma3:4b', note: '3.3 GB · fast on a laptop' },
    { id: 'llama3.1:8b', note: '4.9 GB · tools' },
    { id: 'qwen3:4b', note: '2.5 GB · tools · small' },
    { id: 'gemma3:12b', note: '8.1 GB · better answers, needs 16 GB RAM' },
    { id: 'qwen2.5-coder:7b', note: '4.7 GB · code' },
    { id: 'gpt-oss:20b', note: '14 GB · tools · needs a big machine' },
    { id: 'llama3.2:3b', note: '2.0 GB · tiny' },
    { id: 'mistral:7b', note: '4.1 GB' },
    { id: 'phi4-mini', note: '2.5 GB · tools · tiny' },
];

/** Ollama's models on this machine: use one, remove one, or download another (any tag). */
function ModelManager({ ai, provider, inUse, onUse }: { ai: AiClient; provider: string; inUse?: string; onUse(model: string): void }) {
    const [models, setModels] = useState<AiLocalModel[]>();
    const [pulls, setPulls] = useState<Map<string, AiPullProgress>>(new Map());
    const [name, setName] = useState('');
    const [error, setError] = useState('');
    const [confirm, setConfirm] = useState<string>();
    const [reload, setReload] = useState(0);
    useEffect(() => {
        let live = true;
        ai.localModels!(provider).then(
            (m) => live && setModels(m),
            (e: unknown) => live && setError(e instanceof Error ? e.message : String(e))
        );
        return () => {
            live = false;
        };
    }, [ai, provider, reload]);
    useEffect(
        () =>
            ai.subscribe((e) => {
                if (e.type !== 'pull' || e.progress.provider !== provider) return;
                const p = e.progress;
                setPulls((m) => {
                    const next = new Map(m);
                    if (p.state === 'running') next.set(p.model, p);
                    else next.delete(p.model);
                    return next;
                });
                if (p.state === 'done') setReload((n) => n + 1);
                if (p.state === 'error') setError(`${p.model}: ${p.error ?? 'the download failed'}`);
            }),
        [ai, provider]
    );
    const pull = (model: string) => {
        const m = model.trim();
        if (!m) return;
        setError('');
        setName('');
        setPulls((x) => new Map(x).set(m, { provider, model: m, state: 'running', status: 'starting' }));
        void ai.pullModel!(provider, m).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    };
    const remove = async (model: string) => {
        setConfirm(undefined);
        try {
            await ai.deleteModel!(provider, model);
            setReload((n) => n + 1);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    };
    const installed = new Set(models?.map((m) => m.id));
    const ideas = SUGGESTED_MODELS.filter((s) => !installed.has(s.id) && !pulls.has(s.id));
    return (
        <div className="ca-models">
            <div className="ca-models-head">
                <strong>Models on this machine</strong>
                <span className="ca-muted">{models ? `${models.length} · ${formatBytes(models.reduce((n, m) => n + m.size, 0))}` : 'Loading…'}</span>
            </div>
            {models?.length === 0 ? <p className="ca-muted ca-models-empty">None yet: download one below.</p> : null}
            <ul className="ca-model-list">
                {models?.map((m) => (
                    <li key={m.id} className={`ca-model${inUse === m.id ? ' ca-on' : ''}`}>
                        <span className="ca-model-name">{m.id}</span>
                        <span className="ca-muted ca-model-meta">
                            {[m.parameterSize, m.quantization, formatBytes(m.size)].filter(Boolean).join(' · ')}
                        </span>
                        <span className="ca-toolbar-gap" />
                        {confirm === m.id ? (
                            <>
                                <span className="ca-muted">Remove it from this machine?</span>
                                <button type="button" className="ca-button ca-button-danger" onClick={() => void remove(m.id)}>
                                    Remove
                                </button>
                                <button type="button" className="ca-button" onClick={() => setConfirm(undefined)}>
                                    Keep
                                </button>
                            </>
                        ) : (
                            <>
                                {inUse === m.id ? (
                                    <span className="ca-chip ca-chip-ok">
                                        <Icon name="check" size={11} /> in use
                                    </span>
                                ) : (
                                    <button type="button" className="ca-button ca-button-soft" onClick={() => onUse(m.id)}>
                                        Use
                                    </button>
                                )}
                                <button type="button" className="ca-icon-button" title={`Remove ${m.id}`} aria-label={`Remove ${m.id}`} onClick={() => setConfirm(m.id)}>
                                    <Icon name="trash" size={14} />
                                </button>
                            </>
                        )}
                    </li>
                ))}
                {[...pulls.values()].map((p) => {
                    const pct = p.total ? Math.round(((p.completed ?? 0) / p.total) * 100) : undefined;
                    return (
                        <li key={`pull:${p.model}`} className="ca-model ca-model-pulling" role="status">
                            <span className="ca-model-name">{p.model}</span>
                            <span className="ca-muted ca-model-meta">
                                {p.status}
                                {p.total ? ` · ${formatBytes(p.completed ?? 0)} of ${formatBytes(p.total)}` : ''}
                            </span>
                            <span className="ca-toolbar-gap" />
                            <button type="button" className="ca-button" onClick={() => ai.cancelPull?.(provider, p.model)}>
                                Cancel
                            </button>
                            <span className="ca-meter ca-model-meter" aria-label={pct === undefined ? 'Starting' : `${pct}%`}>
                                <span style={{ width: `${pct ?? 2}%` }} />
                            </span>
                        </li>
                    );
                })}
            </ul>
            <form
                className="ca-model-pull"
                onSubmit={(e) => {
                    e.preventDefault();
                    pull(name);
                }}
            >
                <input list={`ca-model-ideas-${provider}`} value={name} placeholder="Download a model, e.g. qwen3:8b" aria-label="Model to download" onChange={(e) => setName(e.target.value)} />
                <datalist id={`ca-model-ideas-${provider}`}>
                    {SUGGESTED_MODELS.map((s) => (
                        <option key={s.id} value={s.id}>
                            {s.note}
                        </option>
                    ))}
                </datalist>
                <button type="submit" className="ca-button ca-button-primary" disabled={!name.trim()}>
                    <Icon name="download" size={13} /> Download
                </button>
            </form>
            {ideas.length ? (
                <div className="ca-model-ideas">
                    <span className="ca-muted">Popular:</span>
                    {ideas.slice(0, 5).map((s) => (
                        <button key={s.id} type="button" className="ca-pill" title={s.note} onClick={() => pull(s.id)}>
                            {s.id}
                        </button>
                    ))}
                    <a className="ca-muted" href="https://ollama.com/library" target="_blank" rel="noopener noreferrer">
                        Browse all
                    </a>
                </div>
            ) : null}
            {error ? (
                <p className="ca-card-note ca-model-error" role="alert">
                    <Icon name="alert" size={13} /> <span>{error}</span>
                </p>
            ) : null}
        </div>
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
            <div className="ca-modal-body ca-preview-dialog">
                <div className="ca-preview-head">
                    <span className="ca-settings-icon">
                        <Icon name="shield" size={18} />
                    </span>
                    <div>
                        <h2>Send this to {p.providerLabel}?</h2>
                        <p className="ca-muted">You asked to see each cloud request before it goes.</p>
                    </div>
                </div>
                <div className="ca-preview-facts">
                    <span className="ca-chip">
                        <Icon name="cloud" size={11} /> {p.model}
                    </span>
                    <span className="ca-chip">≈ {p.estimatedInputTokens.toLocaleString()} tokens</span>
                    <span className="ca-chip">{p.role}</span>
                    {redacted ? (
                        <span className="ca-chip ca-chip-ok">
                            <Icon name="check" size={11} /> {redacted} secret{redacted === 1 ? '' : 's'} removed
                        </span>
                    ) : null}
                </div>
                <details className="ca-setup">
                    <summary>
                        <Icon name="chevron" size={12} className="ca-steps-chevron" /> What will be sent
                    </summary>
                    {p.system ? <pre className="ca-preview">{p.system}</pre> : null}
                    {p.messages.map((m, i) => (
                        <pre key={i} className="ca-preview">
                            <strong>{m.role}:</strong> {m.content}
                        </pre>
                    ))}
                </details>
                <div className="ca-dialog-actions">
                    <button type="button" className="ca-button ca-button-ghost" onClick={() => answer(false)}>
                        Don't send
                    </button>
                    <button type="button" className="ca-button ca-button-primary" onClick={() => answer(true)}>
                        <Icon name="send" /> Send
                    </button>
                </div>
            </div>
        </div>
    );
}
