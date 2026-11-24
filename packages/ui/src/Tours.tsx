/**
 * Tours mode: the tour list (the generated Start Here, walk-throughs of the
 * system's flows, the repository's `.codearchy/tours`, and your draft), the
 * editor for the draft, the player docked over the canvas (narrated when the
 * host has a voice), and the "Add to tour" dialog. The canvas itself follows
 * each step (the Map, the Matrix or Flows), so a tour is the real product,
 * narrated.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { EngineClient, Flow, FlowSummary, TourDetails, TourSummary } from '@codearchy/protocol';
import { Answer } from './ai.js';
import { Icon } from './icons.js';
import { flowRows, splitLabel } from './flowModel.js';
import { draftFrom, firstUndone, loadNarration, loadProgress, moveStep, saveNarration, saveProgress, slug, tourFile, tourFromFlow, tourToSave, updateStep, type DraftTour, type StepCapture } from './tourModel.js';
import { SpeakingBars, speechText, useVoiceState } from './voice.js';
import type { NarrationProgress, Narrator } from './narration.js';
import type { TourStep } from '@codearchy/protocol';

/** What the narrator says for a step. */
export function stepSpeech(step: Pick<TourStep, 'title' | 'body'>): string {
    return `${step.title}. ${speechText(step.body)}`;
}

// ─── the list ───────────────────────────────────────────────────────────────

export interface ToursListProps {
    client: EngineClient;
    /** Identifies the workspace for progress and the draft. */
    workspace: string;
    dataVersion: number;
    draft?: DraftTour;
    onPlay(tour: TourDetails, startAt: number): void;
    onDraftChange(draft: DraftTour | undefined): void;
    /** Walk through a flow (Flows' "Walk through"). */
    onWalkFlow?(flow: Flow): void;
    /** Open Flows mode (to see every entrypoint). */
    onShowFlows?(): void;
    /** With a voice that can be kept: Start Here's first steps are made ahead, so starting it speaks at once. */
    narrator?: Narrator;
}

/** Flow walk-throughs offered in the list (the rest are in Flows). */
const LISTED_FLOWS = 6;

export function ToursList(props: ToursListProps) {
    const { client, draft } = props;
    const [tours, setTours] = useState<TourSummary[]>();
    const [flows, setFlows] = useState<FlowSummary[]>([]);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState('');
    const [notice, setNotice] = useState('');
    const [reload, setReload] = useState(0);
    const [editing, setEditing] = useState(false);
    /** A copy waiting for "replace your draft?" confirmation. */
    const [pendingDraft, setPendingDraft] = useState<DraftTour>();
    const [, bump] = useState(0);

    useEffect(() => {
        let live = true;
        if (!client.tours) return;
        client.tours().then(
            (list) => live && (setTours(list), setError('')),
            (err: unknown) => live && setError(err instanceof Error ? err.message : String(err))
        );
        client.flows?.().then(
            (list) => live && setFlows(list),
            () => undefined
        );
        return () => {
            live = false;
        };
    }, [client, props.workspace, props.dataVersion, reload]);

    // Warm the narration for Start Here's opening steps while the list is open.
    const warmKey = props.narrator?.voice.cacheKey?.() ?? '';
    useEffect(() => {
        const n = props.narrator;
        if (!n || !warmKey || !client.tour || !tours?.some((t) => t.id === 'start-here')) return;
        void client.tour('start-here').then((t) => t && n.prefetch(t.steps.slice(0, 2).map(stepSpeech), { first: 1, priority: 'later' }));
    }, [props.narrator, warmKey, tours]); // eslint-disable-line react-hooks/exhaustive-deps

    const play = async (id: string, restart = false) => {
        if (!client.tour) return;
        setBusy(id);
        try {
            const t = await client.tour(id);
            if (t) props.onPlay(t, restart ? 0 : firstUndone(t, loadProgress(props.workspace, t.id)));
        } finally {
            setBusy('');
        }
    };

    const startDraft = (next: DraftTour) => {
        if (draft && draft.steps.length) return setPendingDraft(next);
        props.onDraftChange(next);
        setEditing(true);
    };

    const copyTour = async (id: string, edit: boolean) => {
        if (!client.tour) return;
        setBusy(id);
        try {
            const t = await client.tour(id);
            if (t) startDraft(draftFrom(t, edit));
        } finally {
            setBusy('');
        }
    };

    const copyFlow = async (id: string) => {
        if (!client.flow) return;
        setBusy(id);
        try {
            const f = await client.flow(id);
            if (!f) return;
            startDraft(draftFrom({ ...tourFromFlow(f, flowRows(f).map((r) => r.index)), origin: 'authored', id: 'copy' }));
        } finally {
            setBusy('');
        }
    };

    const walkFlow = async (id: string) => {
        if (!client.flow || !props.onWalkFlow) return;
        setBusy(id);
        try {
            const f = await client.flow(id);
            if (f) props.onWalkFlow(f);
        } finally {
            setBusy('');
        }
    };

    const exportTour = async (id: string) => {
        if (!client.tour) return;
        const t = await client.tour(id);
        if (!t) return;
        const anchored = client.anchorTour ? await client.anchorTour(t) : t;
        download(`${slug(t.title)}.json`, tourFile(anchored));
    };

    const removeTour = async (t: TourSummary) => {
        if (!client.deleteTour) return;
        setBusy(t.id);
        try {
            await client.deleteTour(t.id);
            saveProgress(props.workspace, t.id, new Set());
            setNotice(`Deleted ${t.file ?? t.title}. Commit the change to remove it for everyone.`);
            setReload((n) => n + 1);
        } catch (err) {
            setNotice(`Couldn't delete the tour: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setBusy('');
        }
    };

    const saveDraft = async () => {
        if (!draft) return;
        setBusy('draft');
        setNotice('');
        try {
            const tour = tourToSave(draft);
            if (client.saveTour) {
                const { file } = await client.saveTour(tour);
                props.onDraftChange(undefined);
                setNotice(`Saved to ${file}. Commit it to share the tour.`);
                setReload((n) => n + 1);
            } else {
                const anchored = client.anchorTour ? await client.anchorTour(tour) : tour;
                download(`${slug(draft.title)}.json`, tourFile(anchored));
                setNotice(`Downloaded. Put it in .codearchy/tours/ in the repository and commit it.`);
            }
        } catch (err) {
            setNotice(`Couldn't save the tour: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setBusy('');
        }
    };

    if (error) return <div className="ca-flows-empty" role="alert">Couldn't load tours: {error}</div>;
    if (!tours) return <div className="ca-flows-empty">Preparing tours…</div>;
    const generated = tours.filter((t) => t.origin === 'generated');
    const authored = tours.filter((t) => t.origin === 'authored');
    const card = (t: TourSummary) => (
        <TourCard
            key={t.id}
            tour={t}
            workspace={props.workspace}
            busy={busy === t.id}
            onPlay={(restart) => void play(t.id, restart)}
            onResetProgress={() => {
                saveProgress(props.workspace, t.id, new Set());
                bump((n) => n + 1);
            }}
            onCopy={() => void copyTour(t.id, false)}
            onEdit={t.origin === 'authored' && !t.error ? () => void copyTour(t.id, true) : undefined}
            onExport={() => void exportTour(t.id)}
            onDelete={t.origin === 'authored' && client.deleteTour ? () => void removeTour(t) : undefined}
        />
    );

    return (
        <div className="ca-tours">
            <div className="ca-tours-inner">
                <header className="ca-tours-head">
                    <div>
                        <h2>Tours</h2>
                        <p className="ca-muted">Guided, narrated walks through the code: each step moves the map, explains what you're looking at and points at the lines worth reading.</p>
                    </div>
                </header>
                {notice ? (
                    <p className="ca-card-note" role="status">
                        <Icon name="info" size={14} />
                        <span>{notice}</span>
                    </p>
                ) : null}
                {pendingDraft ? (
                    <div className="ca-banner ca-banner-warn" role="alertdialog" aria-label="Replace your draft?">
                        <Icon name="alert" size={16} />
                        <span className="ca-toolbar-gap">
                            You already have a draft, <strong>{draft?.title}</strong> ({draft?.steps.length} steps). Replace it with <strong>{pendingDraft.title}</strong>?
                        </span>
                        <button
                            type="button"
                            className="ca-button ca-button-primary"
                            onClick={() => {
                                props.onDraftChange(pendingDraft);
                                setPendingDraft(undefined);
                                setEditing(true);
                            }}
                        >
                            Replace
                        </button>
                        <button type="button" className="ca-button" onClick={() => setPendingDraft(undefined)}>
                            Keep my draft
                        </button>
                    </div>
                ) : null}

                {draft ? (
                    <Section title="Your draft" icon="edit">
                        <li className="ca-tour-card ca-tour-draft">
                            <div className="ca-tour-card-head">
                                <span className="ca-chip">{draft.replaces ? 'Editing' : 'Draft'}</span>
                                <h3>{draft.title}</h3>
                            </div>
                            <p className="ca-muted">
                                {draft.steps.length} step{draft.steps.length === 1 ? '' : 's'}.{' '}
                                {draft.replaces ? `Saving replaces .codearchy/tours/${draft.replaces}.json.` : 'Only you can see it until it’s saved.'}
                            </p>
                            <div className="ca-tour-card-actions">
                                <button type="button" className="ca-button ca-button-primary" onClick={() => props.onPlay({ ...draft, status: draft.steps.map(() => ({})) }, 0)}>
                                    <Icon name="play" size={13} /> Play
                                </button>
                                <button type="button" className="ca-button" onClick={() => setEditing(true)}>
                                    <Icon name="edit" size={13} /> Edit steps
                                </button>
                                <button type="button" className="ca-button ca-button-soft" disabled={busy === 'draft'} onClick={() => void saveDraft()}>
                                    <Icon name={client.saveTour ? 'check' : 'download'} size={13} /> {client.saveTour ? 'Save to .codearchy/tours' : 'Download .json'}
                                </button>
                                <button type="button" className="ca-button ca-button-ghost" onClick={() => props.onDraftChange(undefined)}>
                                    <Icon name="trash" size={13} /> Discard
                                </button>
                            </div>
                        </li>
                    </Section>
                ) : null}

                {generated.length ? (
                    <Section title="Start here" icon="sparkles">
                        {generated.map(card)}
                    </Section>
                ) : null}

                {flows.length && props.onWalkFlow ? (
                    <Section
                        title="Walk through a flow"
                        icon="flow"
                        aside={
                            props.onShowFlows && flows.length > LISTED_FLOWS ? (
                                <button type="button" className="ca-link" onClick={props.onShowFlows}>
                                    All {flows.length} in Flows
                                </button>
                            ) : undefined
                        }
                    >
                        {flows.slice(0, LISTED_FLOWS).map((f) => {
                            const { verb, rest } = splitLabel(f.label);
                            return (
                                <li key={f.id} className="ca-tour-card ca-tour-flow">
                                    <div className="ca-tour-card-head">
                                        {verb ? <span className={`ca-verb ca-verb-${verb.toLowerCase()}`}>{verb}</span> : null}
                                        <h3 className="ca-mono">{rest || '/'}</h3>
                                        <span className="ca-muted ca-tour-flow-meta">
                                            {f.framework} · {f.file.split('/').pop()}
                                        </span>
                                        <span className="ca-toolbar-gap" />
                                        <button type="button" className="ca-button" disabled={busy === f.id} onClick={() => void walkFlow(f.id)}>
                                            <Icon name="play" size={13} /> Walk through
                                        </button>
                                        <button type="button" className="ca-icon-button" title="Make an editable copy" aria-label={`Make an editable tour from ${f.label}`} disabled={busy === f.id} onClick={() => void copyFlow(f.id)}>
                                            <Icon name="edit" size={14} />
                                        </button>
                                    </div>
                                </li>
                            );
                        })}
                    </Section>
                ) : null}

                <Section title="In the repository" icon="boxes">
                    {authored.length ? (
                        authored.map(card)
                    ) : (
                        <li className="ca-tours-empty ca-muted">
                            None yet. Tours saved here live in <code>.codearchy/tours/</code>, so they’re reviewed and shared like code.
                        </li>
                    )}
                </Section>

                <p className="ca-muted ca-tours-hint">
                    <strong>Make your own:</strong> select a part on the map (or a flow) and choose <strong>Add to tour</strong>, or make an editable copy of any tour above.
                </p>
            </div>
            {editing && draft ? <TourEditor draft={draft} onChange={props.onDraftChange} onClose={() => setEditing(false)} /> : null}
        </div>
    );
}

function Section({ title, icon, aside, children }: { title: string; icon: Parameters<typeof Icon>[0]['name']; aside?: ReactNode; children: ReactNode }) {
    return (
        <section className="ca-tour-section" aria-label={title}>
            <h3 className="ca-panel-title ca-tour-section-title">
                <Icon name={icon} size={12} /> {title}
                {aside ? <span className="ca-tour-section-aside">{aside}</span> : null}
            </h3>
            <ul className="ca-tour-cards">{children}</ul>
        </section>
    );
}

interface TourCardProps {
    tour: TourSummary;
    workspace: string;
    busy: boolean;
    onPlay(restart: boolean): void;
    onResetProgress(): void;
    onCopy(): void;
    onEdit?(): void;
    onExport(): void;
    onDelete?(): void;
}

function TourCard({ tour: t, workspace, busy, ...on }: TourCardProps) {
    const [confirmDelete, setConfirmDelete] = useState(false);
    const done = loadProgress(workspace, t.id).size;
    const pct = t.steps ? Math.round((Math.min(done, t.steps) / t.steps) * 100) : 0;
    const finished = t.steps > 0 && done >= t.steps;
    return (
        <li className={`ca-tour-card${t.id === 'start-here' ? ' ca-tour-featured' : ''}`}>
            <div className="ca-tour-card-head">
                <span className="ca-chip">{t.origin === 'generated' ? 'Generated' : 'In the repository'}</span>
                <h3>{t.title}</h3>
                <span className="ca-toolbar-gap" />
                <Menu
                    label={`More actions for ${t.title}`}
                    items={[
                        ...(done ? [{ label: 'Start over', icon: 'replay' as const, run: () => on.onPlay(true) }, { label: 'Reset progress', icon: 'refresh' as const, run: on.onResetProgress }] : []),
                        ...(on.onEdit ? [{ label: 'Edit', icon: 'edit' as const, run: on.onEdit }] : []),
                        { label: 'Make an editable copy', icon: 'copy' as const, run: on.onCopy, disabled: !!t.error },
                        { label: 'Download .json', icon: 'download' as const, run: on.onExport, disabled: !!t.error },
                        ...(on.onDelete ? [{ label: 'Delete…', icon: 'trash' as const, run: () => setConfirmDelete(true), danger: true }] : []),
                    ]}
                />
            </div>
            {t.description ? <p className="ca-muted">{t.description}</p> : null}
            {t.file ? <p className="ca-path ca-muted">{t.file}</p> : null}
            {confirmDelete ? (
                <div className="ca-banner ca-banner-warn" role="alertdialog" aria-label="Delete this tour?">
                    <Icon name="trash" size={14} />
                    <span className="ca-toolbar-gap">
                        Delete <code>{t.file}</code> from the workspace?
                    </span>
                    <button
                        type="button"
                        className="ca-button ca-button-danger"
                        onClick={() => {
                            setConfirmDelete(false);
                            on.onDelete?.();
                        }}
                    >
                        Delete
                    </button>
                    <button type="button" className="ca-button" onClick={() => setConfirmDelete(false)}>
                        Cancel
                    </button>
                </div>
            ) : null}
            {t.error ? (
                <p className="ca-card-note" role="alert">
                    <Icon name="alert" size={14} />
                    <span>This file isn't a valid tour: {t.error}</span>
                </p>
            ) : (
                <>
                    <div className="ca-tour-progress" aria-label={`${done} of ${t.steps} steps done`}>
                        <span style={{ width: `${pct}%` }} />
                    </div>
                    <p className="ca-tour-meta">
                        {t.steps} step{t.steps === 1 ? '' : 's'}
                        {done ? ` · ${Math.min(done, t.steps)} done` : ''}
                        {t.stale ? (
                            <span className="ca-tour-stale">
                                <Icon name="alert" size={12} /> {t.stale} out of date
                            </span>
                        ) : null}
                    </p>
                    <div className="ca-tour-card-actions">
                        <button type="button" className={`ca-button${t.id === 'start-here' ? ' ca-button-primary' : ''}`} disabled={busy} onClick={() => on.onPlay(finished)}>
                            <Icon name="play" size={13} /> {done && !finished ? 'Resume' : finished ? 'Replay' : 'Start'}
                        </button>
                    </div>
                </>
            )}
        </li>
    );
}

interface MenuItem {
    label: string;
    icon: Parameters<typeof Icon>[0]['name'];
    run(): void;
    disabled?: boolean;
    danger?: boolean;
}

/** A small "⋯" menu: Escape or a click elsewhere closes it. */
export function Menu({ label, items }: { label: string; items: MenuItem[] }) {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const away = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
        document.addEventListener('mousedown', away);
        return () => document.removeEventListener('mousedown', away);
    }, [open]);
    return (
        <div className="ca-menu-root" ref={root} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
            <button type="button" className="ca-icon-button" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
                <Icon name="more" size={16} />
            </button>
            {open ? (
                <ul className="ca-menu" role="menu">
                    {items.map((it) => (
                        <li key={it.label} role="none">
                            <button
                                type="button"
                                role="menuitem"
                                className={it.danger ? 'ca-danger' : ''}
                                disabled={it.disabled}
                                onClick={() => {
                                    setOpen(false);
                                    it.run();
                                }}
                            >
                                <Icon name={it.icon} size={13} /> {it.label}
                            </button>
                        </li>
                    ))}
                </ul>
            ) : null}
        </div>
    );
}

function download(name: string, text: string): void {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── the editor ─────────────────────────────────────────────────────────────

export function TourEditor({ draft, onChange, onClose }: { draft: DraftTour; onChange(d: DraftTour | undefined): void; onClose(): void }) {
    const first = useRef<HTMLInputElement>(null);
    useEffect(() => first.current?.focus(), []);
    return (
        <div className="ca-modal" onClick={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
            <div className="ca-modal-body ca-modal-wide ca-add-step ca-tour-editor" role="dialog" aria-modal="true" aria-label="Edit tour">
                <div className="ca-settings-head">
                    <span className="ca-settings-icon">
                        <Icon name="map" size={18} />
                    </span>
                    <h2>Edit tour</h2>
                    <span className="ca-toolbar-gap" />
                    <button type="button" className="ca-button ca-button-ghost" onClick={onClose}>
                        <Icon name="check" /> Done
                    </button>
                </div>
                <label>
                    Title
                    <input ref={first} value={draft.title} onChange={(e) => onChange({ ...draft, title: e.target.value })} />
                </label>
                <label>
                    Description <span className="ca-muted">(optional)</span>
                    <input value={draft.description ?? ''} placeholder="What a newcomer learns from it" onChange={(e) => onChange({ ...draft, ...(e.target.value ? { description: e.target.value } : { description: undefined }) })} />
                </label>
                <ol className="ca-editor-steps">
                    {draft.steps.map((s, i) => (
                        <li key={s.id} className="ca-editor-step">
                            <div className="ca-editor-step-head">
                                <span className="ca-editor-num">{i + 1}</span>
                                <input aria-label={`Step ${i + 1} title`} value={s.title} onChange={(e) => onChange(updateStep(draft, s.id, { title: e.target.value }))} />
                                <button type="button" className="ca-icon-button" aria-label="Move up" title="Move up" disabled={i === 0} onClick={() => onChange(moveStep(draft, s.id, -1))}>
                                    <Icon name="arrowUp" size={14} />
                                </button>
                                <button type="button" className="ca-icon-button" aria-label="Move down" title="Move down" disabled={i === draft.steps.length - 1} onClick={() => onChange(moveStep(draft, s.id, 1))}>
                                    <Icon name="arrowDown" size={14} />
                                </button>
                                <button
                                    type="button"
                                    className="ca-icon-button"
                                    aria-label="Remove step"
                                    title="Remove step"
                                    onClick={() => {
                                        const steps = draft.steps.filter((x) => x.id !== s.id);
                                        onChange(steps.length ? { ...draft, steps } : undefined);
                                        if (!steps.length) onClose();
                                    }}
                                >
                                    <Icon name="trash" size={14} />
                                </button>
                            </div>
                            <textarea aria-label={`Step ${i + 1} text`} rows={3} value={s.body} placeholder="What should a newcomer notice here?" onChange={(e) => onChange(updateStep(draft, s.id, { body: e.target.value }))} />
                            <span className="ca-muted ca-editor-target">
                                Shows {s.view?.mode === 'flows' ? 'the flow' : s.view?.mode === 'matrix' ? 'the matrix' : 'the map'} at <code>{s.view?.focus ?? s.target.node ?? s.target.flow ?? 'the top'}</code>
                            </span>
                        </li>
                    ))}
                </ol>
                <p className="ca-muted">Changes are kept as you type. Add more steps with <strong>Add to tour</strong> on the map or in Flows.</p>
            </div>
        </div>
    );
}

// ─── the player ─────────────────────────────────────────────────────────────

export interface TourPlayerProps {
    tour: TourDetails;
    index: number;
    done: ReadonlySet<string>;
    onIndex(index: number): void;
    onClose(): void;
    onToggleDone(stepId: string): void;
    onNode(key: string): void;
    onFile?(path: string, line?: number): void;
    onAsk?(question: string): void;
    /** Draft tours: take a step out. */
    onRemove?(stepId: string): void;
    /** With it, steps are narrated (made ahead and kept when the voice allows). */
    narrator?: Narrator;
    onVoiceSettings?(): void;
}

export function TourPlayer(props: TourPlayerProps) {
    const { tour, index, done } = props;
    const step = tour.steps[index];
    const status = tour.status[index] ?? {};
    const [collapsed, setCollapsed] = useState(false);
    const heading = useRef<HTMLHeadingElement>(null);
    // Move focus to the new step for keyboard and screen-reader users.
    useEffect(() => heading.current?.focus({ preventScroll: true }), [index, tour.id]);
    if (!step) return null;
    const last = index === tour.steps.length - 1;
    return (
        <section className={`ca-tour-player${collapsed ? ' ca-collapsed' : ''}`} aria-label={`Tour: ${tour.title}`}>
            <header className="ca-tour-player-head">
                <Icon name="map" size={14} />
                <span className="ca-tour-player-title" title={tour.title}>
                    {tour.title}
                </span>
                <span className="ca-muted ca-nowrap">
                    Step {index + 1} of {tour.steps.length}
                </span>
                <ol className="ca-tour-dots" aria-label="Steps">
                    {tour.steps.map((s, i) => (
                        <li key={s.id}>
                            <button
                                type="button"
                                aria-label={`Step ${i + 1}: ${s.title}${done.has(s.id) ? ' (done)' : ''}`}
                                aria-current={i === index ? 'step' : undefined}
                                className={`${i === index ? 'ca-on' : ''}${done.has(s.id) ? ' ca-done' : ''}${tour.status[i]?.stale ? ' ca-stale' : ''}`}
                                onClick={() => props.onIndex(i)}
                            />
                        </li>
                    ))}
                </ol>
                <button type="button" className="ca-icon-button" aria-label={collapsed ? 'Show the step' : 'Hide the step'} title={collapsed ? 'Show the step' : 'Hide the step'} onClick={() => setCollapsed((c) => !c)}>
                    <Icon name="chevron" size={14} className={collapsed ? 'ca-rot-270' : 'ca-rot-90'} />
                </button>
                <button type="button" className="ca-icon-button" aria-label="Close the tour" title="Close the tour" onClick={props.onClose}>
                    <Icon name="close" size={14} />
                </button>
            </header>
            {props.narrator ? <Narration narrator={props.narrator} tour={tour} index={index} last={last} onNext={() => props.onIndex(index + 1)} onSettings={props.onVoiceSettings} /> : null}
            {collapsed ? null : (
                <div className="ca-tour-step">
                    <h3 ref={heading} tabIndex={-1}>
                        {step.title}
                    </h3>
                    {status.stale ? (
                        <p className="ca-tour-stale-note" role="note">
                            <Icon name="alert" size={13} />
                            <span>
                                {status.stale === 'missing' ? 'Out of date: ' : 'May be out of date: '}
                                {status.reason ?? 'the code changed since this step was written'}.
                            </span>
                        </p>
                    ) : null}
                    {step.body ? <Answer text={step.body} links={{ onNode: props.onNode, ...(props.onFile ? { onFile: props.onFile } : {}) }} /> : null}
                    {step.code?.length ? (
                        <div className="ca-tour-code">
                            {step.code.map((c) => (
                                <button
                                    key={`${c.path}:${c.start}`}
                                    type="button"
                                    className="ca-sink"
                                    disabled={!props.onFile}
                                    title={props.onFile ? 'Open in the editor' : undefined}
                                    onClick={() => props.onFile?.(c.path, c.start - 1)}
                                >
                                    <Icon name="code" size={12} />
                                    {c.path.split('/').pop()}:{c.start}
                                    {c.end > c.start ? `–${c.end}` : ''}
                                </button>
                            ))}
                        </div>
                    ) : null}
                    <footer className="ca-tour-nav">
                        <button type="button" className="ca-button" disabled={index === 0} onClick={() => props.onIndex(index - 1)}>
                            Back
                        </button>
                        <label className="ca-tour-done">
                            <input type="checkbox" checked={done.has(step.id)} onChange={() => props.onToggleDone(step.id)} /> Done
                        </label>
                        {props.onAsk ? (
                            <button type="button" className="ca-button ca-button-soft" onClick={() => props.onAsk!(`In the tour step "${step.title}": ${step.body.slice(0, 300)}\n\nExplain this part in more depth.`)}>
                                <Icon name="chat" size={13} /> Ask about this step
                            </button>
                        ) : null}
                        {props.onRemove ? (
                            <button type="button" className="ca-button" onClick={() => props.onRemove!(step.id)}>
                                <Icon name="trash" size={13} /> Remove step
                            </button>
                        ) : null}
                        <span className="ca-toolbar-gap" />
                        <button type="button" className="ca-button ca-button-primary" onClick={() => (last ? props.onClose() : props.onIndex(index + 1))}>
                            {last ? 'Finish' : 'Next'}
                            {last ? <Icon name="check" size={13} /> : <Icon name="chevron" size={13} />}
                        </button>
                    </footer>
                </div>
            )}
        </section>
    );
}

/**
 * The narrator: reads each step aloud as it opens (unless muted), and with
 * auto-play moves on when it finishes. Preferences are remembered per viewer.
 */
function Narration({ narrator, tour, index, last, onNext, onSettings }: { narrator: Narrator; tour: TourDetails; index: number; last: boolean; onNext(): void; onSettings?(): void }) {
    const voice = narrator.voice;
    const state = useVoiceState(voice);
    const [prefs, setPrefs] = useState(loadNarration);
    const [replay, setReplay] = useState(0);
    const [made, setMade] = useState<NarrationProgress>({ ready: 0, total: 0 });
    useEffect(() => narrator.subscribe(setMade), [narrator]);
    const step = tour.steps[index];
    const next = useRef(onNext);
    next.current = onNext;
    const update = (p: Partial<typeof prefs>) =>
        setPrefs((cur) => {
            const n = { ...cur, ...p };
            saveNarration(n);
            return n;
        });
    /** Changes when another voice or speed becomes the one that speaks: kept audio is per voice. */
    const cacheKey = voice.cacheKey?.() ?? '';

    // Make the steps ahead of time: the next one first, then the rest of the tour (kept for revisits).
    useEffect(() => {
        if (!prefs.narrate || !cacheKey) return;
        const order = [...tour.steps.slice(index + 1), ...tour.steps.slice(0, index), ...(voice.capturesSpeech ? [] : [tour.steps[index]!])];
        narrator.prefetch(order.map(stepSpeech), { first: 1 });
    }, [narrator, tour, index, prefs.narrate, cacheKey]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => () => narrator.cancelPrefetch(), [narrator, tour.id]);

    useEffect(() => {
        if (!prefs.narrate || !step) return;
        let cancelled = false;
        narrator.speak(stepSpeech(step), {
            onEnd: () => {
                if (!cancelled && prefs.auto && !last) next.current();
            },
        });
        return () => {
            cancelled = true;
            narrator.stop();
        };
    }, [narrator, tour.id, index, prefs.narrate, replay]); // eslint-disable-line react-hooks/exhaustive-deps

    const kokoroAvailable = state.engines.some((e) => e.id === 'kokoro' && e.available);
    const busy = state.kokoro.status === 'downloading' || state.kokoro.status === 'loading';
    return (
        <div className="ca-narration" role="group" aria-label="Narration">
            <button
                type="button"
                className={`ca-button ca-button-ghost ca-narrate-toggle${prefs.narrate ? ' ca-on' : ''}`}
                aria-pressed={prefs.narrate}
                title={prefs.narrate ? 'Mute the narrator' : 'Read each step aloud'}
                onClick={() => update({ narrate: !prefs.narrate })}
            >
                <Icon name={prefs.narrate ? 'volume' : 'mute'} size={14} />
                {prefs.narrate ? 'Narrating' : 'Narration off'}
            </button>
            {prefs.narrate ? (
                <>
                    <SpeakingBars active={state.speaking} />
                    <span className="ca-muted ca-narration-state" role="status">
                        {state.preparing
                            ? 'Preparing voice…'
                            : busy
                              ? `Natural voice ${state.kokoro.status === 'downloading' ? 'downloading' : 'loading'} ${state.kokoro.progress ?? 0}%`
                              : cacheKey && made.total && made.ready < made.total
                                ? `Voice ready for ${made.ready} of ${made.total} steps ahead`
                                : ''}
                    </span>
                    <button type="button" className="ca-icon-button" title={state.speaking ? 'Stop' : 'Read this step again'} aria-label={state.speaking ? 'Stop reading' : 'Read this step again'} onClick={() => (state.speaking || state.preparing ? narrator.stop() : setReplay((n) => n + 1))}>
                        <Icon name={state.speaking || state.preparing ? 'pause' : 'replay'} size={14} />
                    </button>
                </>
            ) : null}
            <span className="ca-toolbar-gap" />
            <label className="ca-tour-done" title="Move to the next step when the narrator finishes">
                <input type="checkbox" checked={prefs.auto} disabled={!prefs.narrate} onChange={(e) => update({ auto: e.target.checked })} /> Auto-play
            </label>
            {state.engine === 'system' && kokoroAvailable && onSettings ? (
                <button type="button" className="ca-link ca-narration-upgrade" onClick={onSettings}>
                    Try the natural voice
                </button>
            ) : null}
            {onSettings ? (
                <button type="button" className="ca-icon-button" title="Voice settings" aria-label="Voice settings" onClick={onSettings}>
                    <Icon name="sliders" size={14} />
                </button>
            ) : null}
        </div>
    );
}

// ─── "Add to tour" ──────────────────────────────────────────────────────────

export interface AddToTourProps {
    capture: StepCapture;
    /** The draft's title when one exists (new steps join it). */
    draftTitle?: string;
    onAdd(capture: StepCapture, tourTitle: string): void;
    onClose(): void;
}

export function AddToTourDialog({ capture, draftTitle, onAdd, onClose }: AddToTourProps) {
    const [title, setTitle] = useState(capture.title);
    const [body, setBody] = useState(capture.body);
    const [tourTitle, setTourTitle] = useState(draftTitle ?? '');
    const first = useRef<HTMLInputElement>(null);
    useEffect(() => first.current?.focus(), []);
    return (
        <div className="ca-modal" onClick={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
            <form
                className="ca-modal-body ca-add-step"
                role="dialog"
                aria-modal="true"
                aria-label="Add to tour"
                onSubmit={(e) => {
                    e.preventDefault();
                    onAdd({ ...capture, title, body }, tourTitle);
                }}
            >
                <h2>
                    <Icon name="map" size={16} /> Add to tour
                </h2>
                {draftTitle === undefined ? (
                    <label>
                        Tour title
                        <input value={tourTitle} placeholder="e.g. How an order is placed" onChange={(e) => setTourTitle(e.target.value)} />
                    </label>
                ) : (
                    <p className="ca-muted">
                        Adding a step to <strong>{draftTitle}</strong>.
                    </p>
                )}
                <label>
                    Step title
                    <input ref={first} required value={title} onChange={(e) => setTitle(e.target.value)} />
                </label>
                <label>
                    What should a newcomer notice here?
                    <textarea rows={5} value={body} placeholder="Why this part exists, what it's responsible for, what to watch out for. Link parts as [Name](node:key)." onChange={(e) => setBody(e.target.value)} />
                </label>
                <p className="ca-muted ca-add-step-target">
                    Shows {capture.view.mode === 'flows' ? 'the flow' : 'the map'} at <code>{capture.target.flow ?? capture.target.node ?? 'this view'}</code>
                    {capture.code?.length ? ` with ${capture.code.map((c) => `${c.path.split('/').pop()}:${c.start}–${c.end}`).join(', ')}` : ''}.
                </p>
                <div className="ca-tour-card-actions">
                    <button type="submit" className="ca-button ca-button-primary">
                        <Icon name="plus" size={13} /> Add step
                    </button>
                    <button type="button" className="ca-button" onClick={onClose}>
                        Cancel
                    </button>
                </div>
            </form>
        </div>
    );
}

