/** A small shop codebase as a real hierarchy (built by core), plus its files in memory. */
import { buildHierarchy, HierarchyIndex } from '@codearchy/core';
import { EdgeType, NodeType, SymbolKind, type ArchitectureGraph, type SymbolInfo } from '@codearchy/protocol';

const sym = (filePath: string, name: string, startLine: number, endLine: number, kind = SymbolKind.Function, exported = true): SymbolInfo => ({
    name,
    kind,
    filePath,
    startLine,
    endLine,
    exported,
});

export const FILES: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'shop', description: 'A small online shop.' }),
    'src/auth/session.ts': ['/** Session handling. */', 'export function login(user: string) {', '    return secretInternalLogic(user);', '}', '', 'export function logout() {', '}'].join('\n'),
    'src/auth/tokens.ts': ['// Token signing.', 'export function sign(payload: object): string {', '    return hmacStuff(payload);', '}'].join('\n'),
    'src/billing/invoice.ts': ['export class Invoice {', '    total(): number {', '        return 1;', '    }', '}'].join('\n'),
    'src/billing/charge.ts': ['export function charge(invoice: Invoice) {', '}'].join('\n'),
    'src/billing/README.md': '# Billing\n\nInvoices and payment runs for the shop.\n',
};

const SYMBOLS: Record<string, SymbolInfo[]> = {
    'src/auth/session.ts': [sym('src/auth/session.ts', 'login', 1, 3), sym('src/auth/session.ts', 'logout', 5, 6)],
    'src/auth/tokens.ts': [sym('src/auth/tokens.ts', 'sign', 1, 3)],
    'src/billing/invoice.ts': [sym('src/billing/invoice.ts', 'Invoice', 0, 4, SymbolKind.Class), sym('src/billing/invoice.ts', 'total', 1, 3, SymbolKind.Method, false)],
    'src/billing/charge.ts': [sym('src/billing/charge.ts', 'charge', 0, 1)],
};

export function index(files = FILES): HierarchyIndex {
    const code = Object.keys(files).filter((f) => f.endsWith('.ts'));
    const edges: Array<[string, string]> = [
        ['src/auth/session.ts', 'src/auth/tokens.ts'],
        ['src/billing/charge.ts', 'src/billing/invoice.ts'],
        ['src/billing/charge.ts', 'src/auth/session.ts'],
    ];
    const graph: ArchitectureGraph = {
        nodes: code.map((id) => ({ id, label: id, filePath: id, type: NodeType.File, symbols: SYMBOLS[id] ?? [], metadata: { language: 'typescript' } })),
        edges: edges.map(([source, target]) => ({ id: `${source}:${target}`, source, target, type: EdgeType.Import, weight: 1, metadata: { evidence: [{ source: target, line: 0 }] } })),
        subsystems: [],
        metadata: { analyzedAt: 0, fileCount: code.length, totalSymbols: 0, totalEdges: edges.length, languages: [] },
    };
    return new HierarchyIndex(buildHierarchy(graph, { systemName: 'shop' }));
}

export const reader = (files: Record<string, string>) => async (path: string) => files[path];
