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

# Install extension host dependencies
npm install

# Install webview UI dependencies
cd webview-ui && npm install && cd ..

# Fetch the pinned tree-sitter grammars into parsers/ (verified downloads)
npm run grammars

# Compile both the extension and the webview
npm run compile

# Launch extension in development mode
# Press F5 in VS Code (uses .vscode/launch.json)
```

The `npm run watch` task (bound to the default VS Code build task) compiles both layers incrementally on file save.

### Project Structure

```
codearchy/
├── src/                          # Extension Host (Node.js context)
│   ├── extension.ts              # Entry point — activates commands, providers, file watcher
│   ├── model.ts                  # Host-agnostic data model (no `vscode` import)
│   ├── types.ts                  # Re-exports the model + VS Code config schema
│   ├── analysis/                 # Analysis core — plain Node, never imports `vscode`
│   │   ├── languages.ts          # Language packs: extensions, grammar, query, rules
│   │   ├── TreeSitterEngine.ts   # Runs a pack's query, extracts symbols & imports
│   │   ├── regexFallback.ts      # Line-based fallback when a grammar is missing
│   │   ├── resolver.ts           # Import → file resolution per ecosystem
│   │   ├── discovery.ts          # git ls-files discovery, exclude globs, manifests
│   │   ├── glob.ts               # Minimal glob matcher for exclude patterns
│   │   └── Analyzer.ts           # read → extract orchestration, cooperative yielding
│   ├── audio/
│   │   └── HostAudioRecorder.ts  # Captures microphone audio for voice input
│   ├── graph/
│   │   └── GraphBuilder.ts       # Builds the typed dependency graph
│   ├── inference/
│   │   ├── ArchitectureInference.ts  # Heuristic subsystem grouping
│   │   ├── OllamaService.ts          # Ollama REST API client + model registry
│   │   └── ollamaWorker.ts           # Background worker for Ollama streaming
│   ├── pipeline/
│   │   └── AnalysisPipeline.ts   # VS Code glue: discovery, incremental updates, progress
│   ├── test/
│   │   ├── unit/                 # Plain-Node tests (extraction, resolution, heuristics)
│   │   └── suite/                # VS Code sandbox tests (run in a real extension host)
│   ├── views/
│   │   ├── CommandsTreeProvider.ts  # Activity bar — quick-action commands view
│   │   └── ModulesTreeProvider.ts   # Activity bar — subsystem & module tree
│   └── webview/
│       └── ArchitecturePanel.ts  # Webview panel lifecycle & postMessage bridge
│
├── webview-ui/                   # Webview UI (browser/Electron context)
│   ├── esbuild.js                # Webview bundler config
│   ├── src/
│   │   ├── App.tsx               # Root component — layout & panel routing
│   │   ├── index.tsx             # Webview entry point
│   │   ├── types.ts              # Webview-scoped types
│   │   ├── vscode.ts             # VS Code postMessage API wrapper
│   │   ├── components/
│   │   │   ├── ChatPanel.tsx         # Conversational AI assistant UI
│   │   │   ├── CytoscapeView.tsx     # Dense-graph layout (Cytoscape.js)
│   │   │   ├── DetailPanel.tsx       # Node/subsystem inspection panel
│   │   │   ├── ModelSelector.tsx     # Gemma 4 model picker
│   │   │   ├── ReactFlowView.tsx     # Primary architecture diagram (React Flow)
│   │   │   ├── Sidebar.tsx           # Module browser sidebar
│   │   │   ├── SystemView.tsx        # Top-level diagram container
│   │   │   ├── Toolbar.tsx           # Diagram toolbar (layout, export, mode)
│   │   │   ├── VoiceSelector.tsx     # Kokoro voice picker
│   │   │   ├── elkLayout.ts          # ELK hierarchical auto-layout
│   │   │   ├── exportSvg.ts          # SVG/PNG export helpers
│   │   │   └── useStoryPlayer.ts     # Narrator story playback hook
│   │   ├── db/
│   │   │   ├── database.ts           # IndexedDB initialisation (Dexie)
│   │   │   ├── persistence.ts        # Chat & voice cache persistence
│   │   │   ├── projectContext.ts     # Per-project context store
│   │   │   └── index.ts              # DB API re-exports
│   │   └── voice/
│   │       ├── kokoroTTS.ts          # Kokoro TTS main-thread API
│   │       ├── kokoroVoices.ts       # Available voice definitions
│   │       ├── kokoroWorker.ts       # ONNX inference worker (off UI thread)
│   │       ├── ttsManager.ts         # Unified TTS facade (Kokoro + Web Speech)
│   │       └── voiceConfig.ts        # Per-project voice preferences
│
├── media/                        # Static assets (CSS, GIF, icons)
├── parsers/                      # Generated by `npm run grammars` (git-ignored, shipped in the VSIX)
├── scripts/                      # Build-time helpers: grammars.json + fetch-grammars.js, bench.js, Kokoro download
├── test-fixtures/                # Small multi-language repos used by the tests
├── package.json                  # Extension manifest & contribution points
└── tsconfig.json                 # TypeScript compiler config
```

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
npm run test:unit                 # fast, plain Node: extraction, resolution, heuristics
npm test                          # VS Code sandbox: activation + analysis of test-fixtures/polyglot
npm run bench -- <repo> [<repo>]  # timings, parser coverage, import resolution per language
npm run bench -- <repo> --unresolved   # also list the most common unresolved imports
```

Bug in extraction or resolution? Add the smallest failing snippet to
`src/test/unit/extraction.test.ts`, or files to `test-fixtures/polyglot/` plus an
assertion in `src/test/unit/graph.test.ts`, before fixing it.

## Adding or improving a language

Each language is one **pack** in [`src/analysis/languages.ts`](src/analysis/languages.ts):

1. **Grammar** — add the grammar's npm package, version and integrity hash
   (`npm view <pkg>@<version> dist.integrity`) to [`scripts/grammars.json`](scripts/grammars.json)
   and run `npm run grammars`. Grammars ship as prebuilt `.wasm` files; no native build runs.
2. **Query** — write one tree-sitter query using the capture names documented at the top of
   `languages.ts` (`@def.<kind>` + `@name`, `@import.source`, `@namespace`, ...). The
   [tree-sitter playground](https://tree-sitter.github.io/tree-sitter/7-playground.html) shows a
   grammar's node types.
3. **Rules** — implement `isExported`, and the import hooks if the language needs them.
4. **Resolution** — add a resolver branch in [`src/analysis/resolver.ts`](src/analysis/resolver.ts)
   that maps the language's import specifiers to files.
5. **Tests** — an extraction test with real-world syntax, plus fixture files and expected edges.

Run `npm run bench` on one or two real repositories in that language and include the before/after
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
