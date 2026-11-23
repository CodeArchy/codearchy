# Adding a language

A language in CodeArchy is one small package, `packages/languages/<id>`
(`@codearchy/lang-<id>`). It tells the engine three things:

- which files belong to the language;
- how to find definitions and imports in them, using one [tree-sitter](https://tree-sitter.github.io/) query;
- a few language rules: what counts as exported, and how imports map to files.

A pack depends only on `@codearchy/sdk`. It never touches the file system, the
parser runtime or the editor, so the same pack runs in VS Code, in Node and in
the browser.

This guide walks through Ruby, which was added this way. Its pack is
[`packages/languages/ruby/src/index.ts`](../../packages/languages/ruby/src/index.ts),
and it is worth reading alongside the guide.

## 1. Scaffold

Find the grammar on npm. Most are published as `tree-sitter-<lang>` and ship a
prebuilt `.wasm`. Then run:

```bash
pnpm new:language ruby --name Ruby --ext .rb,.rake,.gemspec \
    --grammar tree-sitter-ruby --version 0.23.1
```

The script first checks that the grammar version ships the `.wasm`, and that its
licence is permissive (MIT, Apache-2.0, BSD or ISC). It then:

- creates `packages/languages/ruby/` with a pack skeleton;
- pins the grammar, with its npm integrity hash, in
  [`packages/grammars/grammars.json`](../../packages/grammars/grammars.json);
- registers the pack in
  [`packages/core/src/languages/index.ts`](../../packages/core/src/languages/index.ts)
  and adds it to the core's dependencies;
- adds the language to the extension's `codearchy.includedLanguages` setting;
- creates `packages/platform-node/test/languages/ruby.test.ts`;
- runs `pnpm install` and fetches the grammar.

Use `--dry-run` to see which files it would touch. If the package ships its
`.wasm` under another name, pass `--wasm <file>`. If it ships no `.wasm` at all,
pick another version or ask in an issue: CodeArchy never builds grammars from
source.

## 2. Look at the syntax tree

Write a few lines of real code in the language, then look at the tree the
grammar produces for it. You can use either of these:

- the [tree-sitter playground](https://tree-sitter.github.io/tree-sitter/7-playground.html);
- the grammar package's `src/node-types.json`, which lists every node type and field.

For Ruby, `class Invoice < Base` parses as
`(class name: (constant) superclass: (superclass (constant)) body: ...)`.

## 3. Write the query

The pack has one query. Its captures follow a fixed vocabulary:

| Capture | Meaning |
|---|---|
| `@def.<kind>` | A whole definition node. `<kind>` is one of `function`, `class`, `interface`, `type`, `enum`, `variable`, `method`, `module`, `impl` |
| `@name` | The definition's name, captured in the same pattern |
| `@import.source` | A module specifier. Surrounding quotes are stripped |
| `@import.stmt` | The import statement node, passed to the import hooks |
| `@import.mod` | A Rust-style `mod foo;` file import |
| `@export.name` | A name exported by a separate clause (`export { a }`) |
| `@namespace` | The package or namespace the file declares |
| `@_anything` | A helper capture for predicates such as `#eq?` or `#match?`. It is ignored |

Ruby's query:

```scheme
(module name: (_) @name) @def.module
(class name: (_) @name) @def.class
(method name: (_) @name) @def.function
(singleton_method name: (_) @name) @def.function
(assignment left: (constant) @name) @def.variable
(call
  method: (identifier) @_fn
  arguments: (argument_list . (string (string_content) @import.source))
  (#match? @_fn "^(require|require_relative|load)$")) @import.stmt
```

The engine turns those captures into symbols:

- **Nesting comes from the tree.** A definition inside a container (by default
  `class`, `interface`, `enum`, `impl`; set `containerKinds` to change that)
  gets that container. A `@def.function` inside a container becomes a
  **method**, which is why Ruby captures `def` as a function.
- **Locals and fields are dropped.** A definition nested in a function, and a
  variable nested in a class, is left out of the architecture. A nested
  `module` is kept only when `module` is one of the pack's `containerKinds`,
  as in Ruby.

## 4. Language rules (hooks)

All hooks are optional except `isExported` and `sample`:

| Hook | Purpose | Example |
|---|---|---|
| `sample` | A few lines the query must match. The conformance suite parses it on every platform | `'class A\n  def f; end\nend\n'` |
| `isExported(def)` | Visibility. `def` has `node`, `name`, `kind` and `topLevel` | Go: capitalised names. Ruby: everything except methods under `private` / `protected` |
| `containerKinds` | Which definition kinds own members | Ruby: `['class', 'module']` |
| `importDetails(stmt)` | Imported names, default import or namespace import | Python `from x import a, b` |
| `importsFromStatement(stmt)` | Specifiers when the query can't capture one `@import.source` | C# `using` directives |
| `expandImport(source, stmt)` | Rewrites a specifier into one or more | Rust `use a::{b, c}`; Ruby makes `require_relative 'x'` into `./x` |
| `containerName(def)` | The container for methods declared outside it | Go receivers |
| `referenceNodeTypes` | Leaf node types collected as references, used to narrow package-level imports | Ruby: `['constant']` |
| `resolveImport(source, ctx)` | Maps a specifier to workspace files (see below) | Ruby `require` / `require_relative` |

Shared helpers live in `@codearchy/sdk`:

- `hasAncestorOfType(node, type, depth)`
- `modifierText(node, types)`

## 5. Resolve imports

The core has built-in resolvers for the ecosystems it already knows: JS/TS,
Python, JVM, C#, PHP, Go and Rust. A new language resolves its own imports with
`resolveImport`, and that keeps everything about the language in one package.
The hook receives the importing file and a small context:

```ts
resolveImport(source, ctx) {
    // ctx.fromFile: "lib/billing.rb"   ctx.exists(path)   ctx.join(...parts)   ctx.dirname(path)
    const target = ctx.join(ctx.dirname(ctx.fromFile), `${source}.rb`);
    return target && ctx.exists(target) ? [target] : [];
}
```

Paths are workspace-relative and POSIX (`app/models/user.rb`) on every
platform. Return `[]` for anything outside the workspace, such as the standard
library or a package from a registry: those imports show up as external.

## 6. Test

- **Extraction tests.** Fill in `packages/platform-node/test/languages/<id>.test.ts`
  with real-world syntax: nesting, visibility, every import form, and the forms
  that must *not* be imports. Expected symbols use a compact notation,
  `kind Container.name`, with a `*` suffix when the symbol is exported. Run them
  with `pnpm --filter @codearchy/platform-node test:unit`.
- **Resolution.** Add a few files under `fixtures/polyglot/<lang>/` that import
  one another, and assert the edges in
  [`graph.test.ts`](../../packages/platform-node/test/graph.test.ts). Then
  regenerate the golden graph that every platform must reproduce, and review
  its diff:

  ```bash
  pnpm --filter @codearchy/platform-node run golden
  ```

- **Everything.** Run `pnpm build && pnpm test`, plus `pnpm test:browser`
  if you have Playwright's browsers installed.

## 7. Try it on a real project

Run `pnpm playground` and open http://127.0.0.1:5178/, then use
**Open folder…** to index a real repository in your browser. The page shows:

- **Unresolved** lists every import that matched no file. This is the fastest
  way to spot resolver gaps.
- **Search** and the file pane show what each file defines and what each import
  resolved to.

For timings and coverage on larger repositories, run
`pnpm --filter codearchy run bench -- <repo>`. Include the numbers for one or
two real projects in your pull request.

## Checklist

- [ ] Grammar pinned by `pnpm new:language`, with a permissive licence
- [ ] Query, `sample` and `isExported` written; other hooks only where needed
- [ ] Extraction tests cover nesting, visibility and every import form
- [ ] Fixture files, edge assertions and a regenerated golden graph
- [ ] `pnpm lint`, `pnpm build`, `pnpm test` pass
- [ ] README's language list updated
