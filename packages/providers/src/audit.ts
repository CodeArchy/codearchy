/**
 * The audit log: one entry per model request (sent, blocked or failed), kept
 * locally so the user can see exactly what went where. Entries never contain
 * prompt text or credentials, only metadata.
 */
import type { ProviderErrorCode } from './errors.js';
import type { ContentKind, PrivacyTier } from './privacy.js';

export type Role = 'summarizer' | 'architect' | 'chat' | 'embedder';

export interface AuditEntry {
    /** Epoch milliseconds. */
    at: number;
    provider: string;
    model: string;
    role: Role;
    /** Whether the request left the machine. */
    remote: boolean;
    tier: PrivacyTier;
    contains: ContentKind[];
    outcome: 'sent' | 'blocked' | 'error' | 'cancelled';
    /** Why it was blocked, or the error code. */
    reason?: string;
    errorCode?: ProviderErrorCode;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    /** Secrets redacted before sending, by detector. */
    redactions?: Record<string, number>;
    /** Graph nodes whose content was included (ids only). */
    nodes?: string[];
    durationMs?: number;
}

export interface AuditLog {
    record(entry: AuditEntry): void | Promise<void>;
    entries(): AuditEntry[] | Promise<AuditEntry[]>;
}

/** In-memory log, newest last, capped. Hosts persist it themselves if they want history across sessions. */
export class MemoryAuditLog implements AuditLog {
    private readonly items: AuditEntry[] = [];
    constructor(private readonly limit = 2000) {}

    record(entry: AuditEntry): void {
        this.items.push(entry);
        if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
    }

    entries(): AuditEntry[] {
        return [...this.items];
    }
}

/** JSON Lines, for "Export audit log". */
export function exportAudit(entries: ReadonlyArray<AuditEntry>): string {
    return entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
}
