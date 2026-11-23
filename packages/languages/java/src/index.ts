/**
 * @codearchy/lang-java — the Java language pack (tree-sitter query + rules).
 * See docs/guides/adding-a-language.md.
 */
import { defineLanguage, modifierText } from '@codearchy/sdk';

const pack = defineLanguage({
    id: 'java',
    displayName: 'Java',
    extensions: ['.java'],
    grammar: 'tree-sitter-java.wasm',
    sample: 'class A { void f() {} }',
    query: `
(package_declaration [(scoped_identifier) (identifier)] @namespace)
(import_declaration [(scoped_identifier) (identifier)] @import.source) @import.stmt
(class_declaration name: (_) @name) @def.class
(interface_declaration name: (_) @name) @def.interface
(enum_declaration name: (_) @name) @def.enum
(record_declaration name: (_) @name) @def.class
(annotation_type_declaration name: (_) @name) @def.interface
(method_declaration name: (_) @name) @def.method
`,
    isExported: ({ node, topLevel }) => topLevel && /\bpublic\b/.test(modifierText(node, ['modifiers'])),
    expandImport: (source, stmt) => [stmt && /\.\s*\*\s*;?\s*$/.test(stmt.text) ? `${source}.*` : source],
    importDetails: (stmt) => ({ specifiers: [], isDefault: false, isNamespace: /\*\s*;?\s*$/.test(stmt.text) }),
    referenceNodeTypes: ['type_identifier', 'identifier'],
});

export default pack;
