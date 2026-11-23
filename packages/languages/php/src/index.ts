/**
 * @codearchy/lang-php — the PHP language pack (tree-sitter query + rules).
 * See docs/guides/adding-a-language.md.
 */
import { defineLanguage } from '@codearchy/sdk';

const pack = defineLanguage({
    id: 'php',
    displayName: 'PHP',
    extensions: ['.php'],
    grammar: 'tree-sitter-php.wasm',
    sample: '<?php function f() {}',
    query: `
(namespace_definition name: (_) @namespace)
(namespace_use_declaration) @import.stmt
(require_expression [(string) (encapsed_string)] @import.source) @import.stmt
(require_once_expression [(string) (encapsed_string)] @import.source) @import.stmt
(include_expression [(string) (encapsed_string)] @import.source) @import.stmt
(include_once_expression [(string) (encapsed_string)] @import.source) @import.stmt
(require_once_expression (binary_expression right: [(string) (encapsed_string)] @import.source)) @import.stmt
(require_expression (binary_expression right: [(string) (encapsed_string)] @import.source)) @import.stmt
(include_expression (binary_expression right: [(string) (encapsed_string)] @import.source)) @import.stmt
(include_once_expression (binary_expression right: [(string) (encapsed_string)] @import.source)) @import.stmt
(class_declaration name: (_) @name) @def.class
(interface_declaration name: (_) @name) @def.interface
(trait_declaration name: (_) @name) @def.interface
(enum_declaration name: (_) @name) @def.enum
(function_definition name: (_) @name) @def.function
(method_declaration name: (_) @name) @def.method
`,
    isExported: ({ topLevel }) => topLevel,
    importsFromStatement(stmt) {
        if (stmt.type !== 'namespace_use_declaration') return [];
        // use A\B\{C, D as E};  → prefix A\B
        const group = stmt.namedChildren.find((c) => c?.type === 'namespace_use_group');
        const prefixNode = group ? stmt.namedChildren.find((c) => c?.type === 'namespace_name') : undefined;
        const prefix = prefixNode ? prefixNode.text.replace(/^\\/, '') : '';
        const out: string[] = [];
        for (const clause of stmt.descendantsOfType('namespace_use_clause')) {
            const target = clause?.namedChildren.find((c) => c?.type === 'qualified_name' || c?.type === 'name');
            if (!target) continue;
            const name = target.text.replace(/^\\/, '');
            out.push(prefix ? `${prefix}\\${name}` : name);
        }
        return out;
    },
    importDetails: () => ({ specifiers: [], isDefault: false, isNamespace: false }),
    referenceNodeTypes: ['name'],
});

export default pack;
