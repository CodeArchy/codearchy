/**
 * Voice in the shared UI: the settings panel (engine, voice, speed, Kokoro's
 * one-time download) and the hook the tour player narrates through. The host
 * owns the speech engines behind a VoiceClient; this file only renders it.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { VoiceClient, VoiceEngineId, VoiceState } from '@codearchy/protocol';
import { Icon, type IconName } from './icons.js';
import type { SpeechEngine, SpeechState } from './speech/engine.js';

/** Plain text for speech: links keep their label, code and markup marks go. */
export function speechText(markdown: string): string {
    return linkLabels(markdown)
        .replace(/`([^`]*)`/g, '$1')
        .replace(/[*_#>]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * `[label](target)` → `label`, in one linear pass (tour text comes from
 * repositories: no regular expression that backtracks on crafted input).
 */
function linkLabels(s: string): string {
    const lastParen = s.lastIndexOf(')');
    let out = '';
    let i = 0;
    while (i < s.length) {
        if (s[i] !== '[') {
            out += s[i++];
            continue;
        }
        let j = i + 1;
        while (j < s.length && s[j] !== ']' && s[j] !== '[') j++;
        // A label, then `(` and a `)` somewhere after it: keep the label, drop the target.
        if (j > i + 1 && s[j] === ']' && s[j + 1] === '(' && j + 2 <= lastParen) {
            const k = s.indexOf(')', j + 2);
            out += s.slice(i + 1, j);
            i = k + 1;
            continue;
        }
        out += s.slice(i, j);
        i = j;
    }
    return out;
}

/** The engine's speaking state (which utterance, which phrase), for indicators. */
export function useSpeechState(speech: SpeechEngine): SpeechState {
    return useSyncExternalStore(
        (on) => speech.subscribe(on),
        () => speech.state()
    );
}

export function useVoiceState(voice: VoiceClient): VoiceState {
    return useSyncExternalStore(
        (on) => voice.subscribe(on),
        () => voice.state()
    );
}

export function formatBytes(n: number): string {
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
    if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
    return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

const ENGINE_ICON: Record<VoiceEngineId, IconName> = { kokoro: 'sparkles', system: 'laptop' };
const SAMPLE = 'This is how CodeArchy sounds when it walks you through a codebase.';

/** What Kokoro is doing, in words (shared by the panel and the tour player). */
export function kokoroLabel(s: VoiceState['kokoro']): string {
    switch (s.status) {
        case 'downloading':
            return `Downloading the voice model… ${s.progress ?? 0}%`;
        case 'loading':
            return `Loading the voice model… ${s.progress ?? 0}%`;
        case 'ready':
            return `Ready${s.device === 'webgpu' ? ' (GPU)' : ''}`;
        case 'error':
            return `Couldn't start: ${s.error ?? 'unknown error'}`;
        case 'unavailable':
            return s.error ?? 'Not available here';
        default:
            return s.cached ? 'Downloaded; loads on first use' : `One-time download${s.downloadBytes ? ` of ${formatBytes(s.downloadBytes)}` : ''}, then it works offline`;
    }
}

export function VoiceSettingsPanel({ voice, speech, onClose }: { voice: VoiceClient; speech?: SpeechEngine; onClose(): void }) {
    const state = useVoiceState(voice);
    const [previewing, setPreviewing] = useState(false);
    useEffect(() => () => (speech ? speech.stop() : voice.stop()), [voice, speech]);
    // The sample is made (and kept) as soon as this voice can be kept, so Preview plays at once.
    const cacheKey = voice.cacheKey?.() ?? '';
    useEffect(() => {
        if (cacheKey) speech?.prefetch('preview', [SAMPLE], { openers: 8, priority: 'soon', pin: true });
    }, [speech, cacheKey]);
    const k = state.kokoro;
    const busy = k.status === 'downloading' || k.status === 'loading';
    const preview = () => {
        if (previewing) {
            if (speech) speech.stop();
            else voice.stop();
            return setPreviewing(false);
        }
        setPreviewing(true);
        if (speech) speech.say(SAMPLE, { id: 'preview', onEnd: () => setPreviewing(false), onError: () => setPreviewing(false) });
        else voice.speak(SAMPLE, { onEnd: () => setPreviewing(false), onError: () => setPreviewing(false) });
    };

    return (
        <div className="ca-settings ca-voice-settings" role="dialog" aria-label="Voice settings">
            <div className="ca-settings-head">
                <span className="ca-settings-icon">
                    <Icon name="volume" size={18} />
                </span>
                <div>
                    <h2>Voice</h2>
                    <p className="ca-muted ca-voice-sub">Narrates tours. Speech is made on this device: nothing is sent anywhere.</p>
                </div>
                <span className="ca-toolbar-gap" />
                <button type="button" className="ca-button ca-button-ghost" onClick={onClose} aria-label="Close">
                    <Icon name="close" /> Close
                </button>
            </div>

            <div className="ca-tiles" role="radiogroup" aria-label="Voice engine">
                {state.engines.map((e) => (
                    <label key={e.id} className={`ca-tile${state.engine === e.id ? ' ca-on' : ''}${e.available ? '' : ' ca-tile-off'}`}>
                        <input type="radio" name="ca-voice-engine" checked={state.engine === e.id} disabled={!e.available} onChange={() => voice.update({ engine: e.id, voice: undefined })} />
                        <span className="ca-tile-icon">
                            <Icon name={ENGINE_ICON[e.id]} size={16} />
                        </span>
                        <span className="ca-tile-text">
                            <strong>{e.label}</strong>
                            <span className="ca-muted">{e.available ? e.description : e.reason ?? e.description}</span>
                            {e.id === 'kokoro' && e.available ? (
                                <span className={`ca-voice-status ca-voice-${k.status}`} role="status">
                                    {busy ? <Icon name="refresh" size={12} className="ca-spin" /> : k.status === 'ready' ? <Icon name="check" size={12} /> : null}
                                    {kokoroLabel(k)}
                                </span>
                            ) : null}
                            {e.id === 'kokoro' && busy ? (
                                <span className="ca-meter" aria-hidden="true">
                                    <span style={{ width: `${k.progress ?? 0}%` }} />
                                </span>
                            ) : null}
                        </span>
                        <span className="ca-tile-check" aria-hidden="true">
                            <Icon name="check" size={12} />
                        </span>
                    </label>
                ))}
            </div>

            {state.engine === 'kokoro' && voice.prepareKokoro && (k.status === 'idle' || k.status === 'error') ? (
                <div className="ca-banner">
                    <Icon name="download" size={16} />
                    <span className="ca-toolbar-gap">
                        {k.status === 'error' ? 'The voice model didn’t load. Try again, or use the system voice for now.' : 'Get the natural voice ready now, so the first tour step speaks straight away.'}
                    </span>
                    <button type="button" className="ca-button ca-button-primary" onClick={() => void voice.prepareKokoro!().catch(() => undefined)}>
                        {k.status === 'error' ? 'Retry' : k.cached ? 'Load voice' : 'Download voice'}
                    </button>
                </div>
            ) : null}

            <div className="ca-voice-grid">
                <label className="ca-field">
                    <span>Voice</span>
                    <select value={state.voice ?? ''} onChange={(e) => voice.update({ voice: e.target.value || undefined })}>
                        <option value="">Default</option>
                        {groupVoices(state.voices).map(([group, list]) => (
                            <optgroup key={group} label={group}>
                                {list.map((v) => (
                                    <option key={v.id} value={v.id}>
                                        {v.label}
                                    </option>
                                ))}
                            </optgroup>
                        ))}
                    </select>
                </label>
                <label className="ca-field">
                    <span>
                        Speed <span className="ca-muted">{state.rate.toFixed(2).replace(/0$/, '')}×</span>
                    </span>
                    <input type="range" min={0.5} max={2} step={0.05} value={state.rate} onChange={(e) => voice.update({ rate: Number(e.target.value) })} />
                </label>
            </div>

            <div className="ca-dialog-actions">
                <button type="button" className="ca-button" onClick={preview} disabled={state.engine === 'kokoro' && busy}>
                    <Icon name={previewing ? 'stop' : 'play'} size={13} /> {previewing ? 'Stop' : state.preparing ? 'Preparing…' : 'Preview'}
                </button>
            </div>
        </div>
    );
}

function groupVoices(voices: VoiceState['voices']): Array<[string, VoiceState['voices']]> {
    const groups = new Map<string, VoiceState['voices']>();
    for (const v of voices) {
        const g = v.detail ?? 'Voices';
        groups.set(g, [...(groups.get(g) ?? []), v]);
    }
    return [...groups];
}

/** Bars that move while the narrator speaks (static with reduced motion). */
export function SpeakingBars({ active }: { active: boolean }) {
    return (
        <span className={`ca-bars${active ? ' ca-on' : ''}`} aria-hidden="true">
            <i />
            <i />
            <i />
        </span>
    );
}
