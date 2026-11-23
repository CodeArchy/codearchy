/**
 * @codearchy/lang-ruby — the Ruby language pack (tree-sitter query + rules).
 * See docs/guides/adding-a-language.md.
 *
 * Imports are `require`, `require_relative` and `load` calls with a string
 * literal. `require_relative` paths resolve from the file's directory; bare
 * `require` paths are looked up on a conventional load path (`lib/`, then the
 * directory itself) in each enclosing directory, nearest first, so gems in a
 * monorepo resolve to their own `lib/`. Anything not found (stdlib, gems) is
 * external. Rails/Zeitwerk autoloading (constants without a require) is not
 * resolved yet.
 */
import { defineLanguage, type DefContext, type ResolveContext, type SyntaxNode } from '@codearchy/sdk';

/** Section keywords that change the visibility of the methods after them. */
const VISIBILITY = new Set(['private', 'protected', 'public']);

/**
 * Visibility of a method from the nearest `private` / `protected` / `public`
 * line above it in the same class body, or a `private def ...` wrapper.
 */
function isPublicMethod(def: SyntaxNode): boolean {
    const wrapper = def.parent?.parent;
    if (def.parent?.type === 'argument_list' && wrapper?.type === 'call') {
        const m = wrapper.childForFieldName('method')?.text;
        if (m === 'private' || m === 'protected') return false;
    }
    for (let s = def.previousNamedSibling; s; s = s.previousNamedSibling) {
        if (s.type === 'identifier' && VISIBILITY.has(s.text)) return s.text === 'public';
    }
    return true;
}

function isExported({ node, kind }: DefContext): boolean {
    // Classes, modules, constants and top-level defs are reachable from
    // anywhere once loaded. (A `def` inside a class or module arrives as 'method'.)
    if (kind !== 'method') return true;
    if (node.type === 'singleton_method') return true;
    return isPublicMethod(node);
}

function withExtension(spec: string): string {
    return /\.rb$/.test(spec) ? spec : `${spec}.rb`;
}

function resolveImport(source: string, ctx: ResolveContext): string[] {
    const spec = withExtension(source);
    if (source.startsWith('./') || source.startsWith('../')) {
        const target = ctx.join(ctx.dirname(ctx.fromFile), spec);
        return target && ctx.exists(target) ? [target] : [];
    }
    for (let dir = ctx.dirname(ctx.fromFile); ; dir = ctx.dirname(dir)) {
        for (const candidate of [ctx.join(dir, 'lib', spec), ctx.join(dir, spec)]) {
            if (candidate && ctx.exists(candidate)) return [candidate];
        }
        if (dir === '') return [];
    }
}

const pack = defineLanguage({
    id: 'ruby',
    displayName: 'Ruby',
    extensions: ['.rb', '.rake', '.gemspec'],
    grammar: 'tree-sitter-ruby.wasm',
    sample: 'class A\n  def f; end\nend\n',
    query: `
(module name: (_) @name) @def.module
(class name: (_) @name) @def.class
(method name: (_) @name) @def.function
(singleton_method name: (_) @name) @def.function
(assignment left: (constant) @name) @def.variable
(call
  method: (identifier) @_fn
  arguments: (argument_list . (string (string_content) @import.source))
  (#match? @_fn "^(require|require_relative|load)$")) @import.stmt
`,
    containerKinds: ['class', 'module'],
    isExported,
    importDetails: () => ({ specifiers: [], isDefault: false, isNamespace: true }),
    expandImport(source, stmt) {
        // require_relative 'models/user' is relative even without a leading "./".
        const fn = stmt?.childForFieldName('method')?.text;
        if (fn === 'require_relative' && !source.startsWith('.')) return [`./${source}`];
        return [source];
    },
    resolveImport,
    referenceNodeTypes: ['constant'],
});

export default pack;
