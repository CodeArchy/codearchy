#!/usr/bin/env node
/**
 * codearchy: the command line.
 *
 *   codearchy mcp [--root <dir>] [--no-code]   serve the map to your AI agent over MCP (stdio)
 *   codearchy serve [--root <dir>] [--port <n>] [--allow-origin <url>]…
 *                                              the Companion: the native engine for the web app
 *
 * For `mcp`, stdout carries the protocol, so everything else goes to stderr.
 */
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { installHook, ledgerFile, uninstallHook, writeNotes } from './authorship.js';
import { AGENT_IDS, FileLedgerStore, companionDataDir } from '@codearchy/platform-node';
import type { AgentId } from '@codearchy/core';
import { startCompanion } from './companion.js';
import { Workspace } from './workspace.js';

const HELP = `codearchy: your codebase's architecture, for you and your AI agent.

Usage:
  codearchy mcp [--root <dir>] [--no-code]
      Serve the architecture map of <dir> (default: the current folder) to an
      AI agent over the Model Context Protocol, on stdin/stdout. Tools:
      overview, search, get_node, neighbors, explain_edge, find_flows and read_code.
      --no-code   don't offer read_code (names, signatures, docs and structure only)

  codearchy serve [--root <dir>] [--port <n>] [--allow-origin <url>]... [--app <url>] [--agent-logs <list>]
      The Companion: run the engine natively for the web app (app.codearchy.com),
      for big repositories and live updates in any browser. Prints a one-time
      pairing link. Only pages on this machine, from the app (or the origins you
      allow), can connect, and it never writes to your files.
      --port <n>           listen on this port (default: a free one)
      --allow-origin <url> also accept a self-hosted app at this origin (repeatable)
      --app <url>          the app the pairing link opens (default https://app.codearchy.com)
      --agent-logs <list>  read these agents' session logs on this machine to see exactly
                           which lines they wrote: claude-code, codex, aider (comma-separated).
                           Only line ranges are kept, never the conversations.

  codearchy authorship notes [--root <dir>] [--commit <rev>]
      Write which lines of a commit (default HEAD) AI tools wrote, from the
      Companion's record, as a git note (refs/notes/codearchy-authorship).
      Notes stay local until you push them:
        git push origin refs/notes/codearchy-authorship

  codearchy authorship report [--root <dir>] [--base <ref>] [--json] [--agent-logs <list>]
      What this branch adds since it left <ref> (default: origin's default
      branch, then main, then master): lines by who wrote them (AI tools,
      reviewed, people, unknown), per part, and the dependencies between parts
      it introduces. Markdown for a PR description, or JSON. --agent-logs reads
      those agents' session logs first (opt-in; only line ranges are kept).

  codearchy authorship hook install|uninstall [--root <dir>]
      Run "authorship notes" after every commit (a post-commit hook). It never
      replaces a hook CodeArchy didn't write.

  codearchy --version | --help

Add it to Claude Code, for example:
  claude mcp add codearchy -- codearchy mcp --root /path/to/repo
`;

function version(): string {
    try {
        const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
        return pkg.version ?? '0.0.0';
    } catch {
        return '0.0.0';
    }
}

const log = (message: string) => process.stderr.write(`[codearchy] ${message}\n`);

async function main(argv: string[]): Promise<number> {
    const [command, ...rest] = argv;
    if (!command || command === '--help' || command === '-h' || command === 'help') {
        process.stderr.write(HELP);
        return command ? 0 : 1;
    }
    if (command === '--version' || command === '-v') {
        process.stdout.write(`${version()}\n`);
        return 0;
    }
    if (command === 'serve') return serve(rest);
    if (command === 'authorship') return authorship(rest);
    if (command !== 'mcp') {
        process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
        return 1;
    }

    let root = process.cwd();
    let allowCode = true;
    for (let i = 0; i < rest.length; i++) {
        const arg = rest[i]!;
        if (arg === '--root') root = path.resolve(rest[++i] ?? '.');
        else if (arg.startsWith('--root=')) root = path.resolve(arg.slice('--root='.length));
        else if (arg === '--no-code') allowCode = false;
        else {
            process.stderr.write(`Unknown option "${arg}".\n\n${HELP}`);
            return 1;
        }
    }

    const workspace = new Workspace(root, { log });
    workspace.watch();
    void workspace.snapshot().catch((err: unknown) => log(`Indexing failed: ${err instanceof Error ? err.message : String(err)}`)); // warm up; requests wait for it
    const server = createServer(workspace, { allowCode, version: version() });
    await server.connect(new StdioServerTransport());
    log(`Serving ${root} over MCP${allowCode ? '' : ' (read_code off)'}.`);

    await new Promise<void>((resolve) => {
        const stop = () => resolve();
        process.stdin.on('close', stop);
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
    });
    workspace.close();
    await server.close();
    return 0;
}

async function serve(args: string[]): Promise<number> {
    let root = process.cwd();
    let port = 0;
    let app: string | undefined;
    const allowOrigins: string[] = [];
    const agentLogs: AgentId[] = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        const value = () => args[++i] ?? '';
        if (arg === '--root') root = path.resolve(value());
        else if (arg.startsWith('--root=')) root = path.resolve(arg.slice('--root='.length));
        else if (arg === '--port') port = Number(value());
        else if (arg === '--allow-origin') allowOrigins.push(value());
        else if (arg === '--app') app = value();
        else if (arg === '--agent-logs') {
            for (const a of value().split(',').map((x) => x.trim()).filter(Boolean)) {
                if (!(AGENT_IDS as string[]).includes(a)) {
                    process.stderr.write(`--agent-logs: "${a}" isn't one of ${AGENT_IDS.join(', ')}.\n`);
                    return 1;
                }
                agentLogs.push(a as AgentId);
            }
        }
        else {
            process.stderr.write(`Unknown option "${arg}".\n\n${HELP}`);
            return 1;
        }
    }
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        process.stderr.write(`--port must be a port number.\n`);
        return 1;
    }
    if (app) {
        try {
            app = new URL(app).origin;
            allowOrigins.push(app);
        } catch {
            process.stderr.write(`--app must be a URL.\n`);
            return 1;
        }
    }

    let notify: ((file?: string) => void) | undefined;
    // Review marks from the web app: kept in the Companion's own data folder, never in the workspace.
    const ledgerStore = new FileLedgerStore(path.join(companionDataDir(root), 'authorship-ledger.json'));
    const workspace = new Workspace(root, {
        log,
        onChange: (file) => notify?.(file),
        onAuthorship: () => notify?.(),
        ledger: ledgerStore.ledger,
        agentLogs,
        onLedgerChange: () => {
            // takeChanged() was consumed by the workspace: persist now.
            ledgerStore.save();
        },
    });
    workspace.watch();
    void workspace.snapshot().catch((err: unknown) => log(`Indexing failed: ${err instanceof Error ? err.message : String(err)}`));
    const companion = await startCompanion(workspace, { port, allowOrigins, version: version(), log, ...(app ? { appUrl: app } : {}) });
    notify = companion.notify;
    process.stdout.write(
        `\nCodeArchy Companion is serving ${root}\n\n` +
            `Open this link to connect (it works once):\n\n  ${companion.pairingUrl}\n\n` +
            `Only pages on this machine can connect, and nothing is written to your files. Press Ctrl+C to stop.\n\n`
    );

    await new Promise<void>((resolve) => {
        process.on('SIGINT', resolve);
        process.on('SIGTERM', resolve);
    });
    await companion.close();
    workspace.close();
    ledgerStore.save();
    return 0;
}

async function authorship(args: string[]): Promise<number> {
    const [sub, ...rest] = args;
    let root = process.cwd();
    let commit = 'HEAD';
    let base: string | undefined;
    let json = false;
    const agentLogs: AgentId[] = [];
    let action: string | undefined;
    for (let i = 0; i < rest.length; i++) {
        const arg = rest[i]!;
        if (arg === '--root') root = path.resolve(rest[++i] ?? '.');
        else if (arg === '--commit') commit = rest[++i] ?? 'HEAD';
        else if (arg === '--base') base = rest[++i];
        else if (arg === '--json') json = true;
        else if (arg === '--agent-logs') {
            for (const a of (rest[++i] ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
                if (!(AGENT_IDS as string[]).includes(a)) {
                    process.stderr.write(`--agent-logs: "${a}" isn't one of ${AGENT_IDS.join(', ')}.\n`);
                    return 1;
                }
                agentLogs.push(a as AgentId);
            }
        }
        else if (!arg.startsWith('-') && !action) action = arg;
        else {
            process.stderr.write(`Unknown option "${arg}".\n\n${HELP}`);
            return 1;
        }
    }
    try {
        if (sub === 'notes') process.stdout.write(`${await writeNotes(root, commit)}\n`);
        else if (sub === 'report') {
            const ledger = new FileLedgerStore(ledgerFile(root)).ledger;
            const workspace = new Workspace(root, { ledger, ...(agentLogs.length ? { agentLogs } : {}), log: (m) => process.stderr.write(`[codearchy] ${m}\n`) });
            try {
                const { report, markdown } = await workspace.branchReport(base);
                process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : markdown);
            } finally {
                workspace.close();
            }
        }
        else if (sub === 'hook' && action === 'install') process.stdout.write(`${installHook(root)}\n`);
        else if (sub === 'hook' && action === 'uninstall') process.stdout.write(`${uninstallHook(root)}\n`);
        else {
            process.stderr.write(`Usage: codearchy authorship notes | report | hook install | hook uninstall\n`);
            return 1;
        }
        return 0;
    } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
    }
}

main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
        log(err instanceof Error ? (err.stack ?? err.message) : String(err));
        process.exit(1);
    },
);
