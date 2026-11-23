#!/usr/bin/env node
/**
 * Manual smoke test against real providers (never run in CI). For each provider
 * configured through the environment: detect, list models, then one chat turn
 * with a tool and a second turn answering it.
 *
 *   OLLAMA_MODEL=gemma4:e2b [OLLAMA_HOST=http://localhost:11434]
 *   ANTHROPIC_API_KEY=… [ANTHROPIC_MODEL=…]   OPENAI_API_KEY=… OPENAI_MODEL=…
 *   GEMINI_API_KEY=… GEMINI_MODEL=…            OPENROUTER_API_KEY=… OPENROUTER_MODEL=…
 *
 *   pnpm --filter @codearchy/providers build && node packages/providers/scripts/live.mjs
 */
import { anthropic, gemini, ollama, openai, openrouter, withResilience } from '../dist/index.js';

const env = process.env;
const targets = [];
if (env.OLLAMA_MODEL) targets.push([ollama({ baseUrl: env.OLLAMA_HOST }), env.OLLAMA_MODEL]);
if (env.ANTHROPIC_API_KEY) targets.push([anthropic({ apiKey: env.ANTHROPIC_API_KEY }), env.ANTHROPIC_MODEL ?? 'claude-opus-5-5']);
if (env.OPENAI_API_KEY && env.OPENAI_MODEL) targets.push([openai({ apiKey: env.OPENAI_API_KEY }), env.OPENAI_MODEL]);
if (env.GEMINI_API_KEY && env.GEMINI_MODEL) targets.push([gemini({ apiKey: env.GEMINI_API_KEY }), env.GEMINI_MODEL]);
if (env.OPENROUTER_API_KEY && env.OPENROUTER_MODEL) targets.push([openrouter({ apiKey: env.OPENROUTER_API_KEY }), env.OPENROUTER_MODEL]);
if (!targets.length) {
    console.log('No providers configured; see the header of this file.');
    process.exit(0);
}

const tools = [
    {
        name: 'find_component',
        description: 'Look up a component of the codebase by name and return its files.',
        parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
];

let failures = 0;
for (const [raw, model] of targets) {
    const adapter = withResilience(raw);
    const label = `${adapter.label} · ${model}`;
    try {
        const status = await adapter.detect();
        const models = await adapter.listModels();
        const info = models.find((m) => m.id === model);
        console.log(`\n${label}\n  detect: ${status.state}${status.detail ? ` (${status.detail})` : ''}; ${models.length} models; context ${info?.contextWindow ?? '?'}, tools ${info?.supports.tools ?? '?'}`);

        const messages = [{ role: 'user', content: 'Use the find_component tool to look up the "auth" component, then tell me in one sentence which file it lives in.' }];
        const turn1 = await turn(adapter, { model, messages, tools, maxOutputTokens: 1024 });
        console.log(`  turn 1: stop=${turn1.stopReason}, ${turn1.turn.toolCalls.length} tool call(s) ${JSON.stringify(turn1.turn.toolCalls.map((c) => [c.name, c.args]))}, ${turn1.usage}`);
        if (turn1.turn.toolCalls.length) {
            messages.push({ role: 'assistant', ...turn1.turn });
            for (const c of turn1.turn.toolCalls) {
                messages.push({ role: 'tool', toolCallId: c.id, name: c.name, content: JSON.stringify({ files: ['src/auth/session.ts'] }) });
            }
            const turn2 = await turn(adapter, { model, messages, tools, maxOutputTokens: 1024 });
            console.log(`  turn 2: stop=${turn2.stopReason}, "${turn2.turn.content.trim().slice(0, 160)}", ${turn2.usage}`);
        }
    } catch (err) {
        failures++;
        console.log(`\n${label}\n  ✗ ${err.code ?? ''} ${err.message}`);
    }
}
process.exit(failures ? 1 : 0);

async function turn(adapter, request) {
    let usage = '';
    for await (const e of adapter.chat(request)) {
        if (e.type === 'usage') usage = `${e.usage.inputTokens} in / ${e.usage.outputTokens} out`;
        if (e.type === 'error') throw e.error;
        if (e.type === 'done') return { ...e, usage };
    }
    throw new Error('stream ended without done');
}
