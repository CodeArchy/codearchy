import { describe, expect, it } from 'vitest';
import { collect, gemini } from '../src/index.js';
import { mockFetch, split, sseOf } from './helpers.js';

const KEY = 'AIza-test-key-123456';

describe('gemini', () => {
    it('streams text with the key header, system instruction and JSON-schema tools', async () => {
        const stream = sseOf([
            { candidates: [{ content: { role: 'model', parts: [{ text: 'Hel' }] } }] },
            { candidates: [{ content: { role: 'model', parts: [{ text: 'lo' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 } },
        ]);
        const { fetch, requests } = mockFetch(() => ({ chunks: split(stream, 4) }));
        const events = await collect(
            gemini({ apiKey: KEY, fetch }).chat({
                model: 'gemini-x',
                system: 'S',
                messages: [{ role: 'user', content: 'hi' }],
                tools: [{ name: 'search', description: 'd', parameters: { type: 'object', properties: { q: { type: 'string' } } } }],
                maxOutputTokens: 50,
            }),
        );
        expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end', turn: { content: 'Hello', toolCalls: [] } });
        expect(events.at(-2)).toEqual({ type: 'usage', usage: { inputTokens: 7, outputTokens: 2, cachedInputTokens: undefined } });
        const req = requests[0]!;
        expect(req.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-x:streamGenerateContent?alt=sse');
        expect(req.headers['x-goog-api-key']).toBe(KEY);
        expect(req.body).toEqual({
            contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
            systemInstruction: { parts: [{ text: 'S' }] },
            tools: [
                {
                    functionDeclarations: [
                        { name: 'search', description: 'd', parametersJsonSchema: { type: 'object', properties: { q: { type: 'string' } } } },
                    ],
                },
            ],
            toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
            generationConfig: { maxOutputTokens: 50 },
        });
    });

    it('replays its own parts (thought signatures intact) and answers with function responses', async () => {
        const call = { functionCall: { name: 'search', args: { q: 'auth' } }, thoughtSignature: 'sig-1' };
        const stream = sseOf([
            { candidates: [{ content: { role: 'model', parts: [{ text: 'thinking…', thought: true }, call] }, finishReason: 'STOP' }] },
        ]);
        const { fetch, requests } = mockFetch(() => ({ chunks: [stream] }));
        const adapter = gemini({ apiKey: KEY, fetch });
        const events = await collect(adapter.chat({ model: 'g', messages: [{ role: 'user', content: 'q' }] }));
        const done = events.at(-1) as { stopReason: string; turn: { content: string; toolCalls: Array<{ id: string }>; replay: unknown } };
        expect(done.stopReason).toBe('tool_use');
        expect(done.turn.content).toBe(''); // thought text isn't answer text
        expect(done.turn.toolCalls).toEqual([{ id: 'call_1', name: 'search', args: { q: 'auth' } }]);

        await collect(
            adapter.chat({
                model: 'g',
                messages: [
                    { role: 'user', content: 'q' },
                    { role: 'assistant', content: '', toolCalls: done.turn.toolCalls as never, replay: done.turn.replay as never },
                    { role: 'tool', toolCallId: 'call_1', name: 'search', content: 'src/auth.ts' },
                ],
            }),
        );
        expect((requests[1]!.body as { contents: unknown[] }).contents).toEqual([
            { role: 'user', parts: [{ text: 'q' }] },
            { role: 'model', parts: [{ text: 'thinking…', thought: true }, call] },
            // our made-up id isn't sent back
            { role: 'user', parts: [{ functionResponse: { name: 'search', response: { content: 'src/auth.ts' } } }] },
        ]);
    });

    it('echoes ids Gemini issued itself', async () => {
        const { fetch, requests } = mockFetch(() => ({ chunks: [sseOf([{ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }])] }));
        await collect(
            gemini({ apiKey: KEY, fetch }).chat({
                model: 'g',
                messages: [
                    {
                        role: 'assistant',
                        content: '',
                        replay: { provider: 'gemini', model: 'g', data: [{ functionCall: { id: 'fc-9', name: 'search', args: {} } }] },
                    },
                    { role: 'tool', toolCallId: 'fc-9', name: 'search', content: 'r' },
                ],
            }),
        );
        expect((requests[0]!.body as { contents: Array<{ parts: unknown[] }> }).contents[1]!.parts[0]).toEqual({
            functionResponse: { id: 'fc-9', name: 'search', response: { content: 'r' } },
        });
    });

    it('reports a safety block as a refusal and a bad key as auth', async () => {
        const blocked = mockFetch(() => ({ chunks: [sseOf([{ candidates: [{ finishReason: 'SAFETY' }] }])] }));
        const events = await collect(gemini({ apiKey: KEY, fetch: blocked.fetch }).chat({ model: 'g', messages: [] }));
        expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'refusal' });

        const badKey = mockFetch(() => ({
            status: 400,
            json: { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } },
        }));
        expect(await gemini({ apiKey: KEY, fetch: badKey.fetch }).detect()).toEqual({
            state: 'unauthorized',
            detail: 'Gemini rejected the key',
        });
    });

    it('lists chat and embedding models across pages', async () => {
        const { fetch } = mockFetch((url) =>
            url.includes('pageToken=p2')
                ? { json: { models: [{ name: 'models/text-embedding-x', supportedGenerationMethods: ['embedContent'] }] } }
                : {
                      json: {
                          models: [
                              {
                                  name: 'models/gemini-x',
                                  displayName: 'Gemini X',
                                  inputTokenLimit: 1048576,
                                  outputTokenLimit: 65536,
                                  supportedGenerationMethods: ['generateContent', 'countTokens'],
                              },
                              { name: 'models/imagen', supportedGenerationMethods: ['predict'] },
                          ],
                          nextPageToken: 'p2',
                      },
                  },
        );
        const models = await gemini({ apiKey: KEY, fetch }).listModels();
        expect(models.map((m) => [m.id, m.contextWindow, m.supports.embeddings])).toEqual([
            ['gemini-x', 1048576, false],
            ['text-embedding-x', undefined, true],
        ]);
    });
});
