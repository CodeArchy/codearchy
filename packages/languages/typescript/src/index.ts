/**
 * @codearchy/lang-typescript — the TypeScript language pack (tree-sitter query + rules).
 * See docs/guides/adding-a-language.md.
 */
import { defineLanguage } from '@codearchy/sdk';
import { JS_QUERY, jsImportDetails, jsIsExported } from '@codearchy/lang-javascript';

export const TS_QUERY = `${JS_QUERY}
(abstract_class_declaration name: (_) @name) @def.class
(interface_declaration name: (_) @name) @def.interface
(type_alias_declaration name: (_) @name) @def.type
(enum_declaration name: (_) @name) @def.enum
(abstract_method_signature name: (_) @name) @def.method
`;


const pack = defineLanguage({
    id: 'typescript',
    displayName: 'TypeScript',
    extensions: ['.ts', '.tsx', '.mts', '.cts'],
    grammar: 'tree-sitter-typescript.wasm',
    sample: 'export function f(): number { return 1; }',
    grammarByExtension: { '.tsx': 'tree-sitter-tsx.wasm' },
    query: TS_QUERY,
    isExported: jsIsExported,
    importDetails: jsImportDetails,
});

export default pack;
