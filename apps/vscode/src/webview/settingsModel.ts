/**
 * The Settings panel's model, without VS Code: the `codearchy.*` settings read
 * from the extension's manifest, and the check every value from the panel
 * passes before it's written (see settings.ts).
 */

export interface SettingSchema {
    key: string;
    type: 'boolean' | 'string' | 'number' | 'integer' | 'array' | 'object';
    default?: unknown;
    /** Markdown (VS Code's `markdownDescription`, else `description`). */
    description: string;
    enum?: unknown[];
    enumDescriptions?: string[];
    /** Arrays: the items' type and, when fixed, their choices. */
    items?: { type?: string; enum?: unknown[]; enumDescriptions?: string[] };
    minimum?: number;
    maximum?: number;
    /** `application` / `machine` settings can't be set per workspace. */
    scope?: string;
    deprecated?: string;
}

export interface SettingValue extends SettingSchema {
    user?: unknown;
    workspace?: unknown;
    /** What applies now (workspace over user over default). */
    value: unknown;
}

export interface SettingsSnapshot {
    settings: SettingValue[];
    /** A folder is open (workspace values can be set). */
    hasWorkspace: boolean;
}

export type SettingsTarget = 'user' | 'workspace';

type Properties = Record<string, Record<string, unknown>>;

/** The `codearchy.*` settings in the extension's manifest. */
export function settingsSchema(packageJSON: unknown): SettingSchema[] {
    const contributes = (packageJSON as { contributes?: { configuration?: unknown } })?.contributes?.configuration;
    const sections = (Array.isArray(contributes) ? contributes : [contributes]) as Array<{ properties?: Properties } | undefined>;
    const out: SettingSchema[] = [];
    for (const section of sections) {
        for (const [key, p] of Object.entries(section?.properties ?? {})) {
            if (!key.startsWith('codearchy.')) continue;
            const type = (Array.isArray(p.type) ? p.type[0] : p.type) as SettingSchema['type'];
            const items = p.items as SettingSchema['items'] | undefined;
            const deprecated = (p.markdownDeprecationMessage ?? p.deprecationMessage) as string | undefined;
            out.push({
                key,
                type,
                ...('default' in p ? { default: p.default } : {}),
                description: String(p.markdownDescription ?? p.description ?? ''),
                ...(Array.isArray(p.enum) ? { enum: p.enum } : {}),
                ...(Array.isArray(p.enumDescriptions) ? { enumDescriptions: p.enumDescriptions as string[] } : Array.isArray(p.markdownEnumDescriptions) ? { enumDescriptions: p.markdownEnumDescriptions as string[] } : {}),
                ...(items ? { items: { type: items.type, ...(items.enum ? { enum: items.enum } : {}), ...(items.enumDescriptions ? { enumDescriptions: items.enumDescriptions } : {}) } } : {}),
                ...(typeof p.minimum === 'number' ? { minimum: p.minimum } : {}),
                ...(typeof p.maximum === 'number' ? { maximum: p.maximum } : {}),
                ...(typeof p.scope === 'string' ? { scope: p.scope } : {}),
                ...(deprecated ? { deprecated } : {}),
            });
        }
    }
    return out;
}

/** Why `value` doesn't fit the setting (undefined when it does). */
export function invalid(s: SettingSchema, value: unknown): string | undefined {
    const inEnum = (choices: unknown[] | undefined, v: unknown) => !choices || choices.includes(v);
    switch (s.type) {
        case 'boolean':
            return typeof value === 'boolean' ? undefined : 'expected true or false';
        case 'string':
            if (typeof value !== 'string' || value.length > 2000) return 'expected text';
            return inEnum(s.enum, value) ? undefined : `expected one of ${s.enum!.join(', ')}`;
        case 'number':
        case 'integer':
            if (typeof value !== 'number' || !Number.isFinite(value)) return 'expected a number';
            if (s.type === 'integer' && !Number.isInteger(value)) return 'expected a whole number';
            if (s.minimum !== undefined && value < s.minimum) return `at least ${s.minimum}`;
            if (s.maximum !== undefined && value > s.maximum) return `at most ${s.maximum}`;
            return undefined;
        case 'array':
            if (!Array.isArray(value) || value.length > 500) return 'expected a list';
            for (const v of value) {
                if (s.items?.type === 'string' || s.items?.enum || !s.items?.type) {
                    if (typeof v !== 'string' || v.length > 500) return 'expected a list of text';
                }
                if (!inEnum(s.items?.enum, v)) return `${String(v)} isn't one of ${s.items!.enum!.join(', ')}`;
            }
            return undefined;
        default:
            return 'edit this one in settings.json';
    }
}
