# Contributing to CodeArchy

Thank you for your interest in contributing to CodeArchy! This document provides everything you need to set up your environment, understand the codebase, and submit changes.

---

## Development Setup

### Prerequisites

- **Node.js 22.18+** (pnpm comes with it via Corepack)
- **VS Code 1.85+**
- **Git**
- **AI is optional.** Nothing you build or test needs a model. To work on AI features, use any provider CodeArchy
  supports: a local one (Ollama, LM Studio) or an API key (Anthropic, OpenAI, Gemini, OpenRouter, Groq, Mistral).
  Unit tests use fakes, never a real provider.

### Getting Started

```bash
# Clone the repository
git clone https://github.com/CodeArchy/codearchy.git
cd codearchy

# Enable pnpm (ships with Node via Corepack; the version is pinned in package.json)
corepack enable

# Install the whole workspace
pnpm install

# Build and test everything (Turborepo runs the packages in dependency order)
pnpm build
pnpm test

# Launch the extension in development mode
# Press F5 in VS Code (uses .vscode/launch.json → apps/vscode)
```

The repository is a pnpm workspace: the engine and its adapters are packages under `packages/`,
and the VS Code extension and the browser playground are apps under `apps/`.
[ARCHITECTURE.md](ARCHITECTURE.md) explains how they fit together. Run one package's scripts with
`pnpm --filter <name> run <script>`, for example `pnpm --filter codearchy run watch` (the extension)
or `pnpm --filter @codearchy/platform-node test:unit`.

To see what the engine makes of a repository, run `pnpm playground` and open
http://127.0.0.1:5178/. You can index the sample or any local folder in your browser.

The `pnpm --filter codearchy run watch` task (bound to the default VS Code build task) compiles both layers incrementally on file save.

### Project Structure

```
codearchy/                         pnpm workspace (package.json, pnpm-workspace.yaml, turbo.json)
├── packages/
│   ├── protocol/   @codearchy/protocol      data model shared by engine, hosts and UI (types only)
│   ├── sdk/        @codearchy/sdk           public extension API: defineLanguage, syntax-tree types
│   ├── languages/  @codearchy/lang-<id>     one package per language: grammar, query, rules
│   ├── core/       @codearchy/core          the engine: extraction, index store, import
│   │                                        resolution, graph, inference. Pure TS behind ports
│   ├── treesitter/ @codearchy/treesitter    ParserRuntime adapter: web-tree-sitter from wasm bytes
│   ├── grammars/   @codearchy/grammars      pinned, integrity-checked grammar .wasm files
│   ├── platform-node/ @codearchy/platform-node  Node adapters: file system, git discovery, parser,
│   │                                        node:sqlite index store, worker_threads parse pool
│   ├── platform-browser/ @codearchy/platform-browser  browser adapters: File System Access / OPFS,
│   │                                        SQLite WASM on OPFS, fetched grammars, Web Worker pool
│   ├── conformance/ @codearchy/conformance  shared adapter test suite + golden polyglot graph
│   ├── providers/  @codearchy/providers     AI model adapters behind one streaming interface (no engine)
│   ├── ai/         @codearchy/ai            summary cards, grounded chat, search over the hierarchy
│   └── ui/         @codearchy/ui            shared React UI: Map, Architecture, Matrix, Flows, Tours
├── apps/
│   ├── vscode/     the extension (composition root): bundled to dist/extension.js with esbuild
│   │   ├── src/            extension host: commands, file watcher, pipeline, webview panel, voice
│   │   └── webview-ui/     React webview
│   ├── cli/        the `codearchy` npm package: `mcp` (MCP server), `serve` (Companion), `authorship`
│   └── playground/ browser debug UI for the engine (pnpm playground)
├── docs/guides/    contributor guides (adding a language, ...)
├── fixtures/       small multi-language repos used by tests (polyglot/)
├── tooling/        dependency-boundary check, `pnpm new:language` scaffold
└── media/          repository docs assets
```

#### Dependency rules (enforced in CI)

```
protocol, sdk ← lang-* ← core ← treesitter ← platform-node | platform-browser ← apps/*
                                ↖ conformance (tests every platform against the same cases)
protocol ← ui ← apps/*          (the UI never imports the engine; apps give it an EngineClient)
protocol ← providers ← ai ← apps/*   (providers never import the engine)
```

- `core`, `sdk` and the language packs compile with **no DOM and no Node types**: they can't touch the host, even by accident.
  A language pack depends on `@codearchy/sdk` only.
  Everything host-specific comes in through ports (`FileSystemPort`, `ParserRuntime`).
- The core speaks **workspace-relative POSIX paths** (`web/src/index.ts`); hosts convert at the edge.
- `pnpm lint` runs `tooling/check-boundaries.mjs`, which rejects dependencies that break the arrows above.

---

## Architecture

[ARCHITECTURE.md](ARCHITECTURE.md) is the full tour. In short:

```
Discovery         ← git ls-files (honours .gitignore), exclude globs
   ▼
Extraction        ← tree-sitter (wasm) + one query per language pack, in a worker pool
   ▼
Index             ← per-file facts in SQLite (node:sqlite, or SQLite wasm on OPFS in the browser); only changed files re-parse
   ▼
Resolution        ← per-ecosystem import rules → the dependency graph
   ▼
Hierarchy         ← system → packages → components → files → symbols, projected into bounded views
   ▼
Map · Architecture · Matrix · Flows · Tours · lenses (health, tests, ownership, AI authorship)
   ▲
AI (optional)     ← ProviderRegistry: roles, privacy tiers, redaction, budgets; any provider or none
```

### Key principles

1. **Local-first.** Parsing, the index, the Map, flows, tours, ownership and authorship run on the user's machine and
   need no network. AI is optional, and the user decides what may leave the machine (privacy tiers in `ProviderRegistry`).
2. **One engine, several hosts.** The same core runs in VS Code, the browser and the CLI. Host-specific code lives
   behind ports in `platform-node` / `platform-browser`. The UI talks to the engine only through `EngineClient`.
3. **Deterministic.** The same input gives the same graph, views and cards, and ties break by path.
4. **Repository content is untrusted.** Names and paths are rendered as text, never HTML. Queries must not blow up on hostile input.
5. **Pinned, verified downloads.** Grammars, runtimes and the voice model are pinned and integrity-checked.

---

## Code Standards

- Write strict TypeScript — no implicit `any`; use `unknown` with type guards where needed
- Follow existing naming conventions (camelCase for variables/functions, PascalCase for classes/types)
- Keep functions focused; avoid side-effects in pure data-transformation functions
- Webview components use React functional components with hooks — no class components
- AI is a progressive enhancement: every feature must work with no provider configured, and provider calls go through `ProviderRegistry` (never straight to a vendor)
- Voice is a progressive enhancement too: text must always work on its own

## Testing

```bash
pnpm test                                          # all unit tests (Vitest in packages, mocha/node --test in the extension)
pnpm --filter @codearchy/platform-node test:unit   # extraction + resolution against real grammars and fixtures
pnpm --filter @codearchy/core test:unit            # pure engine tests (globs, heuristics, paths, parsers)
pnpm --filter codearchy run test                   # VS Code sandbox: the bundled extension analyses fixtures/polyglot
pnpm test:browser                                  # conformance suite in Chromium, Firefox and WebKit (Playwright)
pnpm test:e2e                                      # playground smoke test in all three engines
pnpm --filter @codearchy/platform-node run golden  # regenerate the golden graph after an intended behaviour change
pnpm --filter codearchy run bench -- <repo>        # timings, parser coverage, import resolution per language
```

Browser tests need Playwright's browsers once: `pnpm --filter @codearchy/platform-browser exec playwright install chromium firefox webkit`.

In CI, a new push to a branch cancels that branch's running checks, so a cancelled job after a push is
expected. A `Sandbox (macos-latest)` job cancelled with no steps run waited too long for a macOS runner;
nothing in the change caused it. Rerun just the failed jobs from the run's page, or with
`gh run rerun <run-id> --failed`.

Bug in extraction or resolution? Add the smallest failing snippet to
`packages/platform-node/test/extraction.test.ts` (or `test/languages/<id>.test.ts`), or files to `fixtures/polyglot/` plus an
assertion in `packages/platform-node/test/graph.test.ts`, before fixing it.

## Adding or improving a language

Each language is one package under [`packages/languages/`](packages/languages). Start a new one with:

```bash
pnpm new:language <id> --name <Name> --ext .a,.b --grammar <npm package> --version <version>
```

That pins the grammar, wires the pack into the engine and the extension, and creates a test file.
Then follow [docs/guides/adding-a-language.md](docs/guides/adding-a-language.md), which covers the
query, the rules, import resolution and testing, with Ruby as the worked example.

Run `pnpm --filter codearchy run bench -- <repo>` on one or two real repositories in that language
and include the before/after numbers in your pull request.

---

## Submitting Changes

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes with clear, atomic commit messages, signed off for the
   [DCO](https://developercertificate.org/): `git commit -s`
4. Run `pnpm lint`, `pnpm typecheck` and `pnpm test` to verify nothing is broken
5. Open a Pull Request with a description covering: what changed, why, and how to test it

## Reporting Issues

Open an issue on GitHub with:

- Where you use CodeArchy (VS Code version, the web app and browser, or the CLI version) and the CodeArchy version
- Operating system and hardware (relevant for the voice's GPU/CPU behaviour)
- For AI issues: the provider and model (never paste your API key)
- Steps to reproduce
- Expected vs actual behaviour
- Any relevant output from the VS Code Developer Tools console (`Help → Toggle Developer Tools`)

---

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
