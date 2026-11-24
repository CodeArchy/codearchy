/**
 * Voice: how the UI narrates (tour steps, answers) through the host's speech
 * engines. Each host implements a VoiceClient: the VS Code webview over its
 * Kokoro worker, the web app over Kokoro in a Web Worker (model served by the
 * app itself), both with the system voice (Web Speech) as the instant fallback.
 *
 * Speech never leaves the machine: Kokoro runs on-device, the system voice is
 * the operating system's own.
 */

/** `system`: the browser's / OS's own voices (instant). `kokoro`: Kokoro-82M, a neural voice that runs on this device. */
export type VoiceEngineId = 'system' | 'kokoro';

export interface VoiceOption {
    id: string;
    label: string;
    /** `American Female`, `British Male`, or the system voice's language. */
    detail?: string;
    lang?: string;
}

export interface VoiceEngineInfo {
    id: VoiceEngineId;
    label: string;
    description: string;
    available: boolean;
    /** Why it isn't available here (no speech synthesis, model not served…). */
    reason?: string;
}

/** Kokoro's lifecycle: nothing downloaded → downloading → loading → ready. */
export interface KokoroState {
    status: 'idle' | 'downloading' | 'loading' | 'ready' | 'error' | 'unavailable';
    /** 0–100 while downloading or loading. */
    progress?: number;
    /** One-time download size in bytes (shown before the user opts in). */
    downloadBytes?: number;
    /** The model is already on this device (no download on first use). */
    cached?: boolean;
    device?: 'webgpu' | 'wasm';
    error?: string;
}

export interface VoiceState {
    engine: VoiceEngineId;
    /** Voice id within the engine; undefined = the engine's default. */
    voice?: string;
    /** 0.5–2. */
    rate: number;
    engines: VoiceEngineInfo[];
    /** Voices of the active engine. */
    voices: VoiceOption[];
    kokoro: KokoroState;
    /** Audio is playing. */
    speaking: boolean;
    /** Speech was asked for and is being synthesised (no sound yet). */
    preparing: boolean;
}

export interface SpeakOptions {
    onEnd?(): void;
    onError?(error: Error): void;
    /** With `capturesSpeech`: the whole audio once it's made, so the caller can keep it. */
    onAudio?(audio: VoiceAudio): void;
}

/** Mono PCM, as made by the voice (kept by the narration cache). */
export interface VoiceAudio {
    pcm: Float32Array;
    sampleRate: number;
}

/** How soon audio is needed: the step on screen, the next one, the rest. */
export type SynthesisPriority = 'now' | 'soon' | 'later';

export interface VoiceClient {
    /** The current state (synchronous: the UI renders from it). */
    state(): VoiceState;
    subscribe(listener: (state: VoiceState) => void): () => void;
    update(patch: Partial<Pick<VoiceState, 'engine' | 'voice' | 'rate'>>): void;
    /** Downloads (once) and loads Kokoro; resolves when it's ready to speak. */
    prepareKokoro?(): Promise<void>;
    /** Speaks `text`, replacing anything already playing. `onEnd` also fires when it's stopped. */
    speak(text: string, options?: SpeakOptions): void;
    stop(): void;
    /** The host's own voice settings, instead of the shared panel. */
    openSettings?(): void;

    // ── cacheable speech (narration made ahead and kept) ────────────────────
    /**
     * Who is speaking right now (engine, model, voice, speed) when that voice's
     * audio can be kept: kept audio is replayed only under the same key, so a
     * new voice or speed records again. Undefined: nothing to keep (the system
     * voice), or the voice isn't ready.
     */
    cacheKey?(): string | undefined;
    /** Makes the audio for `text` without playing it; undefined when the cacheable voice isn't ready. */
    synthesize?(text: string, priority: SynthesisPriority): Promise<VoiceAudio | undefined>;
    /** Plays audio from `synthesize` (or the cache), replacing anything playing. */
    play?(audio: VoiceAudio, options?: SpeakOptions): void;
    /** Drops queued synthesis that hasn't started (a closed tour's remaining steps). */
    cancelPending?(): void;
    /** `speak` reports the whole audio through `onAudio` (streamed speech can be kept). */
    capturesSpeech?: boolean;
}

