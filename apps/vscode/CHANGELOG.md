# Changelog

All notable changes to CodeArchy will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Ask about your code, in the Map.** An **Ask** panel beside the Inspector answers questions from the map itself. It searches, follows dependencies and, where the privacy tier allows it, reads code. A status line shows what it's looking at. Answers cite the parts and lines they rely on: click a citation to see it on the map or open the file. **Show me** opens what an answer points to, and **Ask about this** in the Inspector asks about the selected node.
- **Summary cards.** The Inspector shows a short summary for every file, component and package. It's built from docs, names and structure, and marked *auto-summary*. **Summarize with AI** writes a better one, labelled with the model that wrote it. AI summaries are kept with the workspace, so they survive a reload.
- **Your choice of model.**
  - **On this machine:** Ollama or LM Studio.
  - **Your GitHub Copilot plan,** through VS Code's Language Model API. VS Code asks once before CodeArchy may use a model.
  - **Your own API key:** Anthropic, OpenAI, Google Gemini, OpenRouter, Groq or Mistral. Keys are kept in VS Code's secret storage (your OS keychain), never in settings.

  Set it up from **AI** in the Map's toolbar.
- **Privacy you can see.** Choose what may leave your machine:
  - **Local only** (the default): nothing leaves.
  - **Structure:** names, signatures, docs and dependencies, but no code.
  - **Structure + code excerpts.**

  Secrets are removed from anything sent to a cloud model. You can turn on **Ask before sending** to review each request first, and set daily token budgets per provider.
- **Flows.** A new **Flows** mode, next to Map and Matrix, lists where things enter your code:
  - HTTP routes (Express, NestJS, FastAPI, Flask, Django, Spring, ASP.NET, gin, Laravel, Rails and more);
  - CLI commands;
  - jobs and listeners;
  - UI routes, VS Code commands and `main`.

  Choose one to see what it does: each call in order, laid out across the parts of the system it passes through. It also shows the databases, HTTP APIs and queues the flow reaches. Click a step to inspect its file, or open it in the editor. **Show on map** takes you back to the Map. Calls matched by name alone, without an import, are dashed.
- **Tours.** A new **Tours** mode offers guided walks through the code.
  - **Start Here** is built for every workspace, with no AI needed. It covers the big picture, where things start (one flow, followed end to end), the core parts, the data layer, the services it talks to, shared foundations, and a good first change.
  - **The player:** it sits over the canvas, and each step moves the Map (or Flows) to what it explains. It lists the lines worth reading, links to the parts it mentions, and has **Ask about this step**. Steps you've finished are remembered, so you can resume later.
  - **Your own tours:** use **Add to tour** in the Inspector, or on a flow, to build a tour. Then **Save to .codearchy/tours** writes it into the repository, so it's reviewed and shared like code. Steps whose code has changed since they were written are flagged.
  - **Walk through** plays any flow as a tour.
- **Authorship.** See which code AI tools wrote, from the evidence they leave in git history.
  - **What counts:** `Co-authored-by` lines naming an AI tool, coding-agent bot commits, and tool markers such as "Generated with Claude Code". These are traced to today's lines with git blame.
  - **The Authorship lens** shows each part's share of AI-written and reviewed lines, as text with a small bar.
  - **The Inspector** shows the breakdown by tool, the most AI-written files, a weekly timeline and the commits behind it.
  - **Your privacy:** lines without evidence are "unknown"; nothing is guessed. Results are totals and tool names only, never people. It runs only `git log` and `git blame` on this machine.
  - **Turn it off** with `codearchy.authorship.enabled`.
- **Authorship as you work.**
  - **Live capture:** CodeArchy records AI insertions as they happen in this editor: large insertions that aren't pastes, labelled *inferred*, because VS Code doesn't say which extension made an edit. When you change AI-written lines, they count as reviewed.
  - **The gutter:** a thin bar marks AI-written lines in orange and reviewed lines in blue. Hover it for the tool, the date and the evidence.
  - **Your say:** **Mark Selection as Reviewed** and **Correct Authorship of Selection**, from the editor's context menu or the hover.
  - **Where it's kept:** in this workspace's storage on this machine, never in your files.
  - **Settings:** `codearchy.authorship.capture` and `codearchy.authorship.gutter`.
- **Agent session logs (opt-in).** Turn on `codearchy.authorship.agentLogs` for Claude Code, Codex or Aider, and CodeArchy reads their session logs on this machine to see exactly which lines they wrote (*verified*).
  - **What's kept:** only which lines, which agent and when. Nothing from your prompts or conversations.
  - **Reviewed lines:** lines you changed afterwards show as reviewed, and so does an edit you modified before accepting it.
  - **A limit:** edits an agent makes through shell commands aren't in its logs, so later changes to those lines also show as reviewed.
- **Ask about flows.** Chat and `codearchy mcp` can find entrypoints and trace them (`find_flows`), so "what happens when someone logs in?" gets an answer that follows the code.
- `codearchy.ollama.url` setting: where Ollama listens.

### Changed

- In the Map, the new Ask panel replaces the v1 chat, and **AI model** is now **Local models** (downloading Ollama models). The classic views keep the v1 chat.

## [2.0.0] - 2026-11-23

**Pre-release: the 2.0 beta.** Install it from the Marketplace's pre-release channel (Switch to Pre-Release Version).

### Added

- **The Map.** The panel opens on an architecture map you explore in place: System › Package › Component › File.
  - Packages come from your manifests. Large folders are grouped by their dependencies, so each level stays readable.
  - **One canvas.** Double-click (or +) expands a node right where it is; double-click its header to collapse it. Nodes glide to their new places and the view follows, so you never lose your bearings. "Show only this" opens a node on its own when you want to.
  - **Trace dependencies.** Click a node: what it uses and what uses it are animated in the direction of the dependency, in two colours, and everything else fades. Hovering previews the same.
  - The Navigator tree, the Inspector (what a node contains, uses and is used by, and the imports behind any arrow), ⌘K search and keyboard navigation. Search and "Reveal in Map" open the path in place.
- **Matrix and lenses.** A dependency structure matrix of the current view: anything above the diagonal is a cycle. The Health lens marks files in cycles, hubs and orphans; the Tests lens shows how many files have a test depending on them.
- **In the editor.** The status bar shows where the current file sits, a CodeLens at the top of each file says what it uses and is used by, and **Reveal in Map** jumps to it (editor and Explorer context menus).
- **Settings.** `codearchy.ui` chooses the Map (default) or the classic views; `codearchy.codeLens` turns the CodeLens off.

### Changed

- **Classic views kept for now.** System, Flow and Dense remain available through the 2.0 beta: set `codearchy.ui` to `classic`, use **Classic views** in the Map's toolbar, or run **CodeArchy: Switch between the Map and the classic views**. Narrated walkthroughs and SVG / PNG export stay in the classic views until the Map has its own.

### Fixed

- Files created inside a new folder (a checkout, an unzip, a code generator) are now picked up on Linux.

## [1.1.1] - 2026-11-22

### Fixed

- **Kokoro voice works again.** Version 1.1.0 was packaged without the voice model, so Kokoro couldn't start. The model is now downloaded once, on first activation, instead of being bundled.

### Changed

- **Voice model downloads on demand.**
  - **Size:** about 93 MB the first time you activate Kokoro, plus 0.5 MB for each extra voice the first time you use it.
  - **Integrity:** files come from a pinned Hugging Face commit and are checked against sha256 hashes. A file that fails the check is never used or cached.
  - **Storage:** the model is stored in VS Code's global storage, so it survives extension updates, and it's used offline from then on.
  - **Network:** only the extension host makes the download. The webview's content policy no longer allows any external host.
- **Speech starts while the answer is still being written.**
  - **Phrase streaming:** voice answers are split into phrases as they stream in, with a short first phrase, and each is synthesised while the previous one plays. On a CPU-only machine, time to first audio for a typical answer drops from about 52 s to about 7 s.
  - **Filler phrases:** a short pre-synthesised phrase ("One moment.") covers the wait if the answer is slow to begin.
  - **Replay:** the spoken audio is kept, so replaying a message is instant.
- **GPU voice model downloads in the background.** The optional 326 MB model no longer blocks activation: speech starts on the CPU model straight away, and the GPU model is used from the next start.
- **Voices warm on demand.** Selecting or previewing a voice warms it. Warming all 28 voices at start-up kept the voice engine busy for about a minute after activation.

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
