# Architecture

CodeArchy turns a codebase into an architecture map. It does that in three steps:

1. It finds the source files and parses each one with tree-sitter.
2. It resolves every import to the file it refers to.
3. It builds a dependency graph, which the UI groups into subsystems and lays out.

This document covers how the engine is put together, so you know where a change
belongs. For setup and commands see [CONTRIBUTING.md](CONTRIBUTING.md). For the
most common contribution see the
[adding-a-language guide](docs/guides/adding-a-language.md).

## One engine, several hosts

The engine (`@codearchy/core`) is plain TypeScript, and it compiles with no DOM
and no Node types. Everything that depends on the host comes in through a small
set of **ports**. Each platform package implements those ports, and each app
wires one platform into the engine.

```
                 ┌────────────────────────┐
                 │ protocol    sdk        │  data model · extension API (defineLanguage)
                 └───────────┬────────────┘
                 ┌───────────┴────────────┐
                 │ languages/*  (lang-*)  │  one package per language, sdk only
                 └───────────┬────────────┘
                 ┌───────────┴────────────┐
                 │ core                   │  extraction · index · resolution · graph
                 └───────────┬────────────┘
                 ┌───────────┴────────────┐
                 │ treesitter   grammars  │  parser runtime adapter · pinned .wasm grammars
                 └─────┬──────────────┬───┘
          ┌────────────┴───┐    ┌─────┴────────────┐
          │ platform-node  │    │ platform-browser │  ports implemented per host
          └────────┬───────┘    └────────┬─────────┘
          ┌────────┴───────┐    ┌────────┴─────────┐
          │ apps/vscode    │    │ apps/playground  │  composition roots
          └────────────────┘    └──────────────────┘

    conformance: one test suite every platform must pass (golden graph included)
    ui:          the shared React UI (Map, Navigator, Inspector); protocol only
```

`pnpm lint` runs [`tooling/check-boundaries.mjs`](tooling/check-boundaries.mjs), which rejects any
dependency that points the wrong way. A language pack can't import the core,
the core can't import a platform, and the UI can't import the engine at all: it
gets its data through an `EngineClient` that each app implements over its own
transport.

### Ports

| Port | What it abstracts | Node | Browser |
|---|---|---|---|
| `FileSystemPort` | Read text, stat (size and mtime) by workspace path | `NodeFileSystem` | `HandleFileSystem` (File System Access, OPFS), `MemoryFileSystem` |
| `ParserRuntime` | Load a grammar, compile a query, parse | web-tree-sitter, grammars read from disk | web-tree-sitter, grammars fetched |
| `StoragePort` | A small synchronous SQL surface | `node:sqlite` | SQLite WASM on OPFS (`opfs-sahpool`), or in memory |
| `AnalyzeExecutor` | Run parse jobs, in parallel where possible | `NodeWorkerPool` (worker_threads) | `BrowserWorkerPool` (Web Workers) |

**Paths.** The core only ever sees workspace-relative POSIX paths, such as
`web/src/index.ts`. Hosts convert to and from OS paths at the edge. Paths that
are absolute, contain backslashes or try to climb out of the workspace are
rejected by every file system adapter.

## The pipeline

```
discover ─▶ index ─▶ resolve ─▶ graph ─▶ hierarchy ─▶ infer ─▶ UI
```

1. **Discover.** The host lists files: `git ls-files` (which honours
   `.gitignore`), a directory walk, or a picked folder. `classifyFiles` then
   applies the language filter and exclude globs, and separates source files
   from manifests such as `package.json`, `tsconfig.json`, `go.mod`,
   `Cargo.toml` and `composer.json`.

2. **Index.** `Indexer` keeps per-file facts in the index store (below) and
   decides, for each file:
   - stat unchanged (size and mtime) → reuse its facts without reading it;
   - otherwise hash the content; hash unchanged → reuse;
   - otherwise parse.

   Parsing runs on the executor in chunks, spread across workers. A warm
   restart re-reads nothing. A branch switch re-parses only the files whose
   content actually changed.

3. **Extract.** The `Analyzer` runs each language pack's single tree-sitter
   query over a file. It turns the captures into `FileAnalysis`: symbols (kind,
   container, exported, lines), imports, the declared namespace and, for some
   languages, referenced names. If a grammar isn't available, a much weaker
   regex extractor is used as a fallback.

4. **Resolve.** `ImportResolver` maps each import to workspace files, using
   prebuilt indexes so the cost scales with the number of imports. Built-in
   rules cover JS/TS (relative paths, `tsconfig` paths, workspace packages),
   Python, Java/Kotlin, C#, PHP (PSR-4), Go modules and Rust crates.

   Other languages resolve through their pack's `resolveImport` hook. Some
   imports refer to a whole package rather than one file, such as Java
   wildcards, C# `using` directives and Go packages. Those are narrowed to the
   files whose top-level names the importing file actually references.

5. **Graph.** `buildGraph` turns analyses into nodes (files) and weighted
   edges. The output is deterministic: the same inputs give the same graph on
   every platform and in any order.

6. **Hierarchy.** `buildHierarchy` arranges the graph into
   System › Package › Component › Module › Symbol, the tree that drill-down
   views navigate:
   - **Packages** are directories holding a package marker (`package.json`,
     `go.mod`, `Cargo.toml`, `pom.xml`, `*.csproj`, ...). When there are many,
     they're grouped by their parent folder (`packages/`, `apps/`, ...).
   - **Components** are directory subtrees, shaped so each level has a
     readable number of children. Single-child folder chains are compressed
     (`src/main/java/com/acme` is one node), folders with one file are folded
     into their parent, and a container with more than 20 children is split
     into *virtual* components by community detection on its dependencies
     (a deterministic Louvain/Leiden-style method), or alphabetically when
     there are no dependencies to go on.
   - **Roles** (`api`, `ui`, `domain`, `data`, `infra`, `config`, `test`,
     `util`) come from whole words in folder and file names, each with a
     confidence and a reason.
   - **Keys are stable**, derived from paths (`dir:src/auth`, `mod:src/auth/login.ts`),
     so anything keyed to a node survives a re-index. Nodes are stored in
     depth-first order with Euler-tour intervals, so "is A inside B" is two
     comparisons and a subtree is a contiguous range.

   **Views** are projections of the hierarchy (`HierarchyIndex.project`). A
   view shows the children of a *scope* node, some of them expanded in place.
   Every module dependency is mapped onto the visible nodes that contain its
   ends (a binary search over Euler intervals), aggregated with its weight,
   and dependencies that leave the scope become *port stubs* attributed to the
   outside node at the scope's level. `explainEdge` lists the module
   dependencies and import sites behind any visible edge, and a budget caps how
   many nodes expansions may add. Projecting a scope takes well under a
   millisecond on repositories of a few thousand files.

   **Metrics** (`computeMetrics`) feed the lenses and the Inspector. For each
   file they record whether it's a test, sits in a dependency cycle (strongly
   connected components), is an orphan (no dependencies either way) or a hub
   (very highly connected), and whether any test file depends on it. Every
   container sums its files and records the dependency weight crossing its
   boundary. Views also mark the edges that form cycles among the visible
   nodes.

7. **Infer.** Heuristics group files into subsystems (API, services, models,
   storage, and so on). AI providers, where enabled, refine this from the
   graph: they receive structure, not raw source files.

### The index store

`IndexStore` is plain SQL over `StoragePort`, identical on Node and in the
browser. It holds:

| Table | Holds |
|---|---|
| `file` | Path, language, content hash, size, mtime, namespace |
| `symbol` | Symbols |
| `import` | Imports |
| `manifest` | Manifests |
| `symbol_fts` | External-content FTS5 index for prefix symbol search, with a `LIKE` fallback where FTS5 is missing |

Every stored fact records a `FACTS_VERSION`: a hash of the extractor revision
and every language pack's query. Changing a query therefore invalidates exactly
the facts it could change, and the next index run re-parses those files.

Where the index lives depends on the host:
- VS Code: a database in the workspace's extension storage.
- Browser: OPFS, through SQLite's SAH-pool VFS. This needs no cross-origin
  isolation (COOP/COEP) and works in Chromium, Firefox and WebKit.

## Language packs

A language is a package under [`packages/languages/`](packages/languages). It calls
`defineLanguage` from `@codearchy/sdk` with:
- file extensions;
- a grammar file;
- one query, using a fixed capture vocabulary (`@def.<kind>`, `@name`,
  `@import.source`, ...);
- a sample snippet;
- a handful of optional hooks for language rules: visibility, import forms,
  containers and import resolution.

Packs see only structural syntax-tree types, never a host or a parser
implementation.

Grammars are prebuilt `.wasm` files from npm, pinned by version and integrity
hash in [`packages/grammars/grammars.json`](packages/grammars/grammars.json). No
native code is compiled at install time. `pnpm new:language` scaffolds a pack
end to end. See the [guide](docs/guides/adding-a-language.md).

## Conformance

[`packages/conformance`](packages/conformance) is a framework-agnostic suite that
runs against the ports. It covers:
- file reads and path rules;
- SQL semantics, including transactions and the FTS5 flag;
- every grammar with its pack's sample;
- a full index of [`fixtures/polyglot`](fixtures/polyglot).

That index must reproduce a committed **golden graph** exactly, both cold and
warm and both in-process and on the worker pool. Node runs the suite under
Vitest; Chromium, Firefox and WebKit run it under Playwright. A change that
alters extraction or resolution therefore shows up as a golden-graph diff,
which is the behaviour change to review.

## Apps

- **`apps/vscode`** is the VS Code extension. The extension host runs
  discovery, the index (on parse workers) and incremental updates from
  file-system events. It also runs the AI provider calls. A React webview
  renders the diagrams and the chat. The extension is bundled with esbuild,
  and grammars and runtimes ship as files inside the VSIX.
- **`packages/ui`** (`@codearchy/ui`) is the shared React UI, used by every
  app. `<CodeArchyMap>` renders views: the Map canvas (React Flow, with ELK
  laying out each view in a Web Worker and layouts cached by frontier hash),
  the Navigator tree, the Inspector (what a node contains, depends on and is
  used by; the imports behind an edge), the breadcrumb, ⌘K search and keyboard
  navigation. Dense views draw their heaviest dependencies, plus everything
  around the selection. The same view can be shown as a **Matrix**: a
  dependency structure matrix ordered with providers first, so ordinary
  dependencies sit below the diagonal and anything above it is feedback in a
  cycle. **Lenses** (Dependencies, Health, Tests) colour nodes using validated,
  colour-blind-safe ramps and status colours, and always state the value as
  text as well. Theme tokens follow VS Code's theme when hosted there,
  and light or dark on the web.
- **The browser engine** (`@codearchy/platform-browser`) is what every
  browser host runs, so the web app and the playground index code the same way:
  - `./engine` — `runEngineWorker(config)` runs inside a module Web Worker. It
    opens a source (a picked folder, dropped files or folder, a `.zip`, or
    texts), indexes it into SQLite on OPFS (falling back to memory) with the
    parse-worker pool, and answers the `EngineClient` requests plus
    `readFile`. A picked folder can be watched: `FileSystemObserver` where the
    browser has it, adaptive polling otherwise; changes go through
    `Indexer.update`, and a `changed` event tells the UI to refresh in place.
    Hosts can add their own requests (`handlers`).
  - `./client` — `WorkerEngine` (the UI-thread `EngineClient`) and helpers that
    turn a folder picker, an `<input webkitdirectory>` or a drag-and-drop into
    a source. It imports no engine code.
- **`apps/playground`** is a browser debug UI for the engine. Load the
  sample or open a local folder, then inspect stats, files, edges, unresolved
  imports and symbol search. It uses the same browser adapters as the web app,
  and it is the quickest way to see what the engine makes of a repository.

## Design rules

- **The core stays host-free.** No DOM or Node types in `core`, `sdk` or the
  language packs. Anything host-specific is a port.
- **Deterministic output.** No result may depend on timing or iteration
  order: manifests are read in path order, and ties are broken by path.
- **Repository content is untrusted.** Paths, names and specifiers are
  rendered as text, never as HTML. Queries and resolvers must not have
  backtracking blow-ups on hostile input.
- **Pinned, verified inputs.** Grammars, runtimes and models are pinned and
  integrity-checked. Nothing runs package install scripts.
- **Offline by default.** Analysis never needs the network. Downloads happen
  at build or setup time and are verified.

## Where to start reading

| To understand… | Read |
|---|---|
| The data model | [`packages/protocol/src`](packages/protocol/src) |
| How a language is described | [`packages/sdk/src/language.ts`](packages/sdk/src/language.ts), then any pack in [`packages/languages`](packages/languages) |
| Extraction | [`packages/core/src/extract/treeSitter.ts`](packages/core/src/extract/treeSitter.ts) |
| Incremental indexing | [`packages/core/src/index/indexer.ts`](packages/core/src/index/indexer.ts) and [`store.ts`](packages/core/src/index/store.ts) |
| Import resolution | [`packages/core/src/resolve/resolver.ts`](packages/core/src/resolve/resolver.ts) |
| The hierarchy and views | [`packages/core/src/hierarchy/build.ts`](packages/core/src/hierarchy/build.ts), [`project.ts`](packages/core/src/hierarchy/project.ts), and the types in [`packages/protocol/src/hierarchy.ts`](packages/protocol/src/hierarchy.ts) / [`view.ts`](packages/protocol/src/view.ts) |
| The UI | [`packages/ui/src/CodeArchyMap.tsx`](packages/ui/src/CodeArchyMap.tsx), and [`client.ts`](packages/ui/src/client.ts) for what a host provides |
| A full host wiring | [`apps/playground/src/engine.worker.ts`](apps/playground/src/engine.worker.ts) (browser), [`apps/vscode/src/pipeline/AnalysisPipeline.ts`](apps/vscode/src/pipeline/AnalysisPipeline.ts) (VS Code) |
