/**
 * The web-platform globals this package uses. Node 22+, browsers and workers
 * all provide them; the package compiles without the DOM or Node libraries so
 * nothing host-specific can slip in.
 */
declare class TextDecoder {
    constructor(label?: string);
    decode(input?: Uint8Array, options?: { stream?: boolean }): string;
}
declare function setTimeout(handler: () => void, ms?: number): unknown;
declare function clearTimeout(handle: unknown): void;
