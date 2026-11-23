/**
 * The MCP server: CodeArchy's map as tools for the user's own agent.
 *
 * The agent (Claude Code, Codex, Gemini CLI, Copilot…) calls these under its
 * own subscription; CodeArchy makes no model calls here. The tools are the
 * ones grounded chat uses, plus `overview` as the place to start. All are
 * read-only.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ROLE_LABEL, runTool, TOOL_SPECS, ToolArgumentError, type ToolContext } from '@codearchy/ai';
import type { Snapshot, Workspace } from './workspace.js';

export interface ServerOptions {
    /** Offer read_code. Default true: the agent can usually read the files anyway. */
    allowCode?: boolean;
    version: string;
}

type Result = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const KIND = z.enum(['package', 'component', 'module', 'symbol']);

export function createServer(workspace: Workspace, options: ServerOptions): McpServer {
    const allowCode = options.allowCode ?? true;
    const server = new McpServer(
        { name: 'codearchy', version: options.version },
        {
            instructions:
                "CodeArchy's architecture map of this workspace: packages, components, files and symbols, with summaries and the dependencies between them. " +
                'Start with overview, then search and get_node; use neighbors and explain_edge to see how parts depend on each other. ' +
                'Node keys returned by one tool are the arguments for the others.',
        },
    );

    const run = async (name: string, args: Record<string, unknown>): Promise<Result> => {
        try {
            const snap = await workspace.snapshot();
            const ctx: ToolContext = {
                index: snap.index,
                search: snap.search,
                readFile: (p) => workspace.readFile(p),
                cardFor: snap.cardFor,
                linesRead: 0, // the per-call cap applies; the agent can read files itself anyway
                touched: new Set(),
                actions: [],
            };
            return { content: [{ type: 'text', text: await runTool(name, args, ctx, allowCode) }] };
        } catch (err) {
            const message = err instanceof ToolArgumentError ? err.message : `The tool failed: ${err instanceof Error ? err.message : String(err)}`;
            return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
        }
    };
    const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

    server.registerTool(
        'overview',
        {
            title: 'Architecture overview',
            description: 'The system at a glance: its top-level parts (packages and components) with their keys and summaries, and index stats. Start here.',
            annotations: readOnly,
        },
        async () => {
            try {
                return { content: [{ type: 'text', text: JSON.stringify(await overview(await workspace.snapshot())) }] };
            } catch (err) {
                return { content: [{ type: 'text', text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], isError: true };
            }
        },
    );
    server.registerTool(
        'search',
        {
            title: 'Search the map',
            description: TOOL_SPECS.search!.description,
            inputSchema: { query: z.string().describe('Words to look for, e.g. "auth session"'), kind: KIND.optional().describe('Only this kind of node') },
            annotations: readOnly,
        },
        (args) => run('search', args),
    );
    server.registerTool(
        'get_node',
        {
            title: 'Describe a node',
            description: TOOL_SPECS.get_node!.description,
            inputSchema: { key: z.string().describe('A node key from another tool') },
            annotations: readOnly,
        },
        (args) => run('get_node', args),
    );
    server.registerTool(
        'neighbors',
        {
            title: 'Dependencies of a node',
            description: TOOL_SPECS.neighbors!.description,
            inputSchema: {
                key: z.string(),
                direction: z.enum(['in', 'out', 'both']).optional(),
                depth: z.number().int().min(1).max(2).optional(),
            },
            annotations: readOnly,
        },
        (args) => run('neighbors', args),
    );
    server.registerTool(
        'explain_edge',
        {
            title: 'Explain a dependency',
            description: TOOL_SPECS.explain_edge!.description,
            inputSchema: { source: z.string(), target: z.string() },
            annotations: readOnly,
        },
        (args) => run('explain_edge', args),
    );
    if (allowCode) {
        server.registerTool(
            'read_code',
            {
                title: 'Read source lines',
                description: TOOL_SPECS.read_code!.description,
                inputSchema: { path: z.string(), startLine: z.number().int().min(1), endLine: z.number().int().min(1) },
                annotations: readOnly,
            },
            (args) => run('read_code', args),
        );
    }
    return server;
}

async function overview(snap: Snapshot) {
    const { index } = snap;
    const root = index.hierarchy.nodes[0]!;
    const rootCard = await snap.cardFor(root.key);
    const parts = await Promise.all(
        index
            .childrenOf(0)
            .slice(0, 60)
            .map(async (i) => {
                const n = index.hierarchy.nodes[i]!;
                const card = await snap.cardFor(n.key);
                return {
                    key: n.key,
                    kind: n.kind,
                    name: n.name,
                    ...(n.path ? { path: n.path } : {}),
                    files: n.modules,
                    ...(n.role ? { role: ROLE_LABEL[n.role.role] } : {}),
                    ...(card ? { summary: card.purpose } : {}),
                };
            }),
    );
    return {
        system: { key: root.key, name: root.name, files: root.modules, ...(rootCard ? { summary: rootCard.purpose } : {}) },
        parts,
        ...(index.childrenOf(0).length > 60 ? { moreParts: index.childrenOf(0).length - 60 } : {}),
        index: { files: snap.files, languages: snap.languages, builtAt: new Date(snap.builtAt).toISOString(), buildMs: snap.buildMs },
        note: 'Summaries here are built from docs, names and structure (no AI).',
    };
}
