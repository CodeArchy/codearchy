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
import { startCompanion } from './companion.js';
import { Workspace } from './workspace.js';

const HELP = `codearchy: your codebase's architecture, for you and your AI agent.

Usage:
  codearchy mcp [--root <dir>] [--no-code]
      Serve the architecture map of <dir> (default: the current folder) to an
      AI agent over the Model Context Protocol, on stdin/stdout. Tools:
      overview, search, get_node, neighbors, explain_edge, find_flows and read_code.
      --no-code   don't offer read_code (names, signatures, docs and structure only)

  codearchy serve [--root <dir>] [--port <n>] [--allow-origin <url>]... [--app <url>]
      The Companion: run the engine natively for the web app (app.codearchy.com),
      for big repositories and live updates in any browser. Prints a one-time
      pairing link. Only pages on this machine, from the app (or the origins you
      allow), can connect, and it never writes to your files.
      --port <n>           listen on this port (default: a free one)
      --allow-origin <url> also accept a self-hosted app at this origin (repeatable)
      --app <url>          the app the pairing link opens (default https://app.codearchy.com)

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
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        const value = () => args[++i] ?? '';
        if (arg === '--root') root = path.resolve(value());
        else if (arg.startsWith('--root=')) root = path.resolve(arg.slice('--root='.length));
        else if (arg === '--port') port = Number(value());
        else if (arg === '--allow-origin') allowOrigins.push(value());
        else if (arg === '--app') app = value();
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
    const workspace = new Workspace(root, { log, onChange: (file) => notify?.(file), onAuthorship: () => notify?.() });
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
    return 0;
}

main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
        log(err instanceof Error ? (err.stack ?? err.message) : String(err));
        process.exit(1);
    },
);
