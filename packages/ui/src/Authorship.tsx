/**
 * The Inspector's Authorship section: how much of the selected part AI tools
 * wrote (and people since changed), by tool, over time, in which files, and
 * from which commits. Evidence only (doc 07): what has none is "unknown".
 * No person is named anywhere.
 */
import { useEffect, useState } from 'react';
import type { AuthorshipStatus, NodeAuthorship } from '@codearchy/protocol';
import { AUTHORSHIP_ORIGINS, agentName, authorshipShares, type LensId } from './model.js';
import { AuthorshipBar } from './MapCanvas.js';

export interface AuthorshipSource {
    status(): Promise<AuthorshipStatus>;
    load(key: string): Promise<NodeAuthorship | undefined>;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export function AuthorshipSection(props: { nodeKey: string; source: AuthorshipSource; dataVersion: number; lens: LensId; onReveal(key: string): void }) {
    const { nodeKey, source } = props;
    const [status, setStatus] = useState<AuthorshipStatus>();
    const [data, setData] = useState<NodeAuthorship>();

    useEffect(() => {
        let live = true;
        setData(undefined);
        void source.status().then((s) => {
            if (!live) return;
            setStatus(s);
            if (s.state === 'ready') void source.load(nodeKey).then((d) => live && setData(d));
        });
        return () => {
            live = false;
        };
    }, [source, nodeKey, props.dataVersion]);

    const active = props.lens === 'authorship' ? ' ca-lens-active' : '';
    if (!status) return null;
    if (status.state !== 'ready') {
        return (
            <section className={`ca-lens-section ca-authorship${active}`}>
                <h3>Authorship</h3>
                <p className="ca-muted">{status.state === 'computing' ? 'Reading git history…' : (status.reason ?? 'Not available here.')}</p>
            </section>
        );
    }
    if (!data) return null;
    const c = data.counts;
    const total = c.ai + c.reviewed + c.human + c.unknown;
    const shares = authorshipShares(c);
    const agents = Object.entries(data.byAgent).sort((a, b) => b[1] - a[1]);
    const weekly = data.weekly.slice(-26);
    const peak = Math.max(1, ...weekly.map((w) => w.ai));
    return (
        <section className={`ca-lens-section ca-authorship${active}`} aria-label="Authorship">
            <h3>Authorship</h3>
            {total ? (
                <>
                    <AuthorshipBar shares={shares} />
                    <ul className="ca-authorship-legend">
                        {AUTHORSHIP_ORIGINS.map(({ origin, label, title }) => (
                            <li key={origin} title={title}>
                                <span className={`ca-swatch ca-auth-${origin}`} aria-hidden="true" />
                                {label} <strong>{c[origin] > 0 && shares[origin] === 0 ? '<1' : shares[origin]}%</strong> <span className="ca-muted">({c[origin].toLocaleString()} lines)</span>
                            </li>
                        ))}
                    </ul>
                </>
            ) : (
                <p className="ca-muted">No lines here.</p>
            )}
            {total && !c.ai && !c.reviewed ? <p className="ca-muted">No AI-written lines found in this part's history.</p> : null}
            {agents.length ? (
                <>
                    <h4>By tool</h4>
                    <ul className="ca-list">
                        {agents.map(([agent, lines]) => (
                            <li key={agent}>
                                {agentName(agent)} <span className="ca-muted">· {lines.toLocaleString()} lines</span>
                            </li>
                        ))}
                    </ul>
                </>
            ) : null}
            {weekly.length > 1 ? (
                <>
                    <h4>AI lines still here, by week they landed</h4>
                    <svg className="ca-sparkline" viewBox={`0 0 ${weekly.length * 8} 32`} role="img" aria-label={`AI lines by week, ${weekly.length} weeks`}>
                        {weekly.map((w, i) => {
                            const h = Math.max(2, Math.round((w.ai / peak) * 30));
                            return (
                                <rect key={w.week} x={i * 8 + 1} y={32 - h} width={6} height={h} rx={1.5}>
                                    <title>{`Week of ${dateFmt.format(w.week)}: ${w.ai.toLocaleString()} lines`}</title>
                                </rect>
                            );
                        })}
                    </svg>
                </>
            ) : null}
            {data.topFiles.length ? (
                <>
                    <h4>Most AI-written files</h4>
                    <ul className="ca-list">
                        {data.topFiles.map((f) => (
                            <li key={f.path}>
                                <button type="button" className="ca-link" onClick={() => props.onReveal(`mod:${f.path}`)}>
                                    {f.path.split('/').pop()}
                                </button>{' '}
                                <span className="ca-muted">
                                    {f.ai.toLocaleString()} of {f.lines.toLocaleString()} lines
                                </span>
                            </li>
                        ))}
                    </ul>
                </>
            ) : null}
            {data.commits.length ? (
                <>
                    <h4>From these commits</h4>
                    <ul className="ca-list ca-authorship-commits">
                        {data.commits.map((cm) => (
                            <li key={cm.hash} title={`${cm.hash}\n${cm.evidence}`}>
                                <code>{cm.hash.slice(0, 7)}</code> <span className="ca-chip">{agentName(cm.agent)}</span> <span className="ca-muted">{dateFmt.format(cm.time)}</span>
                                <div className="ca-authorship-subject">
                                    {cm.subject} <span className="ca-muted">· {cm.lines.toLocaleString()} lines</span>
                                </div>
                            </li>
                        ))}
                    </ul>
                </>
            ) : null}
            <p className="ca-muted ca-authorship-note">
                From the evidence AI tools leave in git (Co-authored-by trailers, coding-agent bot commits, tool markers), traced to today's lines with git blame. Lines with no evidence are unknown.
            </p>
        </section>
    );
}
