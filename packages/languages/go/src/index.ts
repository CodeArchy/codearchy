/**
 * @codearchy/lang-go — the Go language pack (tree-sitter query + rules).
 * See docs/guides/adding-a-language.md.
 */
import { defineLanguage } from '@codearchy/sdk';

const pack = defineLanguage({
    id: 'go',
    displayName: 'Go',
    extensions: ['.go'],
    grammar: 'tree-sitter-go.wasm',
    sample: 'package a\nfunc F() {}\n',
    query: `
(package_clause (package_identifier) @namespace)
(import_spec path: (_) @import.source) @import.stmt
(function_declaration name: (identifier) @name) @def.function
(method_declaration name: (field_identifier) @name) @def.method
(type_spec name: (type_identifier) @name type: (struct_type)) @def.class
(type_spec name: (type_identifier) @name type: (interface_type)) @def.interface
(type_spec name: (type_identifier) @name) @def.type
(type_alias name: (type_identifier) @name) @def.type
`,
    isExported: ({ name, kind, topLevel }) => topLevel && kind !== 'method' && /^[A-Z]/.test(name),
    importDetails: () => ({ specifiers: [], isDefault: false, isNamespace: true }),
    containerName(def) {
        if (def.type !== 'method_declaration') return undefined;
        const receiver = def.childForFieldName('receiver');
        const typeNode = receiver?.descendantsOfType('type_identifier')[0];
        return typeNode?.text;
    },
    referenceNodeTypes: ['type_identifier', 'field_identifier', 'identifier'],
});

export default pack;
