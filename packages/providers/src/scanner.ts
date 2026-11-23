/**
 * Secret scanner: redacts credentials from text before it goes to a remote
 * model. Two passes: known token formats (high confidence), then values
 * assigned to secret-sounding names that look random (entropy check).
 *
 * Every pattern uses bounded repetition so scanning stays linear on any input.
 */
import type { ChatMessage, ChatRequest } from './types.js';

export interface SecretFinding {
    /** Which detector matched, e.g. 'github-token', 'private-key', 'assignment'. */
    type: string;
    count: number;
}

interface Detector {
    type: string;
    pattern: RegExp;
    /** Extra test for formats whose prefix alone is too common (e.g. `sk-`). */
    check?: (match: string) => boolean;
}

const KNOWN: Detector[] = [
    { type: 'private-key', pattern: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]{0,12000}?-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g },
    { type: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
    { type: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g },
    { type: 'gitlab-token', pattern: /\bglpat-[A-Za-z0-9_-]{20,64}\b/g },
    { type: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,250}\b/g },
    { type: 'stripe-key', pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,250}\b/g },
    { type: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
    { type: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,300}/g },
    // `sk-` also starts ordinary kebab-case words: only redact random-looking values.
    { type: 'openai-key', pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,300}/g, check: (m) => looksSecret(m.slice(3)) },
    { type: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,2000}\.eyJ[A-Za-z0-9_-]{8,4000}\.[A-Za-z0-9_-]{8,2000}/g },
    { type: 'connection-string', pattern: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@"'`]{1,100}:[^\s@/"'`]{3,200}@/g },
];

/** `NAME = value` / `name: "value"`: the name is checked separately (keeps the pattern linear). */
const ASSIGNMENT = /([A-Za-z_][A-Za-z0-9_.-]{0,80})(["']?[ \t]{0,8}[:=][ \t]{0,8}["'`]?)([^\s"'`,;]{12,300})/g;
const SECRET_NAME = /(?:api[_-]?key|secret|token|passw(?:or)?d|passwd|credential|private[_-]?key|auth|access[_-]?key)/i;

/** Shannon entropy in bits per character. */
export function entropy(value: string): number {
    const counts = new Map<string, number>();
    for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    let bits = 0;
    for (const n of counts.values()) {
        const p = n / value.length;
        bits -= p * Math.log2(p);
    }
    return bits;
}

/** A value that looks like a real secret rather than code, a placeholder or a reference. */
function looksSecret(value: string): boolean {
    if (/[(){}<>$\[\]]/.test(value)) return false; // calls, templates, placeholders
    if (/^(?:process|import|os|env|self|this|config|settings)\./i.test(value)) return false;
    if (/^(?:true|false|null|undefined|none)$/i.test(value)) return false;
    if (!/\d/.test(value) || !/[A-Za-z]/.test(value)) return false;
    // lower-case words joined by _ or - (oauth2_device_flow, v2-beta-build): an identifier, not a key
    if (/^[a-z0-9]{1,40}(?:[_-][a-z0-9]{1,40}){1,12}$/.test(value)) return false;
    return entropy(value) >= 3.5;
}

/** Redacts secrets from `text`. Returns the clean text and what was found (never the secrets themselves). */
export function scanSecrets(text: string): { text: string; findings: SecretFinding[] } {
    const found = new Map<string, number>();
    const note = (type: string) => found.set(type, (found.get(type) ?? 0) + 1);
    let out = text;
    for (const { type, pattern, check } of KNOWN) {
        pattern.lastIndex = 0;
        out = out.replace(pattern, (match: string) => {
            if (check && !check(match)) return match;
            note(type);
            return `[REDACTED:${type}]`;
        });
    }
    ASSIGNMENT.lastIndex = 0;
    out = out.replace(ASSIGNMENT, (whole, name: string, sep: string, value: string) => {
        if (!SECRET_NAME.test(name) || value.startsWith('[REDACTED') || !looksSecret(value)) return whole;
        note('assignment');
        return `${name}${sep}[REDACTED:assignment]`;
    });
    return { text: out, findings: [...found].map(([type, count]) => ({ type, count })) };
}

/** Redacts every text field of a request that leaves the machine. */
export function redactRequest(request: ChatRequest): { request: ChatRequest; findings: SecretFinding[] } {
    const totals = new Map<string, number>();
    const clean = (text: string): string => {
        const r = scanSecrets(text);
        for (const f of r.findings) totals.set(f.type, (totals.get(f.type) ?? 0) + f.count);
        return r.text;
    };
    const messages = request.messages.map((m): ChatMessage => {
        switch (m.role) {
            case 'user':
                return { ...m, content: clean(m.content) };
            case 'tool':
                return { ...m, content: clean(m.content) };
            case 'assistant':
                // The model wrote it; it only ever saw redacted input, so there's nothing new to find.
                return m;
        }
    });
    return {
        request: { ...request, ...(request.system !== undefined ? { system: clean(request.system) } : {}), messages },
        findings: [...totals].map(([type, count]) => ({ type, count })),
    };
}
