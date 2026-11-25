import { describe, expect, test } from 'vitest';
import type { AiClient, ChatEvent } from '@codearchy/protocol';
import { ACKNOWLEDGEMENTS, ChatSession } from '../src/chatSession.js';
import { memoryKeyValue } from '../src/kv.js';
import { SpeechEngine } from '../src/speech/engine.js';
import { capturesFromAnswer } from '../src/tourModel.js';
import { FakeSink, fakeVoice, memoryStore, settle } from './speechFakes.js';

const ANSWER = 'Requests enter through [routes.ts](node:mod:routes), which hands each one to a handler.\n\nOrders then go to [the order service](node:mod:orders), which writes them to the database.';

/** A scripted model: streams the answer in small pieces, then `done`. Records what it was asked. */
function scriptedAi() {
    const asked: Array<{ conversation: string; question: string; earlier?: unknown }> = [];
    const ai = {
        ask: async (conversation: string, question: string, options: { earlier?: unknown }, onEvent: (e: ChatEvent) => void) => {
            asked.push({ conversation, question, ...(options.earlier ? { earlier: options.earlier } : {}) });
            for (let i = 0; i < ANSWER.length; i += 7) {
                onEvent({ type: 'text', delta: ANSWER.slice(i, i + 7) });
                await new Promise((r) => setTimeout(r, 0));
            }
            onEvent({ type: 'done', answer: ANSWER, citations: [{ type: 'node', key: 'mod:routes', label: 'routes.ts' }], invalidCitations: 0, actions: [], mode: 'tools', rounds: 1, usage: { inputTokens: 10, outputTokens: 20 }, provider: 'demo', model: 'scripted' });
        },
        cancel: () => undefined,
        reset: () => undefined,
    } as unknown as AiClient;
    return { ai, asked };
}

describe('narrated answers', () => {
    test('narration stopped part way: silent at once, but the whole answer is still made and kept, so its replay is instant', async () => {
        const { voice, asked: made } = fakeVoice();
        const sink = new FakeSink();
        const speech = new SpeechEngine(voice, { store: memoryStore(), sink });
        const { ai } = scriptedAi();
        const session = new ChatSession({ ai, workspace: 'shop', speech, storage: memoryKeyValue() });
        await settle();
        session.ask('Where does a request enter?');
        await new Promise((r) => setTimeout(r, 0));
        session.stop(); // the narration is closed while the answer is still being written
        expect(session.snapshot().playing).toBeUndefined();
        expect(sink.played.every((p) => p.silenced)).toBe(true);
        for (let i = 0; i < 10; i++) await settle(); // the answer finishes; its walkthrough is made in the background
        expect(session.snapshot().turns[0]!.done).toBe(true);
        const before = made.length;
        session.play(session.snapshot().turns[0]!.id);
        await settle();
        expect(made.length).toBe(before); // nothing left to make
        expect(made.map((m) => m.text)).toContain('Orders then go to the order service, which writes them to the database.');
    });

    test('an acknowledgement at once, the answer spoken as it is written, the canvas following each part it cites', async () => {
        const { voice, asked: made } = fakeVoice();
        const sink = new FakeSink();
        const speech = new SpeechEngine(voice, { store: memoryStore(), sink });
        const { ai } = scriptedAi();
        const session = new ChatSession({ ai, workspace: 'shop', speech, storage: memoryKeyValue() });
        const focused: string[][] = [];
        session.onFocus = (keys) => focused.push(keys);
        await settle();
        session.ask('Where does a request enter?');
        await settle();
        expect(ACKNOWLEDGEMENTS.some((a) => a.startsWith(made[0]!.text))).toBe(true); // the first thing made is the acknowledgement
        // The answer's first phrase was asked for while the answer was still arriving (before `done`).
        expect(made.map((m) => m.text)).toContain('Requests enter through routes.ts, which hands each one to a handler.');
        expect(session.snapshot().playing?.turn).toBe(session.snapshot().turns[0]!.id);
        // Play it out: the canvas follows the voice, in order.
        for (let i = 0; i < 20; i++) {
            sink.advance(1);
            await settle();
        }
        expect(focused).toEqual([['mod:routes'], ['mod:orders']]);
        expect(session.snapshot().playing).toBeUndefined();
        // Replay: instant (every phrase was kept), and the canvas follows again.
        const before = made.length;
        session.play(session.snapshot().turns[0]!.id);
        await settle();
        sink.advance(30);
        await settle();
        expect(made.length).toBe(before);
        expect(focused.slice(2)).toEqual([['mod:routes'], ['mod:orders']]);
    });

    test('the history is kept per workspace; after a reload a follow-up carries the earlier turns, once', async () => {
        const storage = memoryKeyValue();
        const first = scriptedAi();
        const a = new ChatSession({ ai: first.ai, workspace: 'shop', storage });
        await settle();
        a.ask('Where does a request enter?');
        await settle();
        await new Promise((r) => setTimeout(r, 350)); // the debounced save
        const second = scriptedAi();
        const b = new ChatSession({ ai: second.ai, workspace: 'shop', storage });
        await settle();
        expect(b.snapshot().turns.map((t) => t.question)).toEqual(['Where does a request enter?']);
        b.ask('And then?');
        await settle();
        b.ask('What writes to the database?');
        await settle();
        expect(second.asked[0]!.earlier).toEqual([{ question: 'Where does a request enter?', answer: ANSWER }]);
        expect(second.asked[1]!.earlier).toBeUndefined();
        expect(second.asked[0]!.conversation).toBe(first.asked[0]!.conversation); // the same conversation continues
        // Another workspace has its own history.
        const other = new ChatSession({ ai: second.ai, workspace: 'other', storage });
        await settle();
        expect(other.snapshot().turns).toEqual([]);
    });

    test('an answer becomes tour steps, one per part it explains', () => {
        const steps = capturesFromAnswer(`In short:\n\n${ANSWER}\n\n- A note without a link.`);
        expect(steps.map((s) => [s.title, s.target.node])).toEqual([
            ['routes.ts', 'mod:routes'],
            ['the order service', 'mod:orders'],
        ]);
        expect(steps[0]!.body.startsWith('In short:')).toBe(true); // text before the first link joins the first step
        expect(steps[1]!.body).toContain('A note without a link.'); // and text after joins the last
    });
});
