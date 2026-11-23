/**
 * @codearchy/lang-kotlin — the Kotlin language pack (tree-sitter query + rules).
 * See docs/guides/adding-a-language.md.
 */
import { defineLanguage, modifierText } from '@codearchy/sdk';

const pack = defineLanguage({
    id: 'kotlin',
    displayName: 'Kotlin',
    extensions: ['.kt', '.kts'],
    grammar: 'tree-sitter-kotlin.wasm',
    sample: 'class A {\n    fun f() = 1\n}\n',
    query: `
(package_header (qualified_identifier) @namespace)
(import (qualified_identifier) @import.source) @import.stmt
(class_declaration name: (_) @name) @def.class
(object_declaration name: (_) @name) @def.class
(function_declaration name: (_) @name) @def.function
(type_alias type: (_) @name) @def.type
`,
    isExported: ({ node, topLevel }) =>
        topLevel && !/\b(private|internal)\b/.test(modifierText(node, ['modifiers'])),
    expandImport: (source, stmt) => [stmt && /\.\s*\*\s*$/.test(stmt.text.trim()) ? `${source}.*` : source],
    importDetails: (stmt) => ({ specifiers: [], isDefault: false, isNamespace: /\*\s*$/.test(stmt.text.trim()) }),
    referenceNodeTypes: ['identifier'],
});

export default pack;
