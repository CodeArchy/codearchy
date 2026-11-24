import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuthorshipIndex, buildGraph, buildHierarchy, DEFAULT_EXCLUDE_PATTERNS, DEFAULT_LANGUAGE_IDS, HierarchyIndex, renderBranchReport } from '@codearchy/core';
import { computeBranchReport, computeGitAuthorship, createNodeAnalyzer, discover } from '../src/index.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
const write = (root: string, rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
};

describe('computeBranchReport', () => {
    test('added lines by origin and part, uncommitted lines, and the dependencies a branch introduces', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codearchy-report-'));
        try {
            git(root, 'init', '-q', '-b', 'main');
            write(root, 'core/orders.ts', 'export function placeOrder() {\n    return 1;\n}\n');
            write(root, 'core/money.ts', 'export const cents = (n: number) => n * 100;\n');
            write(root, 'ui/page.ts', 'export function render() {\n    return "page";\n}\n');
            write(root, 'ui/style.ts', 'export const color = "blue";\n');
            git(root, 'add', '.');
            git(root, 'commit', '-q', '-m', 'Start');

            git(root, 'switch', '-q', '-c', 'feature');
            // An AI-assisted commit adds a function to core/orders.ts…
            fs.appendFileSync(path.join(root, 'core/orders.ts'), 'export function refund() {\n    return 2;\n}\n');
            git(root, 'commit', '-q', '-am', 'Add refunds\n\nCo-authored-by: Claude <noreply@anthropic.com>');
            // …a person makes the UI depend on core (new: ui → core)…
            write(root, 'ui/page.ts', 'import { placeOrder } from "../core/orders";\nexport function render() {\n    return placeOrder();\n}\n');
            git(root, 'commit', '-q', '-am', 'Order from the page');
            // …and one line isn't committed yet.
            fs.appendFileSync(path.join(root, 'ui/style.ts'), 'export const size = 12;\n');

            const { analyzer, fs: port } = await createNodeAnalyzer({ root, maxFileSize: 1_000_000 });
            const d = await discover(root, { languages: DEFAULT_LANGUAGE_IDS, excludePatterns: DEFAULT_EXCLUDE_PATTERNS, maxFiles: 0 });
            const analyses = await analyzer.analyzeAll(d.sourceFiles);
            const index = new HierarchyIndex(buildHierarchy(buildGraph(analyses.values()), { systemName: 'shop' }));
            const git5a = await computeGitAuthorship(root, d.sourceFiles);
            const authorship = git5a.ok ? new AuthorshipIndex(index, (p) => analyses.get(p)?.lines, git5a.data) : undefined;

            const report = await computeBranchReport({
                root,
                base: 'main',
                index,
                rangesFor: (rel) => authorship?.describe(`mod:${rel}`)?.ranges ?? [],
                analyses,
                manifests: new Map(),
                analyze: (rel, text) => analyzer.analyzeFile(rel, text),
                read: (rel) => port.readText(rel),
            });

            expect(report).toMatchObject({ base: 'main', commits: 2, uncommitted: 1, deleted: [] });
            expect(report.added).toEqual({ ai: 3, reviewed: 0, human: 0, unknown: 3 }); // refund (3 AI lines); page's 2 new lines + style's 1, without evidence (unchanged lines belong to main)
            expect(report.byAgent).toEqual({ 'claude-code': 3 });
            expect(report.files.map((f) => `${f.path}:${f.status}:${f.added.ai}/${f.added.unknown}`).sort()).toEqual(['core/orders.ts:modified:3/0', 'ui/page.ts:modified:0/2', 'ui/style.ts:modified:0/1']);
            expect(report.byPart.map((p) => p.name).sort()).toEqual(['core', 'ui']);
            expect(report.newDependencies.map((x) => `${x.fromName} → ${x.toName} via ${x.via.map((v) => `${v.from}>${v.to}`).join(',')}`)).toEqual(['ui → core via ui/page.ts>core/orders.ts']);

            const md = renderBranchReport(report);
            expect(md).toContain('**6 lines added** in 2 commits (1 not committed yet)');
            expect(md).toContain('3 written by AI tools and not changed since (50%)');
            expect(md).toContain('- **ui → core** (`ui/page.ts` → `core/orders.ts`)');
            expect(md).toContain('By tool: Claude Code 3.');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('a new file importing a part that others already use is no new dependency', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codearchy-report-'));
        try {
            git(root, 'init', '-q', '-b', 'main');
            write(root, 'core/orders.ts', 'export function placeOrder() {\n    return 1;\n}\n');
            write(root, 'core/money.ts', 'export const cents = (n: number) => n * 100;\n');
            write(root, 'api/client.ts', 'import { placeOrder } from "../core/orders";\nexport const go = () => placeOrder();\n');
            write(root, 'ui/page.ts', 'export const page = 1;\n');
            git(root, 'add', '.');
            git(root, 'commit', '-q', '-m', 'Start');
            git(root, 'switch', '-q', '-c', 'feature');
            // api already depends on core; ui doesn't yet.
            write(root, 'api/refunds.ts', 'import { placeOrder } from "../core/orders";\nexport const refund = () => placeOrder();\n');
            write(root, 'ui/orders.ts', 'import { placeOrder } from "../core/orders";\nexport const show = () => placeOrder();\n');
            git(root, 'add', '.');
            git(root, 'commit', '-q', '-m', 'Refunds and an orders page');

            const { analyzer, fs: port } = await createNodeAnalyzer({ root, maxFileSize: 1_000_000 });
            const d = await discover(root, { languages: DEFAULT_LANGUAGE_IDS, excludePatterns: DEFAULT_EXCLUDE_PATTERNS, maxFiles: 0 });
            const analyses = await analyzer.analyzeAll(d.sourceFiles);
            const index = new HierarchyIndex(buildHierarchy(buildGraph(analyses.values()), { systemName: 'shop' }));
            const report = await computeBranchReport({
                root,
                base: 'main',
                index,
                rangesFor: () => [],
                analyses,
                manifests: new Map(),
                analyze: (rel, text) => analyzer.analyzeFile(rel, text),
                read: (rel) => port.readText(rel),
            });
            expect(report.newDependencies.map((x) => `${x.fromName} → ${x.toName}`)).toEqual(['ui → core']);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
