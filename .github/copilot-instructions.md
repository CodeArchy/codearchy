# CodeArchy: instructions for AI coding assistants

CodeArchy maps a codebase's architecture (packages → components → files → symbols), traces request flows, builds
onboarding tours, and shows ownership and AI authorship from git. It runs in VS Code, in the browser
(app.codearchy.com) and as a CLI (`codearchy mcp` for AI agents, `codearchy serve` as the web app's Companion).

**Read first:** [ARCHITECTURE.md](../ARCHITECTURE.md) (how it fits together) and [CONTRIBUTING.md](../CONTRIBUTING.md)
(setup, layout, tests). For a new language: [docs/guides/adding-a-language.md](../docs/guides/adding-a-language.md).

## Layout (pnpm workspace + Turborepo)

- `packages/protocol`: types shared by everything. `packages/sdk`: `defineLanguage` for language packs.
- `packages/languages/<id>`: one package per language (tree-sitter query + rules), depending on `sdk` only.
- `packages/core`: the engine (extraction, index, resolution, graph, hierarchy, flows, tours, authorship).
  **No DOM and no Node types**: host access goes through ports.
- `packages/platform-node` / `packages/platform-browser`: the ports for Node and for browsers.
- `packages/providers`: AI adapters behind one streaming interface. `packages/ai`: cards, grounded chat, search.
- `packages/ui`: the shared React UI. It never imports the engine and gets data through `EngineClient`.
- `apps/vscode` (extension), `apps/cli` (npm package `codearchy`), `apps/playground` (browser debug UI).

`pnpm lint` enforces these dependency directions (`tooling/check-boundaries.mjs`).

## Rules

- Strict TypeScript, no implicit `any`. Prefer small pure functions, and keep output deterministic (break ties by path).
- **Local-first:** analysis never needs the network. AI is optional, every feature must work without a provider,
  and provider calls go through `ProviderRegistry`, never straight to a vendor.
- Repository content is untrusted: render names and paths as text, never HTML, and avoid regexes that can backtrack on input.
- Workspace-relative POSIX paths inside the core; hosts convert at the edge.
- Grammars, runtimes and models are pinned and integrity-checked. Don't add install scripts or unpinned downloads.
- Every change comes with tests (Vitest in packages). Run `pnpm lint`, `pnpm typecheck`, `pnpm test` before a PR.
- Commits are signed off (DCO): `git commit -s`.
