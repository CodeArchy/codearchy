/** One error taxonomy for every provider. */

export type ProviderErrorCode =
    | 'auth' // missing, invalid or unauthorised credential
    | 'quota' // the account is out of credit or quota (not worth retrying)
    | 'rate_limit' // slow down; `retryAfterMs` when the provider says how long
    | 'context_overflow' // the request doesn't fit the model's context window
    | 'unavailable' // network failure, timeout, 5xx, overloaded
    | 'bad_request' // the provider rejected the request (unknown model, invalid parameter)
    | 'invalid_response' // the provider answered with something we couldn't parse
    | 'policy' // blocked before sending: privacy tier, budget, or the user declined
    | 'cancelled'; // the caller aborted

const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set(['rate_limit', 'unavailable']);

export class ProviderError extends Error {
    readonly code: ProviderErrorCode;
    readonly provider: string;
    readonly status?: number;
    readonly retryAfterMs?: number;

    constructor(
        code: ProviderErrorCode,
        provider: string,
        message: string,
        options: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
    ) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = 'ProviderError';
        this.code = code;
        this.provider = provider;
        this.status = options.status;
        this.retryAfterMs = options.retryAfterMs;
    }

    /** Worth trying again after a pause. */
    get retryable(): boolean {
        return RETRYABLE.has(this.code);
    }
}

export function isAbort(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

/** Wraps anything thrown while talking to a provider into a ProviderError. */
export function toProviderError(provider: string, err: unknown, signal?: { aborted: boolean }): ProviderError {
    if (err instanceof ProviderError) return err;
    if (signal?.aborted || isAbort(err)) return new ProviderError('cancelled', provider, 'Cancelled', { cause: err });
    const message = err instanceof Error ? err.message : String(err);
    // fetch rejects with a TypeError for network failures, DNS errors and CORS blocks alike.
    return new ProviderError('unavailable', provider, `Couldn't reach ${provider}: ${message}`, { cause: err });
}

const CONTEXT_OVERFLOW =
    /context[ _-]?(length|window)|maximum context|too many tokens|prompt is too long|input is too long|exceeds? the (maximum|context)|num_ctx/i;

/** Classifies an HTTP error response. `body` is the response text (already redacted). */
export function errorFromStatus(
    provider: string,
    status: number,
    body: string,
    retryAfterMs?: number,
): ProviderError {
    const message = summarise(body) || `HTTP ${status}`;
    const opts = { status, retryAfterMs };
    if (status === 401 || status === 403) return new ProviderError('auth', provider, message, opts);
    // Gemini answers a bad key with a 400.
    if (status === 400 && /API_KEY_INVALID|API key not valid/i.test(body)) {
        return new ProviderError('auth', provider, message, opts);
    }
    if (status === 402) return new ProviderError('quota', provider, message, opts);
    if (status === 429) {
        // OpenAI-style "insufficient_quota" comes back as a 429 but won't clear by waiting.
        if (/insufficient_quota|exceeded your current quota|billing/i.test(body)) {
            return new ProviderError('quota', provider, message, opts);
        }
        return new ProviderError('rate_limit', provider, message, opts);
    }
    if (status === 408 || status >= 500) return new ProviderError('unavailable', provider, message, opts);
    if (status === 400 || status === 413 || status === 422) {
        if (CONTEXT_OVERFLOW.test(body)) return new ProviderError('context_overflow', provider, message, opts);
    }
    return new ProviderError('bad_request', provider, message, opts);
}

/** Pulls a readable message out of a JSON error body, capped in length. */
function summarise(body: string): string {
    let text = body.trim();
    try {
        const json = JSON.parse(text) as unknown;
        const found = findMessage(json);
        if (found) text = found;
    } catch {
        // not JSON: keep the text
    }
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function findMessage(value: unknown, depth = 0): string | undefined {
    if (depth > 3 || value === null || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.message === 'string') return record.message;
    if (typeof record.error === 'string') return record.error;
    for (const key of ['error', 'detail']) {
        const nested = findMessage(record[key], depth + 1);
        if (nested) return nested;
    }
    if (Array.isArray(value)) return findMessage(value[0], depth + 1);
    return undefined;
}
