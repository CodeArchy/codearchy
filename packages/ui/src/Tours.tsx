/**
 * Tours mode: the tour list (the generated Start Here, the repository's
 * `.codearchy/tours`, and your draft), the player docked over the canvas, and
 * the "Add to tour" dialog. The canvas itself follows each step (the Map, the
 * Matrix or Flows), so a tour is the real product, narrated.
 */
import { useEffect, useRef, useState } from 'react';
import type { EngineClient, Tour, TourDetails, TourSummary } from '@codearchy/protocol';
import { Answer } from './ai.js';
import { Icon } from './icons.js';
import { firstUndone, loadProgress, type StepCapture } from './tourModel.js';

// ─── the list ───────────────────────────────────────────────────────────────

export interface ToursListProps {
    client: EngineClient;
    /** Identifies the workspace for progress and the draft. */
    workspace: string;
    dataVersion: number;
    draft?: Tour;
    onPlay(tour: TourDetails, startAt: number): void;
    onDraftChange(draft: Tour | undefined): void;
}

export function ToursList(props: ToursListProps) {
    const { client, draft } = props;
    const [tours, setTours] = useState<TourSummary[]>();
    const [error, setError] = useState('');
    const [busy, setBusy] = useState('');
    const [notice, setNotice] = useState('');
    const [reload, setReload] = useState(0);

    useEffect(() => {
        let live = true;
        if (!client.tours) return;
        client.tours().then(
            (list) => live && (setTours(list), setError('')),
            (err: unknown) => live && setError(err instanceof Error ? err.message : String(err))
        );
        return () => {
            live = false;
        };
    }, [client, props.workspace, props.dataVersion, reload]);

    const play = async (id: string) => {
        if (!client.tour) return;
        setBusy(id);
        try {
            const t = await client.tour(id);
            if (t) props.onPlay(t, firstUndone(t, loadProgress(props.workspace, t.id)));
        } finally {
            setBusy('');
        }
    };

    const saveDraft = async () => {
        if (!draft) return;
        setBusy('draft');
        setNotice('');
        try {
            if (client.saveTour) {
                const { file } = await client.saveTour(draft);
                props.onDraftChange(undefined);
                setNotice(`Saved to ${file}. Commit it to share the tour.`);
                setReload((n) => n + 1);
            } else {
                const anchored = client.anchorTour ? await client.anchorTour(draft) : draft;
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
    return (
        <div className="ca-tours">
            <div className="ca-tours-inner">
                <header className="ca-tours-head">
                    <h2>Tours</h2>
                    <p className="ca-muted">Guided walks through the code: each step moves the map, explains what you're looking at and points at the lines worth reading.</p>
                </header>
                {notice ? (
                    <p className="ca-card-note" role="status">
                        <Icon name="info" size={14} />
                        <span>{notice}</span>
                    </p>
                ) : null}
                <ul className="ca-tour-cards">
                    {draft ? (
                        <li className="ca-tour-card ca-tour-draft">
                            <div className="ca-tour-card-head">
                                <span className="ca-chip">Draft</span>
                                <h3>{draft.title}</h3>
                            </div>
                            <p className="ca-muted">
                                {draft.steps.length} step{draft.steps.length === 1 ? '' : 's'} added with "Add to tour". Only you can see it until it's saved.
                            </p>
                            <div className="ca-tour-card-actions">
                                <button type="button" className="ca-button" onClick={() => props.onPlay({ ...draft, status: draft.steps.map(() => ({})) }, 0)}>
                                    <Icon name="play" size={13} /> Play
                                </button>
                                <button type="button" className="ca-button ca-button-soft" disabled={busy === 'draft'} onClick={() => void saveDraft()}>
                                    <Icon name="check" size={13} /> {client.saveTour ? 'Save to .codearchy/tours' : 'Download .json'}
                                </button>
                                <button type="button" className="ca-button" onClick={() => props.onDraftChange(undefined)}>
                                    <Icon name="trash" size={13} /> Discard
                                </button>
                            </div>
                        </li>
                    ) : null}
                    {tours.map((t) => {
                        const done = loadProgress(props.workspace, t.id).size;
                        const pct = t.steps ? Math.round((Math.min(done, t.steps) / t.steps) * 100) : 0;
                        return (
                            <li key={t.id} className={`ca-tour-card${t.id === 'start-here' ? ' ca-tour-featured' : ''}`}>
                                <div className="ca-tour-card-head">
                                    <span className="ca-chip">{t.origin === 'generated' ? 'Generated' : 'In the repository'}</span>
                                    <h3>{t.title}</h3>
                                </div>
                                {t.description ? <p className="ca-muted">{t.description}</p> : null}
                                {t.file ? <p className="ca-path ca-muted">{t.file}</p> : null}
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
                                            <button type="button" className={`ca-button${t.id === 'start-here' ? ' ca-button-primary' : ''}`} disabled={busy === t.id} onClick={() => void play(t.id)}>
                                                <Icon name="play" size={13} /> {done && done < t.steps ? 'Resume' : done >= t.steps && t.steps ? 'Replay' : 'Start'}
                                            </button>
                                        </div>
                                    </>
                                )}
                            </li>
                        );
                    })}
                </ul>
                <p className="ca-muted ca-tours-hint">
                    Make your own: select a part on the map (or a flow) and choose <strong>Add to tour</strong> in the Inspector. Saved tours live in <code>.codearchy/tours/</code>, so they're reviewed and shared like code.
                </p>
            </div>
        </div>
    );
}

function slug(title: string): string {
    return (
        title
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean)
            .join('-')
            .slice(0, 60) || 'tour'
    );
}

/** The `.codearchy/tours` file format (the engine validates the same shape when reading). */
function tourFile(t: Tour): string {
    const { origin: _o, id: _i, ...rest } = t;
    return `${JSON.stringify({ ...rest, version: t.version }, null, 2)}\n`;
}

function download(name: string, text: string): void {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
                <span className="ca-muted">
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
