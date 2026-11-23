import { describe, expect, it } from 'vitest';
import { Budget, checkContent, estimateRun, estimateTokens, hostOf, isLoopback, MemoryUsageStore } from '../src/index.js';
import { entropy, redactRequest, scanSecrets } from '../src/scanner.js';

describe('loopback detection', () => {
    it('parses hosts by hand, including IPv6, ports and userinfo', () => {
        expect(hostOf('http://LOCALHOST:11434/api')).toBe('localhost');
        expect(hostOf('http://[::1]:8080')).toBe('::1');
        expect(hostOf('https://user:pw@api.example.com/v1')).toBe('api.example.com');
        expect(hostOf('not a url')).toBeUndefined();
    });

    it('counts only this machine as local', () => {
        for (const url of ['http://localhost:11434', 'http://127.0.0.1:1234/v1', 'http://[::1]:11434', 'http://ollama.localhost']) {
            expect(isLoopback(url), url).toBe(true);
        }
        for (const url of ['http://192.168.1.20:11434', 'https://api.openai.com/v1', 'http://localhost.evil.com', 'http://127.0.0.1.nip.io', undefined]) {
            expect(isLoopback(url), String(url)).toBe(false);
        }
    });

    it('applies the tiers to providers and content', () => {
        const local = { kind: 'local' as const, baseUrl: 'http://localhost:11434', label: 'Ollama' };
        const lan = { kind: 'local' as const, baseUrl: 'http://10.0.0.5:11434', label: 'LAN Ollama' };
        const cloud = { kind: 'api-key' as const, baseUrl: 'https://api.anthropic.com', label: 'Anthropic' };
        expect(checkContent({ tier: 'local-only' }, local, ['excerpts']).ok).toBe(true);
        expect(checkContent({ tier: 'local-only' }, lan, ['structure']).ok).toBe(false);
        expect(checkContent({ tier: 'local-only' }, cloud, ['structure']).ok).toBe(false);
        expect(checkContent({ tier: 'structure' }, cloud, ['structure']).ok).toBe(true);
        expect(checkContent({ tier: 'structure' }, cloud, ['structure', 'excerpts']).ok).toBe(false);
        expect(checkContent({ tier: 'excerpts' }, cloud, ['excerpts']).ok).toBe(true);
    });
});

describe('secret scanner', () => {
    const cases: Array<[string, string]> = [
        ['aws-access-key', 'key = AKIAIOSFODNN7EXAMPLE'],
        ['github-token', `token ghp_${'a1B2'.repeat(9)}`],
        ['github-token', `github_pat_${'A1b2C3d4E5'.repeat(3)}`],
        ['slack-token', 'xoxb-123456789012-abcdefABCDEF'],
        ['stripe-key', 'sk_live_51HxYzAbCdEfGhIjKlMn'],
        ['google-api-key', `AIza${'Sy0123456789abcdefghijklmnopqrstuvw'}`],
        ['anthropic-key', 'sk-ant-api03-Zx9yW8vU7tS6rQ5pO4nM3lK2'],
        ['openai-key', 'sk-proj-4fJ9kL2mN8pQ1rS7tU3vW6xY0zA5bC'],
        ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
        ['private-key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----'],
        ['connection-string', 'postgres://admin:s3cr3tPass@db.internal:5432/app'],
        ['assignment', 'DATABASE_PASSWORD="Xk9#mQ2vLp7wRz4t"'],
        ['assignment', '"client_secret": "8f3kD92jLmQp0xYzW7vB"'],
    ];
    for (const [type, text] of cases) {
        it(`redacts ${type}`, () => {
            const r = scanSecrets(`before ${text} after`);
            expect(r.findings.map((f) => f.type)).toContain(type);
            expect(r.text).toContain(`[REDACTED:${type}]`);
            expect(r.text.startsWith('before ')).toBe(true);
        });
    }

    it('leaves ordinary code alone', () => {
        const code = [
            'const token = getToken(request);',
            'apiKey: process.env.OPENAI_API_KEY,',
            'password = "changeme"',
            'export const SECRET_NAME_PATTERN = "secret";',
            'import sk-learn-style-module-name-for-docs',
            'auth_mode = oauth2_device_flow',
        ].join('\n');
        expect(scanSecrets(code)).toEqual({ text: code, findings: [] });
    });

    it('scans pathological input in linear time', () => {
        const nasty = ['a='.repeat(50_000), 'sk-'.repeat(50_000), `-----BEGIN PRIVATE KEY-----${'x'.repeat(100_000)}`, '_'.repeat(200_000)];
        for (const text of nasty) {
            const t = Date.now();
            scanSecrets(text);
            expect(Date.now() - t).toBeLessThan(1500);
        }
    });

    it('redacts the system prompt, user text and tool results, but not model output', () => {
        const key = 'ghp_' + 'Q'.repeat(18) + '7'.repeat(18);
        const { request, findings } = redactRequest({
            model: 'm',
            system: `ctx ${key}`,
            messages: [
                { role: 'user', content: key },
                { role: 'assistant', content: 'ok' },
                { role: 'tool', toolCallId: 'c', name: 'read_code', content: `x = "${key}"` },
            ],
        });
        expect(JSON.stringify(request)).not.toContain(key);
        expect(findings).toEqual([{ type: 'github-token', count: 3 }]);
    });

    it('measures entropy', () => {
        expect(entropy('aaaa')).toBe(0);
        expect(entropy('abcd')).toBe(2);
    });
});

describe('budgets and estimates', () => {
    it('enforces daily and monthly caps per provider, in UTC', async () => {
        let now = Date.UTC(2026, 10, 23, 23, 0);
        const budget = new Budget({ anthropic: { tokensPerDay: 1000, tokensPerMonth: 1500 } }, new MemoryUsageStore(), () => now);
        await budget.add('anthropic', 1000);
        expect((await budget.status('anthropic')).ok).toBe(false);
        expect((await budget.status('ollama')).ok).toBe(true); // no limits set
        now = Date.UTC(2026, 10, 24, 1, 0); // next day
        expect(await budget.status('anthropic')).toMatchObject({ ok: true, usedToday: 0, usedThisMonth: 1000 });
        await budget.add('anthropic', 600);
        expect((await budget.status('anthropic')).reason).toMatch(/monthly budget/);
    });

    it('estimates runs in tokens, and in cost only with a price', () => {
        expect(estimateTokens('12345678')).toBe(2);
        expect(estimateRun([{ input: 'x'.repeat(4000), maxOutput: 100 }, { input: 500, maxOutput: 100 }])).toEqual({
            calls: 2,
            inputTokens: 1500,
            outputTokens: 200,
        });
        expect(estimateRun([{ input: 1_000_000, maxOutput: 1_000_000 }], { inputPer1M: 2, outputPer1M: 10 }).cost).toBe(12);
    });
});
