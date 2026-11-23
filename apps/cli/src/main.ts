#!/usr/bin/env node
/**
 * codearchy: the command line.
 *
 *   codearchy mcp [--root <dir>] [--no-code]   serve the map to your AI agent over MCP (stdio)
 *
 * stdout carries the protocol, so everything else goes to stderr.
 */
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { Workspace } from './workspace.js';

const HELP = `codearchy: your codebase's architecture, for you and your AI agent.

Usage:
  codearchy mcp [--root <dir>] [--no-code]
      Serve the architecture map of <dir> (default: the current folder) to an
      AI agent over the Model Context Protocol, on stdin/stdout. Tools:
      overview, search, get_node, neighbors, explain_edge and read_code.
      --no-code   don't offer read_code (names, signatures, docs and structure only)

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

main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
        log(err instanceof Error ? (err.stack ?? err.message) : String(err));
        process.exit(1);
    },
);
