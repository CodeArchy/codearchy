/**
 * Summary cards: one per hierarchy node (modules and up). A card is either
 * deterministic (built from names, docs and structure, no AI) or AI-written;
 * the UI always says which.
 */
import type { HierarchyKind } from '@codearchy/protocol';
import type { JsonSchema } from '@codearchy/providers';

export interface Card {
    /** The hierarchy node this card describes. */
    key: string;
    kind: HierarchyKind;
    /** A short descriptive title (AI) or the node's own name (deterministic). */
    title: string;
    /** One or two sentences: what this part is for. */
    purpose: string;
    responsibilities: string[];
    /** Child node keys that matter most (only ever keys the model was shown). */
    keyNodes: string[];
    risks: string[];
    /** 0..1: how sure the card is (deterministic cards stay low). */
    confidence: number;
    source: 'ai' | 'deterministic';
    provider?: string;
    model?: string;
    promptVersion: string;
    /** Cache key: hash of prompt version, model and inputs (children's card hashes included). */
    inputHash: string;
    /** Hash of this card's content; parents fold it into their own input hash. */
    hash: string;
    createdAt: number;
    /** Why an AI card wasn't produced, when this is a fallback. */
    note?: string;
}

/** What the model must return. Limits are enforced by `validate`, not the schema (not every provider supports them). */
export interface CardDraft {
    title: string;
    purpose: string;
    responsibilities: string[];
    keyNodes: string[];
    risks: string[];
    confidence: number;
}

export const CARD_SCHEMA: JsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'purpose', 'responsibilities', 'keyNodes', 'risks', 'confidence'],
    properties: {
        title: { type: 'string', description: 'A short descriptive name, at most 6 words' },
        purpose: { type: 'string', description: 'One or two sentences on what this part is for' },
        responsibilities: { type: 'array', items: { type: 'string' }, description: 'Up to 5 short phrases' },
        keyNodes: { type: 'array', items: { type: 'string' }, description: 'Up to 5 refs exactly as given, e.g. "C2"' },
        risks: { type: 'array', items: { type: 'string' }, description: 'Up to 3, only if the facts show them' },
        confidence: { type: 'number', description: '0 to 1' },
    },
};

const LIMITS = { title: 60, purpose: 320, item: 140, responsibilities: 5, keyNodes: 5, risks: 3 };

export class CardFormatError extends Error {}

/** Pulls the JSON object out of a model reply (tolerating code fences or a sentence around it). */
export function extractJson(text: string): unknown {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new CardFormatError('The reply has no JSON object');
    try {
        return JSON.parse(text.slice(start, end + 1)) as unknown;
    } catch (err) {
        throw new CardFormatError(`The reply is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
    }
}

/** "None", "No specific risks identified" and the like: not a risk. */
const NOT_A_RISK = /^(?:none|n\/a|not applicable|nothing)\b|^no (?:[a-z]+ ){0,3}risks?\b|\bno risks? (?:identified|found|shown)\b|^(?:thin|minimal|limited) (?:facts|context|documentation)\b|^(?:low )?confidence\b/i;

/** A ref like "S3" or "C12" inside prose. */
const REF_IN_TEXT = /\b[SC]\d{1,3}\b/g;

/**
 * Checks a draft against the schema and the parts the model was shown.
 * Refs (or exact names) of shown parts map back to node keys; anything else is
 * dropped (the citation guard). Refs inside the prose become names; text is capped.
 */
export function validate(
    value: unknown,
    refs: ReadonlyMap<string, string>,
    labels: ReadonlyMap<string, string> = new Map(),
): { draft: CardDraft; unknownRefs: string[] } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CardFormatError('Expected a JSON object');
    const v = value as Record<string, unknown>;
    const named = (text: string) => text.replace(REF_IN_TEXT, (ref) => labels.get(ref) ?? ref);
    const str = (name: string, max: number): string => {
        const s = v[name];
        if (typeof s !== 'string' || !s.trim()) throw new CardFormatError(`"${name}" must be a non-empty string`);
        return cap(named(s), max);
    };
    const list = (name: string, maxItems: number): string[] => {
        const a = v[name] ?? [];
        if (!Array.isArray(a)) throw new CardFormatError(`"${name}" must be an array of strings`);
        return a
            .filter((x): x is string => typeof x === 'string' && !!x.trim())
            .slice(0, maxItems)
            .map((x) => cap(named(x), LIMITS.item));
    };
    // Exact names of shown parts count as citations too (smaller models often cite by name).
    const byName = new Map<string, string>();
    for (const [ref, label] of labels) {
        const key = refs.get(ref);
        if (key) byName.set(label.toLowerCase(), key);
    }
    const confidence = typeof v.confidence === 'number' && Number.isFinite(v.confidence) ? Math.min(1, Math.max(0, v.confidence)) : 0.5;
    const unknownRefs: string[] = [];
    const keyNodes: string[] = [];
    const rawRefs = Array.isArray(v.keyNodes) ? v.keyNodes.filter((x): x is string => typeof x === 'string').slice(0, 20) : list('keyNodes', 20);
    for (const ref of rawRefs) {
        const t = ref.trim();
        // "S2", "S2 UsageStore", "S2: UsageStore", or the bare name.
        const lead = /^([SC]\d{1,3})\b/i.exec(t)?.[1]?.toUpperCase();
        const key = refs.get(t.toUpperCase()) ?? (lead ? refs.get(lead) : undefined) ?? byName.get(t.toLowerCase());
        if (key) {
            if (!keyNodes.includes(key) && keyNodes.length < LIMITS.keyNodes) keyNodes.push(key);
        } else unknownRefs.push(ref);
    }
    return {
        draft: {
            title: str('title', LIMITS.title),
            purpose: str('purpose', LIMITS.purpose),
            responsibilities: list('responsibilities', LIMITS.responsibilities),
            keyNodes,
            risks: list('risks', 10)
                .filter((r) => !NOT_A_RISK.test(r))
                .slice(0, LIMITS.risks),
            // Citing things that weren't shown is a sign of guessing.
            confidence: unknownRefs.length ? Math.min(confidence, 0.4) : confidence,
        },
        unknownRefs,
    };
}

function cap(text: string, max: number): string {
    const t = text.replace(/\s+/g, ' ').trim();
    return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}
