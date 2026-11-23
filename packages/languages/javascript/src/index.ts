/**
 * @codearchy/lang-javascript — the JavaScript language pack (tree-sitter query + rules).
 * See docs/guides/adding-a-language.md.
 */
import { defineLanguage, hasAncestorOfType, type DefContext, type ImportDetails, type SyntaxNode } from '@codearchy/sdk';

export const JS_QUERY = `
(function_declaration name: (_) @name) @def.function
(generator_function_declaration name: (_) @name) @def.function
(class_declaration name: (_) @name) @def.class
(method_definition name: (_) @name) @def.method
(variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @def.function
(variable_declarator name: (identifier) @name) @def.variable
(import_statement source: (string (string_fragment) @import.source)) @import.stmt
(export_statement source: (string (string_fragment) @import.source)) @import.stmt
(call_expression
  function: (identifier) @_fn
  arguments: (arguments . (string (string_fragment) @import.source))
  (#eq? @_fn "require")) @import.stmt
(call_expression
  function: (import)
  arguments: (arguments . (string (string_fragment) @import.source))) @import.stmt
(export_statement !source (export_clause (export_specifier name: (_) @export.name)))
`;

export function jsImportDetails(stmt: SyntaxNode): ImportDetails {
    const details: ImportDetails = { specifiers: [], isDefault: false, isNamespace: false };
    if (stmt.type === 'import_statement') {
        const clause = stmt.namedChildren.find((c) => c?.type === 'import_clause');
        if (clause) {
            for (const child of clause.namedChildren) {
                if (!child) continue;
                if (child.type === 'identifier') details.isDefault = true;
                if (child.type === 'namespace_import') details.isNamespace = true;
            }
            for (const spec of clause.descendantsOfType('import_specifier')) {
                const name = spec?.childForFieldName('name');
                if (name) details.specifiers.push(name.text);
            }
        }
    } else if (stmt.type === 'export_statement') {
        const specs = stmt.descendantsOfType('export_specifier');
        if (specs.length === 0) details.isNamespace = true; // export * from
        for (const spec of specs) {
            const name = spec?.childForFieldName('name');
            if (name) details.specifiers.push(name.text);
        }
    } else {
        details.isNamespace = true; // require() / import()
    }
    return details;
}

/** Exported if the definition sits under an `export` statement. */
export function jsIsExported({ node, topLevel, kind }: DefContext): boolean {
    if (!topLevel || kind === 'method') return false;
    return hasAncestorOfType(node, 'export_statement', 3);
}

const pack = defineLanguage({
    id: 'javascript',
    displayName: 'JavaScript',
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    grammar: 'tree-sitter-javascript.wasm',
    sample: 'export function f() { return 1; }',
    query: JS_QUERY,
    isExported: jsIsExported,
    importDetails: jsImportDetails,
});

export default pack;
