# Changelog

All notable changes to CodeArchy will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-11-22

### Added

- **Real tree-sitter parsing for every supported language.** Grammars now ship in the extension (they were never bundled before, so every file went through regex). They're fetched from pinned npm releases and verified by integrity hash at build time.
- **Three new languages:** C#, PHP and Kotlin, alongside TypeScript, JavaScript, Python, Java, Go and Rust.
- **Methods and nested types** are extracted with their owning class, struct, trait or `impl`.
- **Import resolution for each ecosystem.**
  - TypeScript `paths`/`baseUrl` (including `extends`) and workspace packages
  - Python absolute and relative imports
  - Java/Kotlin fully-qualified and wildcard imports
  - C# `using`
  - PHP `use`, PSR-4 and `require`
  - Go modules
  - Rust `mod`, `crate::` and `super::`
  - Same-package references for Java, Kotlin, C#, PHP and Go
- **Live updates from disk.** Files that are created, changed, deleted or renamed by an editor, a coding agent or `git pull` update the diagram, edges included.
- **CodeArchy output channel.** Shows discovery, parser coverage and timing for each analysis.
- **`codearchy.maxFiles` setting.** Defaults to 20,000. CodeArchy warns when a workspace exceeds it instead of silently truncating.
- **Developer tooling:** `npm run test:unit` (plain-Node parser and resolver tests), an end-to-end VS Code sandbox test, and `npm run bench` for measuring any repository.

### Changed

- **File discovery uses `git ls-files`.** This honours `.gitignore` and has no 5,000-file cap. The VS Code file search is now only a fallback.
- **Files are read directly from disk.** They're no longer opened as editor documents.
- **Analysis yields regularly** so the extension host stays responsive.
- **Subsystem grouping matches whole path words.** `ui` no longer matches `build/`, and `test` no longer matches `latest`.
- **Graph node ids are POSIX paths on every OS.**

### Fixed

- **Symbol names and exports.** Names were the full source text of a declaration, and exported declarations were missed under tree-sitter.
- **Progress notification.** It overshot 100%.
- **Released packages.** They didn't include the parser runtime.

## [1.0.3] - 2026-05-16

### Added

- **Gemma 4 AI inference via Ollama** — the dependency graph (not raw source code) is sent to a locally-running Gemma 4 model which produces named subsystems, their roles, inter-subsystem relationships, and a recommended architectural pattern (MVC, Layered, Event-Driven, Hexagonal, etc.)
- **Three Gemma 4 model variants** — `gemma4:e2b` (5.12B params, ~4 GB RAM), `gemma4:e4b` (8B params, ~8 GB RAM), `gemma4:26b` (25.8B params, ~16 GB RAM); selectable from the in-diagram toolbar
- **Model Selector UI** — in-diagram panel to choose, install, and switch Gemma 4 variants without leaving VS Code
- **Conversational AI assistant** — chat panel with full architectural context; ask questions about any subsystem or data flow in natural language; conversation history persisted per project in IndexedDB
- **Voice input** — microphone capture via `HostAudioRecorder`; audio is transcribed and forwarded to Gemma 4 as a text question
- **Kokoro neural TTS** — offline text-to-speech powered by an ONNX model running in a Web Worker; streams PCM audio chunks so playback begins before synthesis completes; auto-selects WebGPU (GPU) or WASM (CPU) backend
- **Voice Selector** — choose from multiple Kokoro voices; preference persisted per project
- **Story Narrator** — AI-generated step-by-step architectural walkthroughs; each step is narrated aloud and the corresponding node is highlighted in the diagram
- **React Flow primary diagram** — replaced static SVG renderer with a fully interactive React Flow canvas (pan, zoom, drag, minimap, custom node types, animated edges)
- **ELK hierarchical auto-layout** — Eclipse Layout Kernel integration for clean, structured diagram positioning
- **Cytoscape.js dense-graph view** — alternative layout for large, tightly-coupled dependency graphs
- **Export as SVG** — saves the current diagram as a scalable vector graphic
- **Export as PNG** — saves the current diagram as a raster image
- **Diagram toolbar** — quick-access controls for layout switching, export, view mode, and model selection
- **Commands tree view** — dedicated activity bar panel listing all CodeArchy quick-actions
- **IndexedDB persistence** — chat messages, voice audio cache, and narrator steps are persisted locally using Dexie; sessions survive VS Code restarts
- **Ollama background worker** — Ollama streaming inference runs in a separate worker thread to keep the VS Code UI responsive
- `ollamaWorker.ts` streaming worker for non-blocking AI response handling

### Changed

- Architecture inference now has two modes: fast heuristic grouping (no AI) and Gemma 4 semantic inference (when Ollama is running and a model is selected)
- Activity bar now shows two views: Commands and Modules (previously only Modules)
- Webview UI rebuilt as a full React application bundled with esbuild (`webview-ui/`)

---

## [1.0.2] - 2026-05-15

### Added

- Subsystem colour coding across all diagram nodes
- Node detail panel — click any node to inspect its exports, imports, and symbol list
- Sidebar search and filter for the module browser
- Subsystem focus/highlight — click a subsystem label to isolate its members
- `CommandsTreeProvider` for the activity bar quick-actions view

### Fixed

- Incremental re-analysis now correctly handles file deletions and renames without stale nodes remaining in the graph

---

## [1.0.0] - 2026-05-15

### Added

- Initial release
- Multi-language incremental parsing — TypeScript, JavaScript, Python, Java, Go, Rust (Tree-sitter WASM)
- Symbol and dependency extraction
- Dependency graph construction with import resolution
- Heuristic architecture inference with semantic subsystem grouping (API / Routes, Services / Logic, Models / Data, Auth / Security, Messaging / Events, Storage / Files, Views / UI, Utilities, Types / Interfaces, Tests)
- Interactive webview visualisation — pan, zoom, drag nodes
- Activity bar tree view with module browsing
- File navigation from graph nodes (double-click to open source file)
- Incremental updates on file save — re-parses only changed files
- `codearchy.includedLanguages`, `codearchy.excludePatterns`, `codearchy.maxFileSize` configuration settings
