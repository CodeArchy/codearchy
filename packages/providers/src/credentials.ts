/**
 * Where API keys live. Each host provides its own store: VS Code's
 * SecretStorage (the OS keychain), and in the browser a store on this origin.
 * Keys never go into settings files, logs or the audit log.
 */
export interface SecretStore {
    get(name: string): Promise<string | undefined>;
    set(name: string, value: string): Promise<void>;
    delete(name: string): Promise<void>;
}

/** Holds keys for this session only (tests, or a user who prefers not to save keys). */
export class MemorySecretStore implements SecretStore {
    private readonly values = new Map<string, string>();
    async get(name: string) {
        return this.values.get(name);
    }
    async set(name: string, value: string) {
        this.values.set(name, value);
    }
    async delete(name: string) {
        this.values.delete(name);
    }
}

/** The store key for a provider's API key. */
export function apiKeyName(providerId: string): string {
    return `codearchy.provider.${providerId}.apiKey`;
}
