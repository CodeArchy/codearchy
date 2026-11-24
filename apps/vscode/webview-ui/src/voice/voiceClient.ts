/**
 * The shared UI's VoiceClient over this webview's TTS manager: Kokoro (the
 * model the extension host downloads once and serves locally) and the system
 * voice. Tours narrate through it; the Voice dialog (VoiceSelector) stays the
 * place to activate Kokoro and pick voices.
 *
 * Narration is made ahead and kept (the shared Narrator) through v1's Kokoro
 * job queue: the step on screen and the next one go first ('narrator'), the
 * rest of the tour behind them ('message').
 */
import type { VoiceClient, VoiceState } from '@codearchy/protocol';
import { KOKORO_VOICES } from './kokoroVoices';
import { getVoiceConfig, setVoiceConfig, subscribeVoiceConfig } from './voiceConfig';
import {
    getKokoroStatus,
    getWebSpeechVoices,
    getActiveKokoroVoiceId,
    isKokoroActive,
    isKokoroEverActivated,
    isSpeaking,
    playCachedAudio,
    synthesizeKokoroAudio,
    isSynthesizing,
    speak,
    startKokoroEngine,
    stopSpeaking,
    subscribeKokoroStatus,
    subscribeSpeaking,
    subscribeSynthesizing,
    subscribeWebSpeechVoices,
} from './ttsManager';

/** The CPU model and the curated voices (VoiceModelStore's base pack). */
const KOKORO_DOWNLOAD_BYTES = 107_000_000;

function snapshot(): VoiceState {
    const cfg = getVoiceConfig();
    const k = getKokoroStatus();
    const engine = cfg.engine === 'kokoro' ? 'kokoro' : 'system';
    const hasSpeech = typeof window !== 'undefined' && 'speechSynthesis' in window;
    return {
        engine,
        ...(cfg.voiceId ? { voice: cfg.voiceId } : {}),
        rate: cfg.rate ?? 1,
        engines: [
            { id: 'kokoro', label: 'Natural voice (Kokoro)', description: 'A neural voice that runs on this machine. Downloaded once by the extension.', available: true },
            { id: 'system', label: 'System voice', description: 'Your operating system’s voices. Instant, no download.', available: hasSpeech, ...(hasSpeech ? {} : { reason: 'Speech synthesis isn’t available here.' }) },
        ],
        voices:
            engine === 'kokoro'
                ? KOKORO_VOICES.map((v) => ({ id: v.id, label: v.label, ...(v.description ? { detail: v.description.split(' · ')[0] } : {}), ...(v.lang ? { lang: v.lang } : {}) }))
                : getWebSpeechVoices().map((v) => ({ id: v.voiceURI, label: v.name, detail: v.lang, lang: v.lang })),
        kokoro: {
            status: k.status === 'loading' ? 'loading' : k.status,
            ...(k.status === 'loading' ? { progress: k.progress } : {}),
            ...(k.error ? { error: k.error } : {}),
            downloadBytes: KOKORO_DOWNLOAD_BYTES,
            cached: isKokoroEverActivated(),
        },
        speaking: isSpeaking(),
        preparing: isSynthesizing(),
    };
}

export function vscodeVoiceClient(openSettings: () => void): VoiceClient {
    let state = snapshot();
    const listeners = new Set<(s: VoiceState) => void>();
    const emit = () => {
        state = snapshot();
        for (const l of listeners) l(state);
    };
    // The managers' own subscriptions feed one state object (useSyncExternalStore needs a stable one).
    subscribeVoiceConfig(emit);
    subscribeKokoroStatus(emit);
    subscribeSpeaking(emit);
    subscribeSynthesizing(emit);
    subscribeWebSpeechVoices(emit);
    /** Kokoro loads in the background once it has been activated here before. */
    const warm = () => {
        if (getVoiceConfig().engine === 'kokoro' && isKokoroEverActivated() && getKokoroStatus().status === 'idle') void startKokoroEngine().catch(() => undefined);
    };
    return {
        state: () => state,
        subscribe: (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        update: (patch) => {
            setVoiceConfig({
                ...(patch.engine ? { engine: patch.engine === 'kokoro' ? 'kokoro' : 'web-speech' } : {}),
                ...('voice' in patch ? { voiceId: patch.voice ?? null } : {}),
                ...(patch.rate !== undefined ? { rate: patch.rate } : {}),
            });
            warm();
        },
        prepareKokoro: () => startKokoroEngine(),
        // Until Kokoro is ready, the manager speaks with the system voice.
        speak: (text, options) => {
            warm();
            void speak(text, { onEnd: options?.onEnd, onError: (e) => options?.onError?.(e instanceof Error ? e : new Error(String(e))) });
        },
        stop: () => stopSpeaking(),
        openSettings,
        cacheKey: () => (isKokoroActive() ? `kokoro-vscode:${getActiveKokoroVoiceId()}` : undefined),
        synthesize: async (text, priority) => {
            const audio = await synthesizeKokoroAudio(text, getActiveKokoroVoiceId(), undefined, priority === 'later' ? 'message' : 'narrator');
            return audio ? { pcm: audio.pcm, sampleRate: audio.sampleRate } : undefined;
        },
        play: (audio, options) => {
            void playCachedAudio(audio.pcm, audio.sampleRate, { onEnd: options?.onEnd, onError: (e) => options?.onError?.(e instanceof Error ? e : new Error(String(e))) });
        },
    };
}
