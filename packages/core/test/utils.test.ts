import { describe, test } from 'vitest';
import * as assert from 'node:assert';
import { classifyFiles, compileGlobs, DEFAULT_EXCLUDE_PATTERNS, expandRustUse, globToRegExp, heuristicGroupForPath, parseJsonc, posixPath, tokenizeSegment } from '../src/index.js';

describe('Glob matching', () => {
    test('`**/dir/**` matches at any depth, including the root', () => {
        const m = compileGlobs(['**/node_modules/**']);
        assert.ok(m('node_modules/a/b.js'));
        assert.ok(m('packages/x/node_modules/a.js'));
        assert.ok(!m('src/node_modules_helper.ts'));
    });

    test('`*`, `?` and `{a,b}`', () => {
        assert.ok(globToRegExp('**/*.min.js').test('static/app.min.js'));
        assert.ok(!globToRegExp('**/*.min.js').test('static/app.js'));
        assert.ok(globToRegExp('src/?.ts').test('src/a.ts'));
        assert.ok(globToRegExp('**/*.{ts,tsx}').test('a/b/c.tsx'));
        assert.ok(!globToRegExp('*.ts').test('a/b.ts'));
    });
});

describe('Discovery classification', () => {
    const rel = ['src/a.ts', 'src/b.py', 'node_modules/x/index.js', 'go.mod', 'tsconfig.base.json', 'README.md', 'dist/out.js'];

    test('filters by language and excludes, and separates manifests', () => {
        const r = classifyFiles(rel, { languages: ['typescript', 'python', 'javascript'], excludePatterns: DEFAULT_EXCLUDE_PATTERNS, maxFiles: 0 }, 'git');
        assert.deepStrictEqual(r.sourceFiles, ['src/a.ts', 'src/b.py']);
        assert.deepStrictEqual(r.manifests.sort(), ['go.mod', 'tsconfig.base.json']);
        assert.strictEqual(r.truncated, false);
    });

    test('maxFiles truncates explicitly, never silently', () => {
        const r = classifyFiles(rel, { languages: ['typescript', 'python'], excludePatterns: [], maxFiles: 1 }, 'git');
        assert.strictEqual(r.sourceFiles.length, 1);
        assert.strictEqual(r.discovered, 2);
        assert.strictEqual(r.truncated, true);
    });
});

describe('Subsystem heuristics (whole-token matching)', () => {
    test('tokenizes camelCase, PascalCase, kebab and snake case', () => {
        assert.deepStrictEqual(tokenizeSegment('UserController.test'), ['user', 'controller', 'test']);
        assert.deepStrictEqual(tokenizeSegment('HTTPServer_utils-v2'), ['http', 'server', 'utils', 'v2']);
    });

    test('no substring false positives (v1 bug V3)', () => {
        assert.notStrictEqual(heuristicGroupForPath('build/output.ts'), 'Views / UI'); // "ui" in "build"
        assert.notStrictEqual(heuristicGroupForPath('docs/guide.ts'), 'Views / UI'); // "ui" in "guide"
        assert.notStrictEqual(heuristicGroupForPath('src/latest.ts'), 'Tests'); // "test" in "latest"
        assert.notStrictEqual(heuristicGroupForPath('src/library/x.ts'), 'Utilities'); // "lib" in "library"
        assert.notStrictEqual(heuristicGroupForPath('src/prototype.ts'), 'Types / Interfaces'); // "type"
    });

    test('most specific token wins; test markers anywhere win', () => {
        assert.strictEqual(heuristicGroupForPath('src/services/userController.ts'), 'API / Routes');
        assert.strictEqual(heuristicGroupForPath('src/api/models/user.ts'), 'Models / Data');
        assert.strictEqual(heuristicGroupForPath('src/components/Button.tsx'), 'Views / UI');
        assert.strictEqual(heuristicGroupForPath('src/services/billing.spec.ts'), 'Tests');
        assert.strictEqual(heuristicGroupForPath('tests/unit/api/routes.py'), 'Tests');
        assert.strictEqual(heuristicGroupForPath('src/orders/place.ts'), undefined);
    });
});

describe('Small parsers', () => {
    test('expandRustUse handles nested groups, aliases, globs and self', () => {
        assert.deepStrictEqual(expandRustUse('crate::a::{b, c::{d, e as f}, self}'), [
            'crate::a::b',
            'crate::a::c::d',
            'crate::a::c::e',
            'crate::a',
        ]);
        assert.deepStrictEqual(expandRustUse('std::io::*'), ['std::io']);
        assert.deepStrictEqual(expandRustUse('super::util as u'), ['super::util']);
        assert.deepStrictEqual(expandRustUse('std::collections::{HashMap as H, BTreeMap}'), ['std::collections::HashMap', 'std::collections::BTreeMap']);
    });

    test('expandRustUse stays linear on hostile whitespace', () => {
        const started = Date.now();
        expandRustUse(`a${' '.repeat(200_000)}x`);
        expandRustUse(`a${' as'.repeat(50_000)}`);
        assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
    });

    test('parseJsonc strips comments and trailing commas but not URLs in strings', () => {
        const json = parseJsonc('{\n // c\n "$schema": "https://x.dev/a", /* b */ "a": [1, 2,],\n}') as Record<string, unknown>;
        assert.deepStrictEqual(json, { $schema: 'https://x.dev/a', a: [1, 2] });
    });
});

describe('Workspace paths (posixPath)', () => {
    test('normalize keeps paths inside the workspace', () => {
        assert.strictEqual(posixPath.normalize('a/./b/../c'), 'a/c');
        assert.strictEqual(posixPath.normalize('a/b/../../c'), 'c');
        assert.strictEqual(posixPath.normalize('../outside'), undefined);
        assert.strictEqual(posixPath.join('a/b', '../../..'), undefined);
    });

    test('dirname, basename, extname, isWithin', () => {
        assert.strictEqual(posixPath.dirname('a/b/c.ts'), 'a/b');
        assert.strictEqual(posixPath.dirname('c.ts'), '');
        assert.strictEqual(posixPath.basename('a/b/c.test.ts'), 'c.test.ts');
        assert.strictEqual(posixPath.extname('a/b/c.test.ts'), '.ts');
        assert.strictEqual(posixPath.extname('a/.env'), '');
        assert.ok(posixPath.isWithin('src/a.ts', 'src'));
        assert.ok(!posixPath.isWithin('srcx/a.ts', 'src'));
        assert.ok(posixPath.isWithin('anything', ''));
    });
});

describe('Resolver determinism', () => {
    const fa = (filePath: string, imports: string[] = []) => ({
        filePath,
        language: 'typescript',
        symbols: [],
        exports: [],
        imports: imports.map((source) => ({ source, specifiers: [], isDefault: false, isNamespace: true, filePath })),
    });

    test('same-named workspace packages: the nearest one wins, whatever the manifest order', async () => {
        const { ImportResolver } = await import('../src/index.js');
        const analyses = [
            fa('sample/a/src/main.ts', ['shared-lib']),
            fa('sample/b/src/main.ts', ['shared-lib']),
            fa('sample/a/lib/index.ts'),
            fa('sample/b/lib/index.ts'),
        ];
        const pkg = (dir: string) => [`${dir}/package.json`, JSON.stringify({ name: 'shared-lib', main: 'lib/index.ts' })] as [string, string];
        for (const order of [
            [pkg('sample/a'), pkg('sample/b')],
            [pkg('sample/b'), pkg('sample/a')],
        ]) {
            const r = new ImportResolver(analyses, new Map(order));
            assert.deepStrictEqual(r.resolve(analyses[0].imports[0], analyses[0]), ['sample/a/lib/index.ts']);
            assert.deepStrictEqual(r.resolve(analyses[1].imports[0], analyses[1]), ['sample/b/lib/index.ts']);
        }
    });
});
