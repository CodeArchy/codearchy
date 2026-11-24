# Use CodeArchy from your AI agent (MCP)

`codearchy mcp` serves CodeArchy's architecture map of a workspace to the AI
agent you already use: Claude Code, Codex, Gemini CLI, GitHub Copilot in
VS Code, Cursor, or anything else that speaks the
[Model Context Protocol](https://modelcontextprotocol.io). The agent calls
CodeArchy's tools under its own subscription. CodeArchy makes no model calls
of its own and needs no API key.

## What the agent gets

| Tool | What it returns |
|---|---|
| `overview` | The system and its top-level parts (packages, components) with keys and summaries. The place to start. |
| `search` | Parts of the codebase matching names, paths or summaries, with keys for the other tools |
| `get_node` | One node: its summary, children, or a file's symbols with their signatures and doc comments, and its strongest dependencies either way |
| `neighbors` | What a node depends on and what depends on it, one or two steps out |
| `explain_edge` | The file-level dependencies and import sites behind a dependency |
| `find_flows` | Entrypoints (HTTP routes, CLI commands, jobs and listeners, UI routes, `main`); with an `id`, that flow traced through the calls it makes, the parts it passes through and the databases, APIs and queues it reaches |
| `read_code` | Numbered lines of an indexed source file (at most 120 per call) |

All tools are read-only. The summaries come from docs, names and structure;
no AI is involved.

The server indexes the workspace when it starts. It follows `.gitignore`
when the folder is a git repository. A file watcher marks the index stale on
every edit, and the next tool call rebuilds it, so the agent sees your
current code.

`--no-code` leaves `read_code` out. The agent then gets names, signatures,
docs and structure only.

## Set it up

The CLI isn't published on npm yet, so run it from a checkout of this
repository:

```sh
git clone https://github.com/CodeArchy/codearchy.git
cd codearchy
corepack enable && pnpm install
pnpm --filter "@codearchy/cli..." build
```

In the examples below, `/path/to/codearchy` is that checkout and
`/path/to/repo` is the codebase you want the agent to understand.

**Claude Code**

```sh
claude mcp add codearchy -- node /path/to/codearchy/apps/cli/dist/main.js mcp --root /path/to/repo
```

**Codex CLI** (`~/.codex/config.toml`)

```toml
[mcp_servers.codearchy]
command = "node"
args = ["/path/to/codearchy/apps/cli/dist/main.js", "mcp", "--root", "/path/to/repo"]
```

**Gemini CLI** (`~/.gemini/settings.json`)

```json
{
  "mcpServers": {
    "codearchy": {
      "command": "node",
      "args": ["/path/to/codearchy/apps/cli/dist/main.js", "mcp", "--root", "/path/to/repo"]
    }
  }
}
```

**GitHub Copilot in VS Code** (`.vscode/mcp.json` in the repo)

```json
{
  "servers": {
    "codearchy": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/codearchy/apps/cli/dist/main.js", "mcp", "--root", "${workspaceFolder}"]
    }
  }
}
```

Then ask the agent something like *"Use CodeArchy to give me an overview of
this codebase"* or *"Which parts depend on the billing package, and why?"*.

## Troubleshooting

- The server writes its log to stderr, for example
  `[codearchy] Indexed 227 files in 1051 ms`. Most agents show it in their
  MCP logs.
- Run `node /path/to/codearchy/apps/cli/dist/main.js --help` to check the
  build.
