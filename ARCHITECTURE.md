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
    providers:   AI model adapters (Ollama, OpenAI-compatible, Anthropic, Gemini); no engine
    ai:          summary cards (and later chat) over the hierarchy; core + protocol + providers
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
| `file` | Path, language, content hash, size, mtime, namespace, and the file's flow facts (entrypoints and call sites, as compact JSON) |
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

## AI providers

[`packages/providers`](packages/providers) puts every model behind one
streaming interface: a chat request goes in, and `text`, `tool_call`, `usage`
and a final `done` (or `error`) event come out. It knows nothing about the
engine, so any host can use it, and it compiles without DOM or Node types: the
adapters reach the network only through `fetch` (or the vendor's own SDK, which
is built on it), so the same code runs in Node, VS Code, browsers and workers.

- **Adapters:** Ollama (native API), any OpenAI-compatible endpoint (with
  presets for OpenAI, OpenRouter, Groq, Mistral and LM Studio), Anthropic
  (through the official SDK) and Gemini.
- **Models are discovered at runtime** (`listModels()`), including context
  windows and tool support where the provider reports them. Nothing is
  hard-coded, and an unknown value stays unknown rather than guessed.
- **One error taxonomy:** `auth`, `quota`, `rate_limit` (with Retry-After),
  `context_overflow`, `unavailable`, `bad_request`, `invalid_response`,
  `cancelled`. Credentials are redacted from every message.
- **Replay data.** Each finished turn carries the provider's own record of it,
  which goes back unchanged on the next request to that provider. Tool use on
  current Claude and Gemini models depends on this (thinking blocks, thought
  signatures).
- **`withResilience`** adds per-provider concurrency and rate limits, plus
  retries with backoff and jitter. It only retries a stream that failed before
  producing anything, so a caller never sees output twice.

Every request from the rest of CodeArchy goes through the **`ProviderRegistry`**:

- **Roles.** `summarizer`, `architect`, `chat` and `embedder` are each assigned
  a provider and model in settings, or picked automatically. The summarizer
  prefers a model on this machine; otherwise the user's provider order and
  chosen models win. `resolve()` returns the reason, so the UI can show why a
  model was picked.
- **Privacy tiers.** `local-only` (nothing leaves the machine), `structure`
  (names, paths, signatures, docs, edges and metrics may go to a remote model,
  but code bodies may not) and `excerpts` (capped code excerpts too). A
  provider counts as local only when it's a local kind *and* its URL is a
  loopback address. Under `local-only`, remote providers are never contacted,
  not even to check their status. Each request declares what it carries, and
  anything undeclared is treated as code.
- **Secret redaction.** Before anything goes to a remote model, the registry
  redacts known token formats, private keys, JWTs, credentials in connection
  strings, and random-looking values assigned to secret-sounding names. All
  the patterns use bounded repetition, so scanning stays linear.
- **Budgets.** Daily and monthly token caps per provider, counted in UTC.
  Estimates are in tokens, and in cost only when the user supplies prices:
  prices are never built in.
- **Ask before sending** (optional). The host is shown exactly what will be
  sent, already redacted. Without a way to ask, the registry refuses to send.
- **Audit log.** One entry per request, whether sent, blocked, failed or
  cancelled: provider, model, role, tier, tokens, redaction counts and the
  graph node ids involved. It never holds prompt text or credentials.

API keys live in a host `SecretStore` (VS Code's SecretStorage, or a store on
the web app's origin), never in settings.

`scripts/live.mjs` runs a tool-calling round trip against real providers
configured through environment variables. It's for manual checks and never
runs in CI.

## Summary cards

[`packages/ai`](packages/ai) writes a short card for every module, component,
package and the system: a title, its purpose, its responsibilities, the
children that matter most, any risks, and a confidence. It works bottom-up.
A module's card comes from that file's facts; a container's card comes from
its children's cards plus the dependencies between them. So every prompt is
bounded by fan-out, never by the size of the repository.

- **Facts, never bodies.** A module's facts are its path, role, header doc,
  declared symbols (each with its declaration line as the signature, and the
  doc comment above it), its strongest dependencies either way, and flags
  (test file, cycle, hub, covered by tests). A container's facts are its
  children's cards, the dependencies between them, its outside dependencies,
  and a README paragraph or manifest description. These all count as
  `structure` under the privacy tiers.
- **Deterministic first.** Every node also gets a card built without AI, from
  docs, names and structure. AI upgrades it and never blocks on it. When no
  model is allowed, a request is blocked (budget or tier), or the reply is
  unusable after one repair attempt, the node keeps its deterministic card.
  The card always says which kind it is.
- **Citation guard.** Children and symbols are shown to the model as short
  refs (`S1`, `C2`). Only refs or exact names of parts it was shown map back
  to node keys. Anything else is dropped, and the card's confidence is
  capped. Refs inside the prose are turned back into names.
- **Cache.** A card's key is a hash of the prompt version, the model, and
  exactly the facts it was written from. Child cards are part of a parent's
  facts, so an edit re-summarizes only the path from the changed file up to the
  root. Fallback cards are never cached under an AI key, so they're retried
  later.
- **Crawls** summarize the nodes given (most important first), with a cap on
  AI calls. They stop calling the model when the registry blocks, and every
  node still gets a card. `estimate()` sizes a crawl before it starts.

`scripts/live.mjs` indexes a folder and prints its cards, using a model taken
from the environment.

## Grounded chat

`GroundedChat` (also in `packages/ai`) answers questions about the codebase
from the index, with citations.

- **Tools mode.** For models that can call tools, the chat gives it six:
  `search` (names, paths and card text), `get_node` (a card plus its children,
  or a file's symbols with their signatures and docs, and its strongest
  dependencies), `neighbors`, `explain_edge` (the file-level dependencies and
  import sites behind an edge), `read_code` and `show_in_map`. `show_in_map` is
  a canvas action: the UI turns it into a "Show me" button. Lookups stream as
  status lines, the loop stops after 8 rounds, and tool arguments are
  validated. A bad call goes back to the model as an error result.
- **Retrieval.** Every question starts from a search of it. Models without tool
  calling answer from the top hits and their cards (RAG). In tools mode, the top
  hits give the model somewhere to start. Search is BM25 over word tokens
  (camelCase, snake_case and paths split; stopwords removed; light stemming),
  plus card text when cards are available.
- **Code only where the tier allows it.** `read_code` is offered only when
  excerpts may reach the chat model: a model on this machine, or the
  `excerpts` tier. It reads only indexed files, at most 120 lines per call and
  600 per conversation. Once code has been read, later requests declare
  `excerpts`.
- **A cacheable prompt.** The system prompt holds only stable text: the rules,
  the system card and the top-level parts. The map selection and the question
  go in the user turn.
- **Checked citations.** Answers cite with `[Name](node:<key>)` and
  `[file.ts:42](file:<path>#L42)`. Before the answer is handed over, links the
  index doesn't know become plain text. Inline-code names that match exactly
  one file or symbol become links. Links with no scheme that point to an
  indexed file become `file:` links. The `done` event carries the checked
  answer, its citations, the canvas actions and the history to continue from.

`scripts/ask.mjs` indexes a folder and asks a question with a model taken from
the environment.

## Flows

A flow is what happens when a request, command or job enters the system. The
engine finds them in three steps, all deterministic and all in `core`
([`packages/core/src/flows`](packages/core/src/flows)).

1. **Entrypoints** (`entrypoints.ts`). A table of per-line rules for each
   language finds:
   - HTTP routes: Express, Koa, Hono, Fastify, NestJS, FastAPI, Flask, Django,
     Spring, ASP.NET, net/http, gin, echo, chi, Actix, Axum, Laravel, Symfony,
     Rails and Sinatra.
   - CLI commands: commander, yargs, click, typer, argparse, cobra, picocli,
     Laravel, Symfony and Thor. VS Code commands count here too.
   - Jobs and listeners: Celery, Sidekiq, BullMQ, Spring `@Scheduled` and the
     Kafka/Rabbit listeners, Nest events, Azure Functions and hosted services.
     MCP tools count here too.
   - UI routes, and `main`.

   File conventions add Next.js and SvelteKit routes. A rule either names the
   handler, binds the function it decorates, or marks an inline handler whose
   body ends at `endLine`. Comment lines and test files are skipped. Every
   pattern uses bounded repetition, and long lines are skipped, so a scan is
   linear in the file's size.
2. **Call sites** (`calls.ts`). One linear character pass records every
   `name(` outside strings and comments. Calls inside template interpolations
   are kept. Each call records the function it's in and how it was made: a bare
   call, on `this`/`self`, or on another object.
3. **The trace** (`trace.ts`, `FlowIndex`). From the handler, calls are matched
   to symbols. There are no types, so the rules are strict:
   - **Bare calls:** the same file, then the files it imports (the hierarchy's
     module edges), then a unique-enough name in the same package and language
     family.
   - **`this`/`self` calls:** the caller's own class.
   - **Other member calls:** methods in the same file, anything in imported
     files, or a method whose name is unique in the workspace.

   Builtins and common verbs are never matched by name alone. The trace is
   breadth-first, with limits on depth (6), fan-out (8) and size (60 steps).
   Helpers with many callers are shown but not followed (`crossCutting`). Steps
   are placed in swimlanes: the nearest component or package. Imports of
   database, HTTP, queue, cache and storage libraries mark the flow's sinks. A
   flow that took any name-only hop is marked `approximate`.

Entrypoints and calls are stored with each file's facts, so a warm start
doesn't re-scan anything. Both hosts answer `flows()` and `flow(id)` on the
`EngineClient`.

In the UI, **Flows** mode (`packages/ui/src/Flows.tsx`) lists the entrypoints
by kind. It draws the chosen trace as a swimlane sequence: steps in call order,
each under its caller, with an arrow wherever a call crosses lanes. The pure
part (grouping, row order) is `flowModel.ts`. Chat and the MCP server share one
tool, `find_flows`: without an id it lists entrypoints, and with one it returns
the trace. Hosts provide a `FlowSource`, which is core's `FlowIndex`.

## Tours

A tour is an ordered walk through the codebase
([`packages/protocol/src/tours.ts`](packages/protocol/src/tours.ts)). Each step
has:
- a target: a node, a flow, or both;
- the canvas view it wants;
- a short explanation;
- optional code ranges;
- an optional anchor hash.

- **Start Here** (`core/src/tours/startHere.ts`) is generated from the index,
  with no AI. It covers:
  1. the big picture;
  2. where things start (one flow, followed end to end);
  3. up to three core parts (the most connected domain, API or UI
     containers, never a part together with its own subfolder);
  4. the data layer;
  5. the integrations the flows reach;
  6. shared foundations;
  7. a good first change: a tested module with few dependents, outside any
     cycle.

  Steps with nothing to show are left out. The Inspector beside the player
  adds each part's summary card.
- **Authored tours** are `.codearchy/tours/<slug>.json`, so they can be
  committed and reviewed like code. Discovery lists them, and `parseTour`
  validates them: version, sizes, targets, and code ranges that must stay
  inside the workspace. A committed `start-here.json` replaces the generated
  tour.
- **Staleness.** `TourIndex.check` compares each step with the current
  index. A target node, flow or file that's gone is `missing`. A step whose
  anchor hash no longer matches is `changed`. The anchor covers the step's
  code ranges, or else its node's identity.

Hosts answer `tours()`, `tour(id)` and `anchorTour(tour)`. VS Code also
answers `saveTour(tour)`, which anchors the tour, validates it with
`serializeTour` and writes the file. VS Code keeps the tour list current as
files change. The browser engine notices tour edits in a watched folder.

In the UI, **Tours** mode (`packages/ui/src/Tours.tsx`) lists the tours. The
player docks over the canvas, and each step applies its view: the mode, the
lens, and a reveal of its node or flow. **Add to tour** (from the Inspector or
a flow) appends steps to a per-workspace draft. The draft is saved through
`saveTour`, or downloaded where the host can't write. Progress and the draft
are kept per viewer in local storage. `tourFromFlow` turns a traced flow into
a walk-through. The pure part is in `tourModel.ts`.

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
  Given an `AiClient` (the `ai` prop; the contract lives in `protocol`), the
  Map adds an **Ask** panel: streaming answers, a status line for each lookup,
  citations that show their node on the map or open the file, and "Show me"
  buttons. It also adds summary cards in the Inspector, marked as AI-written or
  auto-built, with "Summarize with AI"; an **AI settings** panel (privacy
  tier, ask before sending, providers with their status, API key fields
  that never display a stored key, model choice, roles with the reason for each
  automatic pick, daily budgets); and the **ask-before-sending** dialog.
  Answers are parsed from a small markdown subset into React elements, never
  as HTML, so model output can't inject markup. Only `node:` and `file:` links
  are followable.
- **The browser engine** (`@codearchy/platform-browser`) is what every
  browser host runs, so the web app and the playground index code the same way:
  - `./engine` — `runEngineWorker(config)` runs inside a module Web Worker. It
    opens a source (a picked folder, dropped files or folder, a `.zip`, or
    texts), indexes it into SQLite on OPFS (falling back to memory) with the
    parse-worker pool, and answers the `EngineClient` requests plus
    `readFile`. A picked folder can be watched: `FileSystemObserver` where the
    browser has it, adaptive polling otherwise; changes go through
    `Indexer.update`, and a `changed` event tells the UI to refresh in place.
    Hosts can add their own requests (`handlers`). A handler can also push its
    own events to the page (`ctx.emit`; the page listens with
    `WorkerEngine.onHostEvent`), for example to stream an answer.
  - `./client` — `WorkerEngine` (the UI-thread `EngineClient`) and helpers that
    turn a folder picker, an `<input webkitdirectory>` or a drag-and-drop into
    a source. It imports no engine code.
  - `./stores` — `IdbKeyValue` (IndexedDB) and `IdbSecretStore`, for a
    browser host's settings and API keys. Secrets are encrypted with AES-GCM
    under a non-extractable WebCrypto key kept in IndexedDB, so the raw key
    material can never be read out and stored data copied from disk is useless
    on its own. This doesn't protect against script running on the page itself,
    so the host's content security policy still matters. Without IndexedDB
    (some private modes), both stores fall back to memory and say so.
- **`apps/playground`** is a browser debug UI for the engine. Load the
  sample or open a local folder, then inspect stats, files, edges, unresolved
  imports and symbol search. It uses the same browser adapters as the web app,
  and it is the quickest way to see what the engine makes of a repository.
- **`apps/cli`** is the `codearchy` command line. `codearchy mcp` serves the
  map to the user's own AI agent over the Model Context Protocol (stdio, with
  the official TypeScript SDK). It offers `overview` plus the grounded-chat
  tools (`search`, `get_node`, `neighbors`, `explain_edge`, `find_flows` and,
  unless `--no-code` is passed, `read_code`), all read-only. The agent works under
  its own subscription, and CodeArchy makes no model calls. The workspace is
  indexed at start-up (`git ls-files` when available). A file watcher marks
  the index stale, and the next call rebuilds it. stdout carries the
  protocol and logs go to stderr. Setup per agent:
  [docs/guides/mcp.md](docs/guides/mcp.md).
  `codearchy serve` is the **Companion** (`src/companion.ts`). It serves the
  same engine to the web app over a WebSocket on `127.0.0.1`, using the
  protocol in `protocol/src/companion.ts`. The upgrade must carry an allowed
  Origin and a local Host. The first frame pairs with a one-time token from
  the printed link's fragment, or resumes with a session key. Requests come
  from a fixed read-only allow-list, and only indexed source and tour files
  can be read. Frames are size- and rate-limited, and file changes are pushed
  as `changed` events. The page side is `CompanionEngine` in
  `@codearchy/platform-browser/companion`, an `EngineClient` like the worker
  one. See [docs/guides/companion.md](docs/guides/companion.md).

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
| Flows | [`packages/core/src/flows/trace.ts`](packages/core/src/flows/trace.ts), and the types in [`packages/protocol/src/flows.ts`](packages/protocol/src/flows.ts) |
| The hierarchy and views | [`packages/core/src/hierarchy/build.ts`](packages/core/src/hierarchy/build.ts), [`project.ts`](packages/core/src/hierarchy/project.ts), and the types in [`packages/protocol/src/hierarchy.ts`](packages/protocol/src/hierarchy.ts) / [`view.ts`](packages/protocol/src/view.ts) |
| The UI | [`packages/ui/src/CodeArchyMap.tsx`](packages/ui/src/CodeArchyMap.tsx), and [`client.ts`](packages/ui/src/client.ts) for what a host provides |
| A full host wiring | [`apps/playground/src/engine.worker.ts`](apps/playground/src/engine.worker.ts) (browser), [`apps/vscode/src/pipeline/AnalysisPipeline.ts`](apps/vscode/src/pipeline/AnalysisPipeline.ts) (VS Code) |
