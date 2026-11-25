/**
 * The conversation about the codebase, per workspace: its history (kept
 * across tab switches and reloads), the answer being written, and its
 * narration.
 *
 * Narrated answers walk you through the canvas, like v1's narrator, but live:
 * a short acknowledgement plays at once, the answer is spoken while the model
 * is still writing it, and each part it cites is shown on the canvas the
 * moment the voice reaches it. Every answer stays in the history: play its
 * walkthrough again (instant: its phrases were kept), follow up on it (the
 * model gets the earlier turns, also after a reload), or turn it into a tour.
 */
import type { AiClient, CanvasAction, ChatCitation, ChatEvent } from '@codearchy/protocol';
import type { SpeechEngine, SpeechMark, Utterance } from './speech/engine.js';
import { indexedDbKeyValue, type KeyValue } from './kv.js';

export interface ChatTurn {
    id: string;
    question: string;
    answer: string;
    status: string[];
    citations: ChatCitation[];
    actions: CanvasAction[];
    done: boolean;
    error?: string;
    meta?: string;
    at: number;
}

export interface ChatSnapshot {
    loaded: boolean;
    turns: ChatTurn[];
    /** Answers are narrated (and the canvas follows). */
    narrate: boolean;
    /** The turn whose walkthrough is playing, and what it's saying. */
    playing?: { turn: string; phrase?: string };
}

/** Said at once while the model starts answering (kept, so they play instantly). */
export const ACKNOWLEDGEMENTS = ['Let me take a look.', 'Good question. Let me check the code.', "Let's see how that works.", 'One moment, let me walk you through it.'];
const HISTORY_LIMIT = 50;
/** Earlier turns sent with a question when the model may not remember them (after a reload). */
const EARLIER = 6;

export interface ChatSessionOptions {
    ai: AiClient;
    /** Identifies the workspace (the history is per workspace). */
    workspace: string;
    speech?: SpeechEngine;
    storage?: KeyValue;
}

export class ChatSession {
    private snap: ChatSnapshot = { loaded: false, turns: [], narrate: true };
    private conversation = newConversationId();
    private readonly listeners = new Set<(s: ChatSnapshot) => void>();
    private readonly storage: KeyValue;
    private saveTimer?: ReturnType<typeof setTimeout>;
    private live?: { turn: string; utterance?: Utterance };
    /** The model has this conversation's history (false after a load: the stored turns go with the next question). */
    private primed = false;
    /** Shows nodes on the canvas (set by the map). */
    onFocus?: (keys: string[]) => void;

    constructor(private readonly options: ChatSessionOptions) {
        this.storage = options.storage ?? indexedDbKeyValue();
        void this.load();
    }

    get speech(): SpeechEngine | undefined {
        return this.options.speech;
    }

    snapshot(): ChatSnapshot {
        return this.snap;
    }

    subscribe(listener: (s: ChatSnapshot) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    get busy(): boolean {
        const last = this.snap.turns.at(-1);
        return !!last && !last.done;
    }

    ask(text: string, options: { selection?: string } = {}): void {
        const question = text.trim();
        if (!question || this.busy) return;
        const turn: ChatTurn = { id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, question, answer: '', status: [], citations: [], actions: [], done: false, at: Date.now() };
        const earlier = this.primed
            ? []
            : this.snap.turns
                  .filter((t) => t.done && !t.error && t.answer)
                  .slice(-EARLIER)
                  .map((t) => ({ question: t.question, answer: t.answer }));
        this.primed = true;
        this.set({ turns: [...this.snap.turns, turn].slice(-HISTORY_LIMIT) });
        const narrate = this.snap.narrate && !!this.speech;
        if (narrate) {
            // Something at once, while the model starts: an acknowledgement (kept, so instant).
            this.speech!.say(ACKNOWLEDGEMENTS[hash(question) % ACKNOWLEDGEMENTS.length]!, { id: `ack:${turn.id}` });
            this.live = { turn: turn.id };
            this.set({ playing: { turn: turn.id } });
        }
        const conversation = this.conversation;
        void this.options.ai
            .ask(conversation, question, { ...(options.selection ? { selection: options.selection } : {}), ...(earlier.length ? { earlier } : {}) }, (e: ChatEvent) => this.event(turn.id, e))
            .catch((err: unknown) => this.event(turn.id, { type: 'error', code: 'unavailable', message: err instanceof Error ? err.message : String(err) }));
    }

    /** Stops the answer being written (and its narration). */
    cancel(): void {
        this.options.ai.cancel(this.conversation);
        this.stop();
    }

    newChat(): void {
        this.options.ai.reset(this.conversation);
        this.conversation = newConversationId();
        this.primed = true;
        this.stop();
        this.set({ turns: [] });
    }

    setNarrate(on: boolean): void {
        if (!on) this.stop();
        this.set({ narrate: on });
    }

    /** Plays an answer's walkthrough: the voice and the canvas together. */
    play(turnId: string): void {
        const t = this.snap.turns.find((x) => x.id === turnId);
        if (!t?.answer || !this.speech) return;
        this.live = undefined;
        this.set({ playing: { turn: turnId } });
        this.speech.say(t.answer, { id: turnId, onMark: (m) => this.marked(turnId, m), onEnd: () => this.finished(turnId) });
    }

    stop(): void {
        this.live?.utterance?.cancel();
        this.live = undefined;
        if (this.snap.playing) this.speech?.stop();
        this.set({ playing: undefined });
    }

    dispose(): void {
        this.stop();
        clearTimeout(this.saveTimer);
        this.listeners.clear();
    }

    private event(turnId: string, e: ChatEvent): void {
        const turn = this.snap.turns.find((t) => t.id === turnId);
        if (!turn) return;
        const live = this.live?.turn === turnId ? this.live : undefined;
        const update = (patch: Partial<ChatTurn>) => this.set({ turns: this.snap.turns.map((t) => (t.id === turnId ? { ...t, ...patch } : t)) });
        switch (e.type) {
            case 'text':
                update({ answer: turn.answer + e.delta });
                if (live) {
                    // The answer is spoken as it's written, after the acknowledgement.
                    live.utterance ??= this.speech!.stream({ id: turnId, queue: true, onMark: (m) => this.marked(turnId, m), onEnd: () => this.finished(turnId) });
                    live.utterance.push(e.delta);
                }
                break;
            case 'restart':
                update({ answer: '' });
                live?.utterance?.cancel();
                if (live) live.utterance = undefined;
                break;
            case 'status':
                update({ status: [...turn.status, e.text] });
                break;
            case 'action':
                update({ actions: [...turn.actions, e.action] });
                break;
            case 'error':
                update({ done: true, error: e.message });
                if (live) this.stop();
                break;
            case 'done':
                update({
                    done: true,
                    answer: e.answer,
                    citations: e.citations,
                    actions: e.actions,
                    meta: `${e.provider} · ${e.model}${e.mode === 'rag' ? ' · from search results' : ''} · ${(e.usage.inputTokens + e.usage.outputTokens).toLocaleString()} tokens`,
                });
                if (live) {
                    // An answer that came all at once (no streamed text) is spoken now.
                    if (!live.utterance && e.answer) {
                        live.utterance = this.speech!.stream({ id: turnId, queue: true, onMark: (m) => this.marked(turnId, m), onEnd: () => this.finished(turnId) });
                        live.utterance.push(e.answer);
                    }
                    if (live.utterance) live.utterance.end();
                    else this.finished(turnId);
                }
                break;
        }
    }

    private marked(turnId: string, m: SpeechMark): void {
        if (this.snap.playing?.turn !== turnId) return;
        this.set({ playing: { turn: turnId, phrase: m.text } });
        if (m.keys.length) this.onFocus?.(m.keys);
    }

    private finished(turnId: string): void {
        if (this.live?.turn === turnId) this.live = undefined;
        if (this.snap.playing?.turn === turnId) this.set({ playing: undefined });
    }

    private set(patch: Partial<ChatSnapshot>): void {
        this.snap = { ...this.snap, ...patch };
        if ('playing' in patch && patch.playing === undefined) delete this.snap.playing;
        for (const l of this.listeners) l(this.snap);
        if ('turns' in patch || 'narrate' in patch) this.save();
    }

    private key(): string {
        return `chat:${this.options.workspace}`;
    }

    private async load(): Promise<void> {
        const saved = await this.storage.get<{ conversation?: string; turns?: ChatTurn[]; narrate?: boolean }>(this.key()).catch(() => undefined);
        if (saved?.conversation) this.conversation = saved.conversation;
        // An answer cut off by a reload is kept as it was, marked as stopped.
        const turns = (saved?.turns ?? []).map((t) => (t.done ? t : { ...t, done: true, error: t.error ?? 'Stopped (the page was closed while it was being written)' }));
        this.set({ loaded: true, turns: [...turns, ...this.snap.turns].slice(-HISTORY_LIMIT), narrate: saved?.narrate ?? this.snap.narrate });
    }

    private save(): void {
        if (!this.snap.loaded) return;
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => void this.storage.set(this.key(), { conversation: this.conversation, turns: this.snap.turns, narrate: this.snap.narrate }).catch(() => undefined), 300);
    }
}

function hash(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h;
}

function newConversationId(): string {
    return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
