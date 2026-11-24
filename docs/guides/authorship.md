# Authorship: which code AI tools wrote

CodeArchy shows how much of each part of your codebase AI tools wrote, from
**evidence**, never by guessing from how code looks. Every line is one of:

| | |
|---|---|
| **AI** | Written by an AI tool and unchanged since |
| **reviewed** | Written by an AI tool, later changed by a person (or marked as reviewed) |
| **human** | Written by a person, with evidence |
| **unknown** | No evidence either way: the honest default for older history |

The results are totals and tool names only. CodeArchy never names a person.

## Where the evidence comes from

| Source | Confidence | Needs |
|---|---|---|
| Agent session logs (Claude Code, Codex, Aider) | verified | Opt-in, below |
| Authorship notes in git (`refs/notes/codearchy-authorship`) | as recorded | Notes written by you or a teammate |
| Commit metadata: `Co-authored-by:` an AI tool, coding-agent bot commits, tool markers | declared (whole commit) | Nothing: works on any git repository |
| Editor capture in VS Code (large insertions that aren't pastes) | inferred | On by default in VS Code |

Where sources overlap, the more precise one wins. Your own **Mark as reviewed** and **Correct** always win.

## Agent session logs (opt-in)

Coding agents keep session logs on your machine. Reading them shows exactly which lines an agent wrote.

- **VS Code:** setting `codearchy.authorship.agentLogs`, for example `["claude-code"]`.
- **The Companion:** `codearchy serve --agent-logs claude-code,codex,aider`.

The logs contain your prompts and conversations, so this is off until you turn it on. Even then, CodeArchy keeps only **which lines, which agent and when**, never the text. Only edits to files in the workspace are used.

Edits an agent makes through shell commands (scripts, `sed`) aren't in its logs. When those lines are changed later, the change reads as a person's, so they show as reviewed.

## Sharing with your team: authorship notes

Your editor's record of who wrote what stays on your machine. To share it, write it to **git notes**: small annotations on commits that travel with the repository when pushed.

- **VS Code:** run **CodeArchy: Write Authorship Notes for the Last Commit**, or set `codearchy.authorship.gitNotes` to `onCommit`.
- **The CLI and the Companion:** run `codearchy authorship notes` after a commit. Or install a hook once, with `codearchy authorship hook install`, and it runs after every commit. It never replaces a hook it didn't write.

Notes stay local until you push them:

```sh
git push origin refs/notes/codearchy-authorship
# teammates fetch them with:
git fetch origin refs/notes/codearchy-authorship:refs/notes/codearchy-authorship
```

A note records, for the files a commit changed, which lines were AI, reviewed or human, in that commit's line numbers. CodeArchy maps them onto today's code with `git blame`, through later edits and renames.
