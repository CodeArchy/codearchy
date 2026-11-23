/**
 * Built-in language packs (T1). Each is a `defineLanguage` pack; the registry
 * maps file extensions to packs. New languages are added the same way (see
 * the language-pack guide).
 */
import { defineLanguage, type DefContext, type DefKind, type ImportDetails, type LanguagePack, type SyntaxNode } from '@codearchy/sdk';

// ─── helpers ────────────────────────────────────────────────────────────────

function hasAncestorOfType(node: SyntaxNode, type: string, maxDepth: number): boolean {
    let current = node.parent;
    for (let depth = 0; current && depth < maxDepth; depth++) {
        if (current.type === type) return true;
        current = current.parent;
    }
    return false;
}

/** Text of the node's modifier children (`public static`, `pub`, ...). */
function modifierText(node: SyntaxNode, types: string[]): string {
    return node.namedChildren
        .filter((c): c is SyntaxNode => !!c && types.includes(c.type))
        .map((c) => c.text)
        .join(' ');
}

// ─── JavaScript / TypeScript ────────────────────────────────────────────────

const JS_QUERY = `
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

const TS_QUERY = `${JS_QUERY}
(abstract_class_declaration name: (_) @name) @def.class
(interface_declaration name: (_) @name) @def.interface
(type_alias_declaration name: (_) @name) @def.type
(enum_declaration name: (_) @name) @def.enum
(abstract_method_signature name: (_) @name) @def.method
`;

function jsImportDetails(stmt: SyntaxNode): ImportDetails {
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
function jsIsExported({ node, topLevel, kind }: DefContext): boolean {
    if (!topLevel || kind === 'method') return false;
    return hasAncestorOfType(node, 'export_statement', 3);
}

const javascript = defineLanguage({
    id: 'javascript',
    displayName: 'JavaScript',
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    grammar: 'tree-sitter-javascript.wasm',
    query: JS_QUERY,
    isExported: jsIsExported,
    importDetails: jsImportDetails,
});

const typescript = defineLanguage({
    id: 'typescript',
    displayName: 'TypeScript',
    extensions: ['.ts', '.tsx', '.mts', '.cts'],
    grammar: 'tree-sitter-typescript.wasm',
    grammarByExtension: { '.tsx': 'tree-sitter-tsx.wasm' },
    query: TS_QUERY,
    isExported: jsIsExported,
    importDetails: jsImportDetails,
});

// ─── Python ─────────────────────────────────────────────────────────────────

const python = defineLanguage({
    id: 'python',
    displayName: 'Python',
    extensions: ['.py', '.pyi'],
    grammar: 'tree-sitter-python.wasm',
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

// ─── Java ───────────────────────────────────────────────────────────────────

const java = defineLanguage({
    id: 'java',
    displayName: 'Java',
    extensions: ['.java'],
    grammar: 'tree-sitter-java.wasm',
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

// ─── Kotlin ─────────────────────────────────────────────────────────────────

const kotlin = defineLanguage({
    id: 'kotlin',
    displayName: 'Kotlin',
    extensions: ['.kt', '.kts'],
    grammar: 'tree-sitter-kotlin.wasm',
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

// ─── Go ─────────────────────────────────────────────────────────────────────

const go = defineLanguage({
    id: 'go',
    displayName: 'Go',
    extensions: ['.go'],
    grammar: 'tree-sitter-go.wasm',
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

// ─── Rust ───────────────────────────────────────────────────────────────────

/** `a::{b, c::{d, e}}` → [`a::b`, `a::c::d`, `a::c::e`]. Drops `as` aliases and `::*`. */
export function expandRustUse(text: string): string[] {
    const clean = text.replace(/\s+as\s+\w+/g, '').replace(/\s+/g, '');
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

const rust = defineLanguage({
    id: 'rust',
    displayName: 'Rust',
    extensions: ['.rs'],
    grammar: 'tree-sitter-rust.wasm',
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

// ─── C# ─────────────────────────────────────────────────────────────────────

const csharp = defineLanguage({
    id: 'csharp',
    displayName: 'C#',
    extensions: ['.cs'],
    grammar: 'tree-sitter-c_sharp.wasm',
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

// ─── PHP ────────────────────────────────────────────────────────────────────

const php = defineLanguage({
    id: 'php',
    displayName: 'PHP',
    extensions: ['.php'],
    grammar: 'tree-sitter-php.wasm',
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

// ─── registry ───────────────────────────────────────────────────────────────

export const LANGUAGE_PACKS: LanguagePack[] = [typescript, javascript, python, java, kotlin, go, rust, csharp, php];

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
