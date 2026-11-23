import * as assert from 'assert';
import { classifyFiles, DEFAULT_EXCLUDE_PATTERNS } from '../../analysis/discovery';
import { compileGlobs, globToRegExp } from '../../analysis/glob';
import { expandRustUse } from '../../analysis/languages';
import { parseJsonc } from '../../analysis/resolver';
import { heuristicGroupForPath, tokenizeSegment } from '../../inference/ArchitectureInference';

suite('Glob matching', () => {
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

suite('Discovery classification', () => {
    const rel = ['src/a.ts', 'src/b.py', 'node_modules/x/index.js', 'go.mod', 'tsconfig.base.json', 'README.md', 'dist/out.js'];

    test('filters by language and excludes, and separates manifests', () => {
        const r = classifyFiles('/r', rel, { languages: ['typescript', 'python', 'javascript'], excludePatterns: DEFAULT_EXCLUDE_PATTERNS, maxFiles: 0 }, 'git');
        assert.deepStrictEqual(r.sourceFiles.map((f) => f.replace(/\\/g, '/')), ['/r/src/a.ts', '/r/src/b.py']);
        assert.deepStrictEqual(r.manifests.map((f) => f.replace(/\\/g, '/')).sort(), ['/r/go.mod', '/r/tsconfig.base.json']);
        assert.strictEqual(r.truncated, false);
    });

    test('maxFiles truncates explicitly, never silently', () => {
        const r = classifyFiles('/r', rel, { languages: ['typescript', 'python'], excludePatterns: [], maxFiles: 1 }, 'git');
        assert.strictEqual(r.sourceFiles.length, 1);
        assert.strictEqual(r.discovered, 2);
        assert.strictEqual(r.truncated, true);
    });
});

suite('Subsystem heuristics (whole-token matching)', () => {
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

suite('Small parsers', () => {
    test('expandRustUse handles nested groups, aliases, globs and self', () => {
        assert.deepStrictEqual(expandRustUse('crate::a::{b, c::{d, e as f}, self}'), [
            'crate::a::b',
            'crate::a::c::d',
            'crate::a::c::e',
            'crate::a',
        ]);
        assert.deepStrictEqual(expandRustUse('std::io::*'), ['std::io']);
        assert.deepStrictEqual(expandRustUse('super::util as u'), ['super::util']);
    });

    test('parseJsonc strips comments and trailing commas but not URLs in strings', () => {
        const json = parseJsonc('{\n // c\n "$schema": "https://x.dev/a", /* b */ "a": [1, 2,],\n}') as Record<string, unknown>;
        assert.deepStrictEqual(json, { $schema: 'https://x.dev/a', a: [1, 2] });
    });
});
