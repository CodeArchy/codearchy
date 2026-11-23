/**
 * The AI host for VS Code: @codearchy/ai's AiHost with VS Code storage.
 *
 *   API keys      SecretStorage (the OS keychain), never settings or logs
 *   settings      per workspace (the privacy tier is a decision about this code)
 *   token usage   global (budgets are per provider account)
 *   AI cards      a JSON file in the extension's workspace storage, so paid
 *                 summaries survive a reload
 *
 * Providers: Ollama and LM Studio on this machine, GitHub Copilot through
 * VS Code's Language Model API, and API keys for Anthropic, OpenAI, Gemini,
 * OpenRouter, Groq and Mistral.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AiHost, type Card, type CardStore, type ProviderFactory } from '@codearchy/ai';
import type { AiHostEvent, AiSettings } from '@codearchy/protocol';
import { anthropic, gemini, groq, lmStudio, mistral, ollama, openai, openrouter, vscodeLm, type SecretStore, type UsageStore, type VscodeLmApi } from '@codearchy/providers';
import type { HierarchyIndex } from '@codearchy/core';

export interface AiHostSources {
    index(): HierarchyIndex | undefined;
    readFile(path: string): Promise<string | undefined>;
}

const SETTINGS_KEY = 'codearchy.ai.settings';
const USAGE_KEY = 'codearchy.ai.usage';

export function createVscodeAiHost(context: vscode.ExtensionContext, sources: AiHostSources, emit: (event: AiHostEvent) => void): AiHost {
    const secrets: SecretStore = {
        get: async (name) => (await context.secrets.get(name)) ?? undefined,
        set: async (name, value) => context.secrets.store(name, value),
        delete: async (name) => context.secrets.delete(name),
    };
    const usage: UsageStore = {
        get: async (key) => context.globalState.get<Record<string, number>>(USAGE_KEY, {})[key],
        set: async (key, value) => {
            const all = { ...context.globalState.get<Record<string, number>>(USAGE_KEY, {}), [key]: value };
            // Keep this month and last month only.
            const months = new Set([monthOf(Date.now()), monthOf(Date.now() - 32 * 86_400_000)]);
            for (const k of Object.keys(all)) if (!months.has(k.split(':').pop()!.slice(0, 7))) delete all[k];
            await context.globalState.update(USAGE_KEY, all);
        },
    };
    const ollamaUrl = () => vscode.workspace.getConfiguration('codearchy').get<string>('ollama.url', 'http://localhost:11434');
    const providers: ProviderFactory[] = [
        {
            id: 'ollama',
            label: 'Ollama',
            acceptsKey: false,
            setup: {
                title: 'Run models on this machine with Ollama',
                steps: ['Install Ollama from https://ollama.com', 'ollama pull <a model with tool support, e.g. qwen3>', 'Keep Ollama running, then choose "Check providers"'],
            },
            create: () => ollama({ baseUrl: ollamaUrl() }),
        },
        { id: 'lmstudio', label: 'LM Studio', acceptsKey: false, create: () => lmStudio() },
        {
            id: 'vscode-lm',
            label: 'GitHub Copilot (VS Code)',
            acceptsKey: false,
            setup: { title: 'Use the models your Copilot plan includes', steps: ['Sign in to GitHub Copilot in VS Code', 'Choose "Check providers"; VS Code asks once before CodeArchy may use a model'] },
            create: () => vscodeLm(vscode as unknown as VscodeLmApi),
        },
        { id: 'anthropic', label: 'Anthropic', acceptsKey: true, create: (apiKey) => anthropic({ apiKey }) },
        { id: 'openai', label: 'OpenAI', acceptsKey: true, create: (apiKey) => openai({ apiKey }) },
        { id: 'gemini', label: 'Google Gemini', acceptsKey: true, create: (apiKey) => gemini({ apiKey }) },
        { id: 'openrouter', label: 'OpenRouter', acceptsKey: true, create: (apiKey) => openrouter({ apiKey }) },
        { id: 'groq', label: 'Groq', acceptsKey: true, create: (apiKey) => groq({ apiKey }) },
        { id: 'mistral', label: 'Mistral', acceptsKey: true, create: (apiKey) => mistral({ apiKey }) },
    ];
    return new AiHost({
        index: sources.index,
        readFile: sources.readFile,
        providers,
        secrets,
        settings: {
            load: async () => context.workspaceState.get<Partial<AiSettings>>(SETTINGS_KEY),
            save: async (s) => context.workspaceState.update(SETTINGS_KEY, s),
        },
        usage,
        cards: context.storageUri ? new FileCardStore(path.join(context.storageUri.fsPath, 'ai-cards.json')) : undefined,
        emit,
    });
}

function monthOf(t: number): string {
    return new Date(t).toISOString().slice(0, 7);
}

/** Cards in one JSON file, loaded once and written (debounced) after changes. Capped, oldest first out. */
export class FileCardStore implements CardStore {
    private byHash = new Map<string, Card>();
    private byKey = new Map<string, Card>();
    private loaded?: Promise<void>;
    private timer?: NodeJS.Timeout;

    constructor(
        private readonly file: string,
        private readonly limit = 20_000,
    ) {}

    async get(inputHash: string) {
        await this.load();
        return this.byHash.get(inputHash);
    }

    async latest(key: string) {
        await this.load();
        return this.byKey.get(key);
    }

    async put(card: Card) {
        await this.load();
        this.byHash.delete(card.inputHash);
        this.byHash.set(card.inputHash, card);
        this.byKey.set(card.key, card);
        while (this.byHash.size > this.limit) this.byHash.delete(this.byHash.keys().next().value!);
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.save(), 1000);
    }

    private load(): Promise<void> {
        this.loaded ??= fs.promises.readFile(this.file, 'utf8').then(
            (text) => {
                const cards = (JSON.parse(text) as { cards?: Card[] }).cards ?? [];
                for (const c of cards) {
                    this.byHash.set(c.inputHash, c);
                    const prev = this.byKey.get(c.key);
                    if (!prev || prev.createdAt <= c.createdAt) this.byKey.set(c.key, c);
                }
            },
            () => undefined, // no file yet, or unreadable: start empty
        );
        return this.loaded;
    }

    private async save(): Promise<void> {
        await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
        // Only AI cards are worth keeping: deterministic ones are cheap to rebuild.
        const cards = [...this.byHash.values()].filter((c) => c.source === 'ai');
        const tmp = `${this.file}.tmp`;
        await fs.promises.writeFile(tmp, JSON.stringify({ version: 1, cards }));
        await fs.promises.rename(tmp, this.file);
    }
}
