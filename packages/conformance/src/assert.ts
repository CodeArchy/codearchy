/** Minimal assertions that work in every runtime (no node:assert in browsers). */
export class AssertionError extends Error {}

export function ok(value: unknown, message: string): asserts value {
    if (!value) throw new AssertionError(message);
}

export function equal<T>(actual: T, expected: T, message: string): void {
    if (actual !== expected) throw new AssertionError(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export function deepEqual(actual: unknown, expected: unknown, message: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) {
        const max = 600;
        throw new AssertionError(`${message}:\n  expected ${e.slice(0, max)}\n  got      ${a.slice(0, max)}`);
    }
}

export async function rejects(fn: () => unknown, message: string): Promise<void> {
    try {
        await fn();
    } catch {
        return;
    }
    throw new AssertionError(message);
}
