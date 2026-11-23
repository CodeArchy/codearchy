/**
 * Privacy tiers: what may leave the machine, and to whom.
 *
 *   local-only  nothing leaves: only providers on this machine (loopback) are used
 *   structure   paths, names, signatures, docs, edges and metrics may go to a
 *               remote model; code bodies may not
 *   excerpts    as `structure`, plus capped code excerpts
 *
 * On-device providers may see anything in every tier: nothing leaves the machine.
 */
import type { ProviderAdapter } from './types.js';

export type PrivacyTier = 'local-only' | 'structure' | 'excerpts';

/** What a request carries, declared by whoever builds it. */
export type ContentKind = 'structure' | 'excerpts';

export interface PrivacyPolicy {
    tier: PrivacyTier;
    /** Show every remote request to the user before it's sent. */
    askBeforeSend?: boolean;
}

export type Decision = { ok: true } | { ok: false; reason: string };

/** True for localhost, *.localhost, 127.0.0.0/8 and ::1. Anything else (a LAN address included) is remote. */
export function isLoopback(url: string | undefined): boolean {
    const host = hostOf(url);
    if (!host) return false;
    if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
    const parts = host.split('.');
    return parts.length === 4 && parts[0] === '127' && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** Host name of an absolute URL, lower-cased, without brackets or port. Parsed by hand: no URL global needed. */
export function hostOf(url: string | undefined): string | undefined {
    if (!url) return undefined;
    const scheme = url.indexOf('://');
    if (scheme <= 0) return undefined;
    let rest = url.slice(scheme + 3);
    const at = rest.lastIndexOf('@', firstOf(rest, '/?#'));
    if (at >= 0) rest = rest.slice(at + 1); // drop userinfo
    if (rest.startsWith('[')) {
        const close = rest.indexOf(']');
        return close > 0 ? rest.slice(1, close).toLowerCase() : undefined;
    }
    const end = firstOf(rest, ':/?#');
    const host = rest.slice(0, end).toLowerCase();
    return host || undefined;
}

function firstOf(text: string, chars: string): number {
    let best = text.length;
    for (const c of chars) {
        const i = text.indexOf(c);
        if (i >= 0 && i < best) best = i;
    }
    return best;
}

/** Whether a provider's requests stay on this machine. */
export function isOnDevice(adapter: Pick<ProviderAdapter, 'kind' | 'baseUrl'>): boolean {
    return adapter.kind === 'local' && isLoopback(adapter.baseUrl);
}

/** May this provider be used at all under the policy? (Checked before any network call, detect() included.) */
export function checkProvider(policy: PrivacyPolicy, adapter: Pick<ProviderAdapter, 'kind' | 'baseUrl' | 'label'>): Decision {
    if (policy.tier === 'local-only' && !isOnDevice(adapter)) {
        return { ok: false, reason: `${adapter.label} is not on this machine, and the privacy tier is local only` };
    }
    return { ok: true };
}

/** May a request carrying `contains` go to this provider? */
export function checkContent(
    policy: PrivacyPolicy,
    adapter: Pick<ProviderAdapter, 'kind' | 'baseUrl' | 'label'>,
    contains: ReadonlyArray<ContentKind>,
): Decision {
    const provider = checkProvider(policy, adapter);
    if (!provider.ok || isOnDevice(adapter)) return provider;
    if (contains.includes('excerpts') && policy.tier !== 'excerpts') {
        return { ok: false, reason: `This request includes code, and the privacy tier doesn't allow code to leave the machine` };
    }
    return { ok: true };
}
