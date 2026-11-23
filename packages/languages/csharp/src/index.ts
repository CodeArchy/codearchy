/**
 * @codearchy/lang-csharp — the C# language pack (tree-sitter query + rules).
 * See docs/guides/adding-a-language.md.
 */
import { defineLanguage, modifierText } from '@codearchy/sdk';

const pack = defineLanguage({
    id: 'csharp',
    displayName: 'C#',
    extensions: ['.cs'],
    grammar: 'tree-sitter-c_sharp.wasm',
    sample: 'class A { void F() {} }',
    query: `
(namespace_declaration name: (_) @namespace)
(file_scoped_namespace_declaration name: (_) @namespace)
(using_directive) @import.stmt
(class_declaration name: (_) @name) @def.class
(struct_declaration name: (_) @name) @def.class
(record_declaration name: (_) @name) @def.class
(interface_declaration name: (_) @name) @def.interface
(enum_declaration name: (_) @name) @def.enum
(method_declaration name: (_) @name) @def.method
`,
    isExported: ({ node, topLevel }) => topLevel && /\bpublic\b/.test(modifierText(node, ['modifier'])),
    importsFromStatement(stmt) {
        // using X.Y;  using static X.Y;  global using X;  using A = X.Y;
        const text = stmt.text
            .replace(/^\s*global\s+/, '')
            .replace(/^\s*using\s+/, '')
            .replace(/^static\s+/, '')
            .replace(/;\s*$/, '')
            .trim();
        const alias = text.match(/^\w+\s*=\s*(.+)$/);
        return [(alias ? alias[1] : text).replace(/<.*>$/, '').trim()].filter(Boolean);
    },
    importDetails: () => ({ specifiers: [], isDefault: false, isNamespace: true }),
    referenceNodeTypes: ['identifier'],
});

export default pack;
