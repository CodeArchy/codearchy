/**
 * @codearchy/lang-rust — the Rust language pack (tree-sitter query + rules).
 * See docs/guides/adding-a-language.md.
 */
import { defineLanguage } from '@codearchy/sdk';

/** `a::{b, c::{d, e}}` → [`a::b`, `a::c::d`, `a::c::e`]. Drops `as` aliases and `::*`. */
export function expandRustUse(text: string): string[] {
    // One linear pass over whitespace-separated tokens (no backtracking regex on
    // repository text): drop each `as <alias>` and join the rest without spaces.
    const tokens = text.split(/\s/).filter((t) => t !== '');
    let clean = '';
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i] === 'as' && i > 0 && i + 1 < tokens.length) {
            clean += tokens[++i].replace(/^\w+/, ''); // keep what follows the alias: `H,` → `,`
        } else {
            clean += tokens[i];
        }
    }
    const out: string[] = [];
    const walk = (prefix: string, body: string) => {
        const brace = body.indexOf('{');
        if (brace < 0) {
            const item = body.replace(/::\*$/, '').replace(/^self$/, '');
            const joined = item ? (prefix ? `${prefix}::${item}` : item) : prefix;
            if (joined) out.push(joined);
            return;
        }
        const head = body.slice(0, brace).replace(/::$/, '');
        const inner = body.slice(brace + 1, body.lastIndexOf('}'));
        const nextPrefix = head ? (prefix ? `${prefix}::${head}` : head) : prefix;
        for (const part of splitTopLevel(inner)) walk(nextPrefix, part);
    };
    walk('', clean.replace(/;$/, ''));
    return [...new Set(out)];
}

function splitTopLevel(s: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '{') depth++;
        else if (s[i] === '}') depth--;
        else if (s[i] === ',' && depth === 0) {
            parts.push(s.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(s.slice(start));
    return parts.filter(Boolean);
}

const pack = defineLanguage({
    id: 'rust',
    displayName: 'Rust',
    extensions: ['.rs'],
    grammar: 'tree-sitter-rust.wasm',
    sample: 'pub fn f() {}',
    query: `
(function_item name: (identifier) @name) @def.function
(struct_item name: (type_identifier) @name) @def.class
(union_item name: (type_identifier) @name) @def.class
(enum_item name: (type_identifier) @name) @def.enum
(trait_item name: (type_identifier) @name) @def.interface
(type_item name: (type_identifier) @name) @def.type
(impl_item type: (type_identifier) @name) @def.impl
(impl_item type: (generic_type type: (type_identifier) @name)) @def.impl
(mod_item name: (identifier) @name body: (declaration_list)) @def.module
(mod_item name: (identifier) @import.mod !body) @import.stmt
(use_declaration argument: (_) @import.source) @import.stmt
`,
    isExported: ({ node, topLevel }) => topLevel && node.namedChildren.some((c) => c?.type === 'visibility_modifier'),
    expandImport: (source) => expandRustUse(source),
    importDetails: () => ({ specifiers: [], isDefault: false, isNamespace: false }),
});

export default pack;
