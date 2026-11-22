/**
 * Resolves import specifiers to workspace files, per language ecosystem.
 * All lookups go through prebuilt indexes (Set / Map), so resolving is
 * O(imports) rather than O(imports × files).
 *
 *   JS/TS        relative paths, tsconfig/jsconfig `baseUrl` + `paths`
 *                (following `extends`), workspace packages by package.json name
 *   Python       relative (`from .x import y`) and absolute modules, rooted at
 *                any directory that isn't itself a package
 *   Java/Kotlin  fully-qualified types, wildcard packages, same-package use
 *   C#           `using` namespaces and same-namespace use
 *   PHP          `use` FQNs, composer PSR-4 roots, include/require paths
 *   Go           module paths from go.mod, same-package use
 *   Rust         `mod x;`, `crate::`/`self::`/`super::` paths, workspace crates
 *
 * Package-level imports (Java wildcards, C# usings, Go packages, same-package
 * use) are narrowed to the files whose top-level names the importing file
 * actually references, so one `using App.Models;` doesn't fan out to every model.
 */
import * as path from 'path';
import { FileAnalysis, ImportInfo } from '../model';

interface TsConfig {
    dir: string;
    baseUrl?: string;
    paths: Array<{ prefix: string; suffix: string; wildcard: boolean; targets: string[] }>;
}

interface JsPackage {
    name: string;
    dir: string;
    entries: string[];
}

const JS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const JS_INDEX = JS_EXTENSIONS.map((e) => `index${e}`);
/** Directory names conventionally placed on sys.path (src layout, etc.). */
const PYTHON_ROOTS = new Set(['src', 'lib', 'python', 'packages']);
/** Package-level imports that don't narrow by references link to at most this many files. */
const UNNARROWED_LIMIT = 5;

export class ImportResolver {
    private readonly files: Set<string>;
    private readonly byDir = new Map<string, string[]>();
    private readonly analysisByFile = new Map<string, FileAnalysis>();
    private readonly topNames = new Map<string, Set<string>>();
    private readonly typeIndex = new Map<string, string[]>();
    private readonly namespaceIndex = new Map<string, string[]>();
    private pythonSuffixIndex?: Map<string, string[]>;
    private readonly tsConfigs: TsConfig[] = [];
    private readonly jsPackages: JsPackage[] = [];
    private readonly goModules: Array<{ module: string; dir: string }> = [];
    private readonly crates = new Map<string, string>();
    private readonly crateDirs: string[] = [];
    private readonly psr4: Array<{ prefix: string; dirs: string[] }> = [];

    constructor(
        private readonly root: string,
        analyses: Iterable<FileAnalysis>,
        manifests: Map<string, string> = new Map()
    ) {
        this.files = new Set();
        for (const a of analyses) {
            this.files.add(a.filePath);
            this.analysisByFile.set(a.filePath, a);
            push(this.byDir, path.dirname(a.filePath), a.filePath);
            this.indexDeclarations(a);
        }
        this.loadManifests(manifests);
    }

    /** Files that `imp` (declared in `from`) refers to. Never includes `from`. */
    resolve(imp: ImportInfo, from: FileAnalysis): string[] {
        let targets: string[];
        switch (from.language) {
            case 'typescript':
            case 'javascript':
                targets = this.resolveJs(imp.source, from.filePath);
                break;
            case 'python':
                targets = this.resolvePython(imp, from.filePath);
                break;
            case 'java':
            case 'kotlin':
                targets = this.resolveJvm(imp.source, from);
                break;
            case 'csharp':
                targets = this.resolveCSharp(imp.source, from);
                break;
            case 'php':
                targets = this.resolvePhp(imp.source, from);
                break;
            case 'go':
                targets = this.resolveGo(imp.source, from);
                break;
            case 'rust':
                targets = this.resolveRust(imp.source, from.filePath);
                break;
            default:
                targets = [];
        }
        return unique(targets).filter((t) => t !== from.filePath);
    }

    /** Dependencies that need no import: same package / namespace / Go package. */
    implicitDependencies(from: FileAnalysis): string[] {
        const group = namespaceGroup(from.language);
        if (!group) return [];
        let peers: string[] | undefined;
        if (from.language === 'go') {
            peers = this.byDir.get(path.dirname(from.filePath))?.filter((f) => f.endsWith('.go'));
        } else if (from.namespace) {
            peers = this.namespaceIndex.get(`${group}:${from.namespace}`);
        }
        if (!peers) return [];
        return this.narrowByReferences(peers.filter((p) => p !== from.filePath), from, 0);
    }

    // ─── indexing ───────────────────────────────────────────────────────────

    private indexDeclarations(a: FileAnalysis) {
        const names = new Set(a.symbols.filter((s) => !s.container).map((s) => s.name));
        this.topNames.set(a.filePath, names);

        const group = namespaceGroup(a.language);
        if (!group || a.language === 'go') return;
        const sep = a.language === 'php' ? '\\' : '.';
        const ns = a.namespace?.replace(/^\\/, '');
        if (ns) push(this.namespaceIndex, `${group}:${ns}`, a.filePath);
        for (const name of names) {
            push(this.typeIndex, `${group}:${ns ? ns + sep : ''}${name}`, a.filePath);
        }
    }

    private loadManifests(manifests: Map<string, string>) {
        const tsRaw = new Map<string, Record<string, unknown>>();
        for (const [file, text] of manifests) {
            const base = path.basename(file);
            const dir = path.dirname(file);
            try {
                if (base === 'package.json') {
                    const pkg = JSON.parse(text) as Record<string, unknown>;
                    if (typeof pkg.name === 'string') {
                        const entries = ['source', 'module', 'main', 'types']
                            .map((k) => pkg[k])
                            .filter((v): v is string => typeof v === 'string');
                        this.jsPackages.push({ name: pkg.name, dir, entries });
                    }
                } else if (/^(tsconfig|jsconfig)(\..+)?\.json$/.test(base)) {
                    tsRaw.set(file, parseJsonc(text) as Record<string, unknown>);
                } else if (base === 'go.mod') {
                    const m = text.match(/^\s*module\s+(\S+)/m);
                    if (m) this.goModules.push({ module: m[1].replace(/^"|"$/g, ''), dir });
                } else if (base === 'Cargo.toml') {
                    this.crateDirs.push(dir);
                    const pkgSection = text.split(/^\s*\[/m).find((s) => s.startsWith('package]'));
                    const m = pkgSection?.match(/^\s*name\s*=\s*"([^"]+)"/m);
                    if (m) this.crates.set(m[1].replace(/-/g, '_'), path.join(dir, 'src'));
                } else if (base === 'composer.json') {
                    const json = JSON.parse(text) as { autoload?: { 'psr-4'?: Record<string, string | string[]> } };
                    for (const [prefix, dirs] of Object.entries(json.autoload?.['psr-4'] ?? {})) {
                        this.psr4.push({
                            prefix: prefix.replace(/\\+$/, ''),
                            dirs: (Array.isArray(dirs) ? dirs : [dirs]).map((d) => path.resolve(dir, d)),
                        });
                    }
                }
            } catch {
                // Malformed manifest: ignore it, resolution degrades gracefully.
            }
        }

        for (const file of tsRaw.keys()) {
            const base = path.basename(file);
            if (base !== 'tsconfig.json' && base !== 'jsconfig.json') continue;
            this.tsConfigs.push(buildTsConfig(file, tsRaw));
        }
        // Deepest first, so the nearest config wins.
        this.tsConfigs.sort((a, b) => b.dir.length - a.dir.length);
        this.jsPackages.sort((a, b) => b.name.length - a.name.length);
        this.goModules.sort((a, b) => b.module.length - a.module.length);
        this.crateDirs.sort((a, b) => b.length - a.length);
        this.psr4.sort((a, b) => b.prefix.length - a.prefix.length);
    }

    // ─── JS / TS ────────────────────────────────────────────────────────────

    private resolveJs(spec: string, fromFile: string): string[] {
        const clean = spec.split('?')[0];
        if (clean.startsWith('.') || clean.startsWith('/')) {
            return this.jsCandidates(path.resolve(path.dirname(fromFile), clean));
        }

        const config = this.tsConfigs.find((c) => isWithin(fromFile, c.dir));
        if (config) {
            for (const p of config.paths) {
                if (p.wildcard ? clean.startsWith(p.prefix) && clean.endsWith(p.suffix) : clean === p.prefix) {
                    const star = p.wildcard ? clean.slice(p.prefix.length, clean.length - p.suffix.length) : '';
                    for (const target of p.targets) {
                        const hit = this.jsCandidates(path.resolve(config.baseUrl ?? config.dir, target.replace('*', star)));
                        if (hit.length) return hit;
                    }
                }
            }
            if (config.baseUrl) {
                const hit = this.jsCandidates(path.resolve(config.baseUrl, clean));
                if (hit.length) return hit;
            }
        }

        const pkg = this.jsPackages.find((p) => clean === p.name || clean.startsWith(`${p.name}/`));
        if (pkg) {
            const sub = clean.slice(pkg.name.length + 1);
            if (sub) {
                return firstNonEmpty(
                    () => this.jsCandidates(path.join(pkg.dir, sub)),
                    () => this.jsCandidates(path.join(pkg.dir, 'src', sub))
                );
            }
            for (const entry of pkg.entries) {
                const hit = this.jsCandidates(path.resolve(pkg.dir, entry));
                if (hit.length) return hit;
                // Built entry (dist/index.js) → its source (src/index.ts).
                const asSource = entry.replace(/^\.?\/?(dist|lib|build|out)\//, 'src/');
                const srcHit = this.jsCandidates(path.resolve(pkg.dir, asSource));
                if (srcHit.length) return srcHit;
            }
            return firstNonEmpty(
                () => this.jsCandidates(path.join(pkg.dir, 'src', 'index')),
                () => this.jsCandidates(path.join(pkg.dir, 'index'))
            );
        }
        return [];
    }

    private jsCandidates(base: string): string[] {
        if (this.files.has(base)) return [base];
        for (const ext of JS_EXTENSIONS) {
            if (this.files.has(base + ext)) return [base + ext];
        }
        // ESM-style `./foo.js` that refers to `foo.ts`
        const jsExt = base.match(/\.(m|c)?jsx?$/);
        if (jsExt) {
            const stem = base.slice(0, -jsExt[0].length);
            for (const ext of ['.ts', '.tsx', '.mts', '.cts']) {
                if (this.files.has(stem + ext)) return [stem + ext];
            }
        }
        for (const idx of JS_INDEX) {
            const p = path.join(base, idx);
            if (this.files.has(p)) return [p];
        }
        return [];
    }

    // ─── Python ─────────────────────────────────────────────────────────────

    private resolvePython(imp: ImportInfo, fromFile: string): string[] {
        const rel = imp.source.match(/^(\.+)(.*)$/);
        if (rel) {
            let base = path.dirname(fromFile);
            for (let i = 1; i < rel[1].length; i++) base = path.dirname(base);
            const modulePath = rel[2] ? path.join(base, ...rel[2].split('.')) : base;
            const out = this.pythonModuleAt(modulePath);
            for (const spec of imp.specifiers) out.push(...this.pythonModuleAt(path.join(modulePath, spec)));
            return out;
        }

        const segs = imp.source.split('.');
        const out: string[] = [];
        const module = this.lookupPython(segs, fromFile);
        if (module) out.push(module);
        for (const spec of imp.specifiers) {
            const sub = this.lookupPython([...segs, spec], fromFile);
            if (sub) out.push(sub);
        }
        // `import a.b.c` where c is an attribute: fall back to the longest module prefix.
        for (let i = segs.length - 1; out.length === 0 && i >= 1; i--) {
            const prefix = this.lookupPython(segs.slice(0, i), fromFile);
            if (prefix) out.push(prefix);
        }
        return out;
    }

    private pythonModuleAt(modulePath: string): string[] {
        for (const candidate of [`${modulePath}.py`, `${modulePath}.pyi`, path.join(modulePath, '__init__.py')]) {
            if (this.files.has(candidate)) return [candidate];
        }
        return [];
    }

    private lookupPython(segs: string[], fromFile: string): string | undefined {
        const index = this.getPythonSuffixIndex();
        const keys = [`${segs.join('/')}.py`, `${segs.join('/')}.pyi`, `${segs.join('/')}/__init__.py`];
        let best: string | undefined;
        let bestScore = -1;
        for (const key of keys) {
            for (const file of index.get(key) ?? []) {
                // The directory above the top-level package must not itself be a
                // package, otherwise `json` would match `utils/json.py`.
                const rootDir = file.slice(0, file.length - key.length - 1);
                if (this.files.has(path.join(rootDir, '__init__.py'))) continue;
                // ...and must plausibly be on sys.path for the importer: an
                // ancestor of it, or a conventional source root.
                if (!isWithin(fromFile, rootDir) && !PYTHON_ROOTS.has(path.basename(rootDir)) && rootDir !== this.root) continue;
                const score = commonPrefixLength(file, fromFile);
                if (score > bestScore) {
                    best = file;
                    bestScore = score;
                }
            }
            if (best) return best;
        }
        return best;
    }

    private getPythonSuffixIndex(): Map<string, string[]> {
        if (this.pythonSuffixIndex) return this.pythonSuffixIndex;
        const index = new Map<string, string[]>();
        for (const [file, a] of this.analysisByFile) {
            if (a.language !== 'python') continue;
            const segs = toPosix(path.relative(this.root, file)).split('/');
            for (let k = 0; k < segs.length; k++) push(index, segs.slice(k).join('/'), file);
        }
        this.pythonSuffixIndex = index;
        return index;
    }

    // ─── Java / Kotlin / C# / PHP ───────────────────────────────────────────

    private resolveJvm(source: string, from: FileAnalysis): string[] {
        if (source.endsWith('.*')) {
            const peers = this.namespaceIndex.get(`jvm:${source.slice(0, -2)}`) ?? [];
            return this.narrowByReferences(peers, from, 0);
        }
        // Longest qualified prefix that names a type: covers nested types and static imports.
        const segs = source.split('.');
        for (let i = segs.length; i >= 1; i--) {
            const hit = this.typeIndex.get(`jvm:${segs.slice(0, i).join('.')}`);
            if (hit) return hit;
        }
        return [];
    }

    private resolveCSharp(source: string, from: FileAnalysis): string[] {
        const peers = this.namespaceIndex.get(`cs:${source}`);
        if (peers) return this.narrowByReferences(peers, from, 0);
        return this.typeIndex.get(`cs:${source}`) ?? []; // using static X.Y.Type
    }

    private resolvePhp(source: string, from: FileAnalysis): string[] {
        if (/\.php$|^[./]/.test(source)) {
            const dir = path.dirname(from.filePath);
            return [path.resolve(dir, source), path.resolve(dir, source.replace(/^\//, '')), path.resolve(this.root, source.replace(/^\//, ''))]
                .filter((p) => this.files.has(p))
                .slice(0, 1);
        }
        const fqn = source.replace(/^\\/, '');
        const typeHit = this.typeIndex.get(`php:${fqn}`);
        if (typeHit) return typeHit;
        const nsHit = this.namespaceIndex.get(`php:${fqn}`);
        if (nsHit) return this.narrowByReferences(nsHit, from, 0);
        for (const { prefix, dirs } of this.psr4) {
            if (fqn !== prefix && !fqn.startsWith(`${prefix}\\`)) continue;
            const rest = fqn.slice(prefix.length).replace(/^\\/, '').split('\\');
            for (const dir of dirs) {
                const candidate = `${path.join(dir, ...rest)}.php`;
                if (this.files.has(candidate)) return [candidate];
            }
        }
        return [];
    }

    // ─── Go ─────────────────────────────────────────────────────────────────

    private resolveGo(source: string, from: FileAnalysis): string[] {
        for (const { module, dir } of this.goModules) {
            if (source !== module && !source.startsWith(`${module}/`)) continue;
            const pkgDir = path.join(dir, ...source.slice(module.length).split('/').filter(Boolean));
            const files = (this.byDir.get(pkgDir) ?? []).filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'));
            return this.narrowByReferences(files, from, UNNARROWED_LIMIT, (name) => /^[A-Z]/.test(name));
        }
        return [];
    }

    // ─── Rust ───────────────────────────────────────────────────────────────

    private resolveRust(source: string, fromFile: string): string[] {
        const moduleDir = rustModuleDir(fromFile);
        if (source.startsWith('mod:')) {
            return this.rustModuleAt(path.join(moduleDir, source.slice(4)));
        }

        const segs = source.split('::').filter(Boolean);
        if (segs.length === 0) return [];
        const crateSrc = this.crateSrcFor(fromFile);
        const bases: Array<{ base: string; rest: string[]; isCrateRoot: boolean }> = [];
        const head = segs[0];
        if (head === 'crate' && crateSrc) {
            bases.push({ base: crateSrc, rest: segs.slice(1), isCrateRoot: true });
        } else if (head === 'self') {
            bases.push({ base: moduleDir, rest: segs.slice(1), isCrateRoot: false });
        } else if (head === 'super') {
            let base = moduleDir;
            let i = 0;
            while (segs[i] === 'super') {
                base = path.dirname(base);
                i++;
            }
            bases.push({ base, rest: segs.slice(i), isCrateRoot: false });
        } else if (this.crates.has(head)) {
            bases.push({ base: this.crates.get(head)!, rest: segs.slice(1), isCrateRoot: true });
        } else {
            bases.push({ base: moduleDir, rest: segs, isCrateRoot: false });
            if (crateSrc) bases.push({ base: crateSrc, rest: segs, isCrateRoot: false });
        }

        for (const { base, rest, isCrateRoot } of bases) {
            for (let i = rest.length; i >= 1; i--) {
                const hit = this.rustModuleAt(path.join(base, ...rest.slice(0, i)));
                if (hit.length) return hit;
            }
            if (isCrateRoot) {
                const rootFile = ['lib.rs', 'main.rs'].map((f) => path.join(base, f)).find((f) => this.files.has(f));
                if (rootFile) return [rootFile];
            }
        }
        return [];
    }

    private rustModuleAt(modulePath: string): string[] {
        for (const candidate of [`${modulePath}.rs`, path.join(modulePath, 'mod.rs')]) {
            if (this.files.has(candidate)) return [candidate];
        }
        return [];
    }

    private crateSrcFor(file: string): string | undefined {
        const crateDir = this.crateDirs.find((d) => isWithin(file, d));
        return crateDir ? path.join(crateDir, 'src') : undefined;
    }

    // ─── shared ─────────────────────────────────────────────────────────────

    /**
     * Keeps the candidates whose top-level names `from` references. With no
     * reference data, or no match, returns up to `fallbackLimit` candidates.
     */
    private narrowByReferences(
        candidates: string[],
        from: FileAnalysis,
        fallbackLimit: number,
        nameFilter: (name: string) => boolean = () => true
    ): string[] {
        if (!from.references) return candidates.slice(0, fallbackLimit);
        const refs = new Set(from.references);
        const matched = candidates.filter((c) => {
            const names = this.topNames.get(c);
            if (!names) return false;
            for (const n of names) if (nameFilter(n) && refs.has(n)) return true;
            return false;
        });
        return matched.length ? matched : candidates.slice(0, fallbackLimit);
    }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function namespaceGroup(language: string): string | undefined {
    switch (language) {
        case 'java':
        case 'kotlin':
            return 'jvm';
        case 'csharp':
            return 'cs';
        case 'php':
            return 'php';
        case 'go':
            return 'go';
        default:
            return undefined;
    }
}

function rustModuleDir(file: string): string {
    const base = path.basename(file);
    if (base === 'mod.rs' || base === 'lib.rs' || base === 'main.rs') return path.dirname(file);
    return path.join(path.dirname(file), base.replace(/\.rs$/, ''));
}

function buildTsConfig(file: string, all: Map<string, Record<string, unknown>>): TsConfig {
    const dir = path.dirname(file);
    let baseUrl: string | undefined;
    let paths: Record<string, string[]> | undefined;
    let pathsDir = dir;

    // Walk the `extends` chain: the nearest definition of each option wins.
    let current: string | undefined = file;
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
        visited.add(current);
        const json = all.get(current);
        if (!json) break;
        const options = (json.compilerOptions ?? {}) as { baseUrl?: string; paths?: Record<string, string[]> };
        const currentDir = path.dirname(current);
        if (baseUrl === undefined && typeof options.baseUrl === 'string') baseUrl = path.resolve(currentDir, options.baseUrl);
        if (paths === undefined && options.paths && typeof options.paths === 'object') {
            paths = options.paths;
            pathsDir = currentDir;
        }
        const ext = typeof json.extends === 'string' ? json.extends : undefined;
        current = ext && ext.startsWith('.') ? path.resolve(currentDir, ext.endsWith('.json') ? ext : `${ext}.json`) : undefined;
    }

    const entries = Object.entries(paths ?? {}).map(([pattern, targets]) => {
        const star = pattern.indexOf('*');
        return {
            prefix: star >= 0 ? pattern.slice(0, star) : pattern,
            suffix: star >= 0 ? pattern.slice(star + 1) : '',
            wildcard: star >= 0,
            targets: (Array.isArray(targets) ? targets : []).map((t) => (baseUrl ? t : path.resolve(pathsDir, t))),
        };
    });
    // Longest prefix first, like TypeScript.
    entries.sort((a, b) => b.prefix.length - a.prefix.length);
    return { dir, baseUrl, paths: entries };
}

/** JSON with comments and trailing commas (tsconfig style). */
export function parseJsonc(text: string): unknown {
    let out = '';
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            out += c;
            if (c === '\\') out += text[++i] ?? '';
            else if (c === '"') inString = false;
        } else if (c === '"') {
            inString = true;
            out += c;
        } else if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
            out += '\n';
        } else if (c === '/' && text[i + 1] === '*') {
            i += 2;
            while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
            i++;
        } else {
            out += c;
        }
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
}

function unique<T>(items: T[]): T[] {
    return [...new Set(items)];
}

function firstNonEmpty(...fns: Array<() => string[]>): string[] {
    for (const fn of fns) {
        const r = fn();
        if (r.length) return r;
    }
    return [];
}

function isWithin(file: string, dir: string): boolean {
    const rel = path.relative(dir, file);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function commonPrefixLength(a: string, b: string): number {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
}

export function toPosix(p: string): string {
    return p.split(path.sep).join('/');
}
