# Contributing to CodeArchy

Thank you for your interest in contributing to CodeArchy! This document provides everything you need to set up your environment, understand the codebase, and submit changes.

---

## Development Setup

### Prerequisites

- **Node.js 18+** and npm
- **VS Code 1.85+**
- **Git**
- **Ollama** — required to run Gemma 4 locally for AI inference. Download from [ollama.com](https://ollama.com).
- At least one Gemma 4 model pulled locally:

  ```bash
  ollama pull gemma4:e2b   # fast, ~4 GB RAM
  ollama pull gemma4:e4b   # deeper, ~8 GB RAM
  ollama pull gemma4:26b   # maximum depth, ~16 GB RAM
  ```

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

The repository is a pnpm workspace. The VS Code extension lives in `apps/vscode/`; shared
packages (`packages/*`) arrive as the v2 engine is extracted. Run a package's own scripts with
`pnpm --filter codearchy run <script>` (extension) or `pnpm --filter codearchy-webview-ui run <script>`.

The `pnpm --filter codearchy run watch` task (bound to the default VS Code build task) compiles both layers incrementally on file save.

### Project Structure

```
codearchy/                         pnpm workspace (package.json, pnpm-workspace.yaml, turbo.json)
├── packages/
│   ├── protocol/   @codearchy/protocol      data model shared by engine, hosts and UI (types only)
│   ├── sdk/        @codearchy/sdk           public extension API: defineLanguage, syntax-tree types
│   ├── core/       @codearchy/core          the engine: language packs, extraction, import
│   │                                        resolution, graph, inference. Pure TS behind ports
│   ├── treesitter/ @codearchy/treesitter    ParserRuntime adapter: web-tree-sitter from wasm bytes
│   ├── grammars/   @codearchy/grammars      pinned, integrity-checked grammar .wasm files
│   └── platform-node/ @codearchy/platform-node  Node adapters: file system, git discovery, parser
├── apps/
│   └── vscode/     the extension (composition root): bundled to dist/extension.js with esbuild
│       ├── src/            extension host: commands, file watcher, pipeline, webview panel, voice
│       └── webview-ui/     React webview (moves to packages/ui later in Phase 1)
├── fixtures/       small multi-language repos used by tests (polyglot/)
├── tooling/        workspace checks (dependency boundaries)
└── media/          repository docs assets
```

#### Dependency rules (enforced in CI)

```
protocol, sdk   ← core ← treesitter ← platform-node ← apps/*
```

- `core` and `sdk` compile with **no DOM and no Node types**: they can't touch the host, even by accident.
  Everything host-specific comes in through ports (`FileSystemPort`, `ParserRuntime`).
- The core speaks **workspace-relative POSIX paths** (`web/src/index.ts`); hosts convert at the edge.
- `pnpm lint` runs `tooling/check-boundaries.mjs`, which rejects dependencies that break the arrows above.

---

## Architecture

### Full Pipeline

```
Command / file-system events (saves, agents, git pull)
         │
         ▼
Discovery            ← git ls-files (honours .gitignore), exclude globs
         │
         ▼
Analyzer             ← tree-sitter WASM + one query per language pack
         │              (regex fallback only if a grammar is missing)
         ▼
Import Resolver      ← per-ecosystem rules, indexed lookups
         │
         ▼
Graph Builder        ← typed ArchitectureNode + ArchitectureEdge
         │
    ┌────┴──────────────────┐
    │                       │
    ▼                       ▼
Heuristic Inference    Ollama (Gemma 4)   ← local REST API
(fast, no AI)         (semantic subsystems, architectural pattern)
    │                       │
    └────────┬──────────────┘
             │
             ▼
    Webview (postMessage)
             │
    ┌────────┴───────────────┐
    │                        │
    ▼                        ▼
React Flow diagram    Conversational Chat
(interactive)         + Kokoro TTS narration
```

### Key Principles

1. **Offline-First** — All runtime operations work without internet. Ollama runs at `http://localhost:11434`. Kokoro TTS runs in a Web Worker using local ONNX weights. External downloads (Tree-sitter WASM grammars, Kokoro model, Gemma 4 via Ollama) happen once at install/setup time.

2. **Strict Host / Webview Separation** — File system access, Ollama calls, and audio recording live exclusively in the Extension Host (`src/`). The Webview (`webview-ui/`) handles only rendering, user interaction, and Web Speech API. All cross-boundary communication uses VS Code's `postMessage` API with typed message payloads.

3. **Performance** — Files are read straight from disk (never opened as editor documents), parsing yields to the event loop, and only files that change on disk are re-parsed; edges are rebuilt from cached per-file results. Ollama inference runs in a background worker thread to keep VS Code responsive. Kokoro TTS runs in a Web Worker and streams PCM chunks so audio playback begins before synthesis completes.

4. **AI Output is Architectural, Not File-Level** — When prompting Gemma 4, the model receives the structured dependency graph (not raw source code) and is instructed to respond as a senior software architect. Responses must be in structured JSON (named subsystems, roles, relationships, architectural pattern). Never send raw file content to the model.

5. **Conversation Context** — Chat history is persisted in IndexedDB per project. On each conversational turn, a trimmed context window slice is sent to Ollama — never the full history or the full codebase graph.

---

## Code Standards

- Write strict TypeScript — no implicit `any`; use `unknown` with type guards where needed
- Follow existing naming conventions (camelCase for variables/functions, PascalCase for classes/types)
- Keep functions focused; avoid side-effects in pure data-transformation functions
- Webview components use React functional components with hooks — no class components
- All Ollama API calls must handle errors gracefully (Ollama not running, model not pulled, timeout)
- Voice I/O is a progressive enhancement — text chat must always function independently

## Testing

```bash
pnpm test                                          # all unit tests (Vitest in packages, mocha/node --test in the extension)
pnpm --filter @codearchy/platform-node test:unit   # extraction + resolution against real grammars and fixtures
pnpm --filter @codearchy/core test:unit            # pure engine tests (globs, heuristics, paths, parsers)
pnpm --filter codearchy run test                   # VS Code sandbox: the bundled extension analyses fixtures/polyglot
pnpm --filter codearchy run bench -- <repo>        # timings, parser coverage, import resolution per language
```

Bug in extraction or resolution? Add the smallest failing snippet to
`packages/platform-node/test/extraction.test.ts`, or files to `fixtures/polyglot/` plus an
assertion in `packages/platform-node/test/graph.test.ts`, before fixing it.

## Adding or improving a language

Each language is one `defineLanguage` **pack** in [`packages/core/src/languages/index.ts`](packages/core/src/languages/index.ts):

1. **Grammar** — add the grammar's npm package, version and integrity hash
   (`npm view <pkg>@<version> dist.integrity`) to [`packages/grammars/grammars.json`](packages/grammars/grammars.json)
   and run `pnpm --filter @codearchy/grammars run fetch`. Grammars ship as prebuilt `.wasm` files; no native build runs.
2. **Query** — write one tree-sitter query using the capture names documented at the top of
   `languages.ts` (`@def.<kind>` + `@name`, `@import.source`, `@namespace`, ...). The
   [tree-sitter playground](https://tree-sitter.github.io/tree-sitter/7-playground.html) shows a
   grammar's node types.
3. **Rules** — implement `isExported`, and the import hooks if the language needs them.
4. **Resolution** — add a resolver branch in [`packages/core/src/resolve/resolver.ts`](packages/core/src/resolve/resolver.ts)
   that maps the language's import specifiers to files.
5. **Tests** — an extraction test with real-world syntax, plus fixture files and expected edges.

Run `pnpm --filter codearchy run bench` on one or two real repositories in that language and include the before/after
numbers in your pull request.

---

## Submitting Changes

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes with clear, atomic commit messages
4. Run `npm run lint` and `npm run compile` to verify nothing is broken
5. Open a Pull Request with a description covering: what changed, why, and how to test it

## Reporting Issues

Open an issue on GitHub with:

- VS Code version
- Operating system and hardware (relevant for Kokoro GPU/CPU behaviour)
- Ollama version and model(s) installed (for AI-related issues)
- Steps to reproduce
- Expected vs actual behaviour
- Any relevant output from the VS Code Developer Tools console (`Help → Toggle Developer Tools`)

---

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
