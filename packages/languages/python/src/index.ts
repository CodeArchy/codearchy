/**
 * @codearchy/lang-python — the Python language pack (tree-sitter query + rules).
 * See docs/guides/adding-a-language.md.
 */
import { defineLanguage, type ImportDetails } from '@codearchy/sdk';

const pack = defineLanguage({
    id: 'python',
    displayName: 'Python',
    extensions: ['.py', '.pyi'],
    grammar: 'tree-sitter-python.wasm',
    sample: 'def f():\n    return 1\n',
    query: `
(function_definition name: (identifier) @name) @def.function
(class_definition name: (identifier) @name) @def.class
(module (expression_statement (assignment left: (identifier) @name)) @def.variable)
(import_statement name: (dotted_name) @import.source) @import.stmt
(import_statement name: (aliased_import name: (dotted_name) @import.source)) @import.stmt
(import_from_statement module_name: (_) @import.source) @import.stmt
`,
    containerKinds: ['class'],
    isExported: ({ name, topLevel }) => topLevel && !name.startsWith('_'),
    importDetails(stmt) {
        const details: ImportDetails = { specifiers: [], isDefault: false, isNamespace: false };
        if (stmt.type === 'import_from_statement') {
            for (const n of stmt.childrenForFieldName('name')) {
                if (!n) continue;
                const target = n.type === 'aliased_import' ? n.childForFieldName('name') : n;
                if (target) details.specifiers.push(target.text);
            }
            if (stmt.namedChildren.some((c) => c?.type === 'wildcard_import')) details.isNamespace = true;
        } else {
            details.isNamespace = true;
        }
        return details;
    },
});

export default pack;
