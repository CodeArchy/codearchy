/**
 * Built-in language packs: each lives in its own package
 * (packages/languages/<id>, `@codearchy/lang-<id>`) and is registered here.
 * Adding a language: `pnpm new:language` (see docs/guides/adding-a-language.md).
 */
import type { LanguagePack } from '@codearchy/sdk';
import csharp from '@codearchy/lang-csharp';
import go from '@codearchy/lang-go';
import java from '@codearchy/lang-java';
import javascript from '@codearchy/lang-javascript';
import kotlin from '@codearchy/lang-kotlin';
import php from '@codearchy/lang-php';
import python from '@codearchy/lang-python';
import rust from '@codearchy/lang-rust';
import typescript from '@codearchy/lang-typescript';
import ruby from '@codearchy/lang-ruby';
// new:language — imports above this line

export { expandRustUse } from '@codearchy/lang-rust';

// ─── registry ───────────────────────────────────────────────────────────────

export const LANGUAGE_PACKS: LanguagePack[] = [
    typescript,
    javascript,
    python,
    java,
    kotlin,
    go,
    rust,
    csharp,
    php,
    ruby,
    // new:language — packs above this line
];

export const DEFAULT_LANGUAGE_IDS = LANGUAGE_PACKS.map((p) => p.id);

const PACK_BY_EXTENSION = new Map<string, LanguagePack>();
for (const pack of LANGUAGE_PACKS) {
    for (const ext of pack.extensions) PACK_BY_EXTENSION.set(ext, pack);
}

export const LANGUAGE_EXTENSIONS: Record<string, string[]> = Object.fromEntries(
    LANGUAGE_PACKS.map((p) => [p.id, p.extensions])
);

export function getPackForExtension(ext: string): LanguagePack | undefined {
    return PACK_BY_EXTENSION.get(ext.toLowerCase());
}

export function getPackById(id: string): LanguagePack | undefined {
    return LANGUAGE_PACKS.find((p) => p.id === id);
}

export function getLanguageFromExtension(ext: string): string | undefined {
    return getPackForExtension(ext)?.id;
}

export function grammarFor(pack: LanguagePack, ext: string): string {
    return pack.grammarByExtension?.[ext.toLowerCase()] ?? pack.grammar;
}
