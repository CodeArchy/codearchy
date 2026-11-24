# The Companion: `codearchy serve`

The web app ([app.codearchy.com](https://app.codearchy.com)) normally runs the engine
inside your browser. That works without installing anything, but it's limited by the
browser's memory. Live updates also need a Chromium browser.

The Companion runs the same engine natively on your machine, and the web app connects
to it. With it you get:

- big repositories (250k+ files);
- live updates in any browser;
- the same Map, Matrix, Flows and Tours.

## Start it

```sh
npx codearchy serve --root /path/to/repo
```

It indexes the folder and prints a link:

```
Open this link to connect (it works once):

  https://app.codearchy.com/#pair=…@127.0.0.1:52310
```

Open the link. The app connects, and it reconnects by itself after a reload in the same
tab. To connect from another tab or browser, restart `codearchy serve` for a new link.

| Option | |
|---|---|
| `--root <dir>` | The folder to serve (default: the current one) |
| `--port <n>` | A fixed port (default: a free one) |
| `--allow-origin <url>` | Also accept a self-hosted copy of the app at this origin (repeatable) |
| `--app <url>` | The app the link opens, for example a local dev server |

## What it allows

- **This machine only.** It listens on `127.0.0.1`. The connection must come from the
  app's origin, a `localhost` dev server, or an origin you allowed. It must also
  address the Companion by its local name, which stops DNS-rebinding tricks.
- **Pairing.** The link carries a one-time token in its `#fragment`, which the browser
  never sends to any server. The first message must present that token (or a session
  key from an earlier pairing). Anything else is disconnected.
- **Read-only.** It serves the engine's answers (views, details, search, flows, tours)
  and the text of indexed source files. It never writes to your files, and it never
  serves other files (no `.env`, no manifests, nothing outside the folder).
- **Limits.** Messages are capped in size and rate.

The browser and the Companion talk directly, on your machine. Nothing goes through
CodeArchy's servers.
