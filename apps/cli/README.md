# codearchy

Your codebase's architecture, for you and your AI agent.

`codearchy` is the command line of [CodeArchy](https://codearchy.com). It
indexes a repository on your machine (TypeScript, JavaScript, Python, Java,
Kotlin, Go, Rust, C#, PHP and Ruby, parsed with tree-sitter) and gives you:

- **The Companion** for the web app at [app.codearchy.com](https://app.codearchy.com):
  the engine runs natively here, with no size limit, live updates as you edit,
  and authorship from your git history.
- **An MCP server**, so Claude Code, Codex, Gemini CLI, Copilot and other agents
  can explore your architecture.
- **AI authorship reports**: which lines AI tools wrote, from the evidence they
  leave in git.

Node.js 22 or later.

## The Companion

```sh
npx codearchy serve --root .
```

It prints a one-time pairing link. Open it, and the web app shows the
repository from this machine. Only pages on this machine, from the app (or
origins you allow with `--allow-origin`), can connect. It never writes to your
files.

## For your AI agent (MCP)

```sh
claude mcp add codearchy -- npx -y codearchy mcp --root /path/to/repo
```

The agent gets these tools: `overview`, `search`, `get_node`, `neighbors`,
`explain_edge`, `find_flows` and `read_code`. If the agent shouldn't read
source, add `--no-code`: it then sees names, signatures, docs and structure
only.

## Authorship

```sh
npx codearchy authorship report              # what this branch adds, and who wrote it (Markdown)
npx codearchy authorship notes               # record HEAD's AI lines as a git note
npx codearchy authorship hook install        # …after every commit
```

Run `codearchy --help` for every option.

## Privacy

Everything runs on your machine. Nothing is uploaded. Agent session logs
(`--agent-logs`) are opt-in, and only line ranges are kept from them.

## License

MIT. Source and issues: [github.com/CodeArchy/codearchy](https://github.com/CodeArchy/codearchy).
