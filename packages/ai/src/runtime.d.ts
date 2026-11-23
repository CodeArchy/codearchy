/**
 * Web-platform globals this package uses. Node 22+, browsers, workers and the
 * VS Code extension host all provide them; the package compiles without the
 * DOM or Node libraries so nothing host-specific can slip in.
 */
declare function structuredClone<T>(value: T): T;
declare class AbortController {
    readonly signal: {
        readonly aborted: boolean;
        readonly reason?: unknown;
        addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
        removeEventListener(type: 'abort', listener: () => void): void;
    };
    abort(reason?: unknown): void;
}
