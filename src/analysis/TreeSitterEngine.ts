/**
 * Tree-sitter extraction. Host-agnostic: needs only a directory containing
 * the runtime (web-tree-sitter.cjs + .wasm) and the grammar .wasm files.
 *
 * One query per language captures definitions and imports. Definitions are
 * nested by byte range (no tree copying), and the native tree is freed as soon
 * as the facts are extracted.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Language, Node as SyntaxNode, Parser, Query } from 'web-tree-sitter';
import { FileAnalysis, ImportInfo, SymbolInfo, SymbolKind } from '../model';
import { DefKind, LanguagePack, containerKindsOf, grammarFor } from './languages';

type TreeSitterModule = typeof import('web-tree-sitter');

const KIND_MAP: Record<Exclude<DefKind, 'impl'>, SymbolKind> = {
    function: SymbolKind.Function,
    class: SymbolKind.Class,
    interface: SymbolKind.Interface,
    type: SymbolKind.Type,
    enum: SymbolKind.Enum,
    variable: SymbolKind.Variable,
    method: SymbolKind.Method,
    module: SymbolKind.Module,
};

/** Definition kinds that are only kept at top level (locals are noise). */
const TOP_LEVEL_ONLY: DefKind[] = ['variable', 'function', 'type', 'module'];

/**
 * When two patterns capture the same node (an arrow function is also a
 * variable; a Go struct is also a type spec), the more specific kind wins.
 */
const GENERIC_KINDS: DefKind[] = ['variable', 'type'];

/** Upper bound on FileAnalysis.references per file. */
const MAX_REFERENCES = 5000;

interface RawDef {
    kind: DefKind;
    node: SyntaxNode;
    name: string;
}

interface LoadedGrammar {
    language: Language;
    query: Query;
}

export interface EngineOptions {
    /** Directory with grammar .wasm files (and optionally the runtime). */
    grammarDir: string;
    /** Explicit path to web-tree-sitter.cjs; defaults to grammarDir, then node_modules. */
    runtimePath?: string;
    log?: (message: string) => void;
}

export class TreeSitterEngine {
    private readonly grammars = new Map<string, LoadedGrammar | null>();
    private readonly pending = new Map<string, Promise<LoadedGrammar | null>>();

    private constructor(
        private readonly ts: TreeSitterModule,
        private readonly parser: Parser,
        private readonly options: EngineOptions
    ) {}

    /** Returns undefined (and logs why) if the runtime can't be loaded. */
    static async create(options: EngineOptions): Promise<TreeSitterEngine | undefined> {
        const log = options.log ?? (() => undefined);
        try {
            const runtimePath = resolveRuntime(options);
            // Loaded by path at runtime: the vendored copy in parsers/ is what ships in the VSIX.
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const ts = require(runtimePath) as TreeSitterModule;
            const wasmPath = path.join(path.dirname(runtimePath), 'web-tree-sitter.wasm');
            await ts.Parser.init({
                locateFile: (file: string) => (file.endsWith('.wasm') && fs.existsSync(wasmPath) ? wasmPath : file),
            });
            return new TreeSitterEngine(ts, new ts.Parser(), options);
        } catch (err) {
            log(`tree-sitter runtime unavailable: ${(err as Error).message}`);
            return undefined;
        }
    }

    /** Grammar files that exist on disk, for diagnostics. */
    availableGrammars(): string[] {
        try {
            return fs.readdirSync(this.options.grammarDir).filter((f) => f.startsWith('tree-sitter-') && f.endsWith('.wasm'));
        } catch {
            return [];
        }
    }

    async analyze(source: string, filePath: string, pack: LanguagePack): Promise<FileAnalysis | undefined> {
        const ext = path.extname(filePath);
        const grammar = await this.loadGrammar(pack, grammarFor(pack, ext));
        if (!grammar) return undefined;

        this.parser.setLanguage(grammar.language);
        const tree = this.parser.parse(source);
        if (!tree) return undefined;
        try {
            return this.extract(tree.rootNode, filePath, pack, grammar.query);
        } finally {
            tree.delete();
        }
    }

    dispose(): void {
        for (const g of this.grammars.values()) g?.query.delete();
        this.grammars.clear();
        this.parser.delete();
    }

    private loadGrammar(pack: LanguagePack, file: string): Promise<LoadedGrammar | null> {
        const cached = this.grammars.get(file);
        if (cached !== undefined) return Promise.resolve(cached);
        let pending = this.pending.get(file);
        if (!pending) {
            pending = this.doLoadGrammar(pack, file).then((g) => {
                this.grammars.set(file, g);
                this.pending.delete(file);
                return g;
            });
            this.pending.set(file, pending);
        }
        return pending;
    }

    private async doLoadGrammar(pack: LanguagePack, file: string): Promise<LoadedGrammar | null> {
        const log = this.options.log ?? (() => undefined);
        const grammarPath = path.join(this.options.grammarDir, file);
        if (!fs.existsSync(grammarPath)) {
            log(`grammar missing for ${pack.id}: ${file} (regex fallback)`);
            return null;
        }
        try {
            const language = await this.ts.Language.load(grammarPath);
            const query = new this.ts.Query(language, pack.query);
            return { language, query };
        } catch (err) {
            log(`grammar/query failed for ${pack.id} (${file}): ${(err as Error).message}`);
            return null;
        }
    }

    private extract(root: SyntaxNode, filePath: string, pack: LanguagePack, query: Query): FileAnalysis {
        const defs: RawDef[] = [];
        const defIndex = new Map<number, number>();
        const importStmts = new Map<number, { stmt?: SyntaxNode; sources: string[] }>();
        const exportNames = new Set<string>();
        let namespace: string | undefined;

        for (const match of query.matches(root)) {
            let defCapture: { kind: DefKind; node: SyntaxNode } | undefined;
            let nameNode: SyntaxNode | undefined;
            let stmt: SyntaxNode | undefined;
            const sources: string[] = [];

            for (const { name, node } of match.captures) {
                if (name.startsWith('def.')) defCapture = { kind: name.slice(4) as DefKind, node };
                else if (name === 'name') nameNode = node;
                else if (name === 'import.source' || name === 'import.mod') {
                    sources.push(name === 'import.mod' ? `mod:${node.text}` : stripQuotes(node.text));
                } else if (name === 'import.stmt') stmt = node;
                else if (name === 'export.name') exportNames.add(node.text);
                else if (name === 'namespace' && namespace === undefined) namespace = node.text.trim();
            }

            if (defCapture && nameNode) {
                const def: RawDef = { kind: defCapture.kind, node: defCapture.node, name: cleanName(nameNode.text) };
                const existing = defIndex.get(def.node.id);
                if (existing === undefined) {
                    defIndex.set(def.node.id, defs.length);
                    defs.push(def);
                } else if (GENERIC_KINDS.includes(defs[existing].kind) && !GENERIC_KINDS.includes(def.kind)) {
                    defs[existing] = def;
                }
                continue;
            }

            if (stmt || sources.length > 0) {
                const key = (stmt ?? match.captures[0].node).id;
                const entry = importStmts.get(key) ?? { stmt, sources: [] };
                if (sources.length === 0 && stmt && pack.importsFromStatement) {
                    entry.sources.push(...pack.importsFromStatement(stmt));
                }
                for (const s of sources) {
                    entry.sources.push(...(pack.expandImport ? pack.expandImport(s, stmt) : [s]));
                }
                importStmts.set(key, entry);
            }
        }

        const symbols = this.buildSymbols(defs, pack, filePath, exportNames);
        const imports = this.buildImports(importStmts, pack, filePath);
        const references = pack.referenceNodeTypes ? collectReferences(root, pack.referenceNodeTypes) : undefined;

        return {
            filePath,
            language: pack.id,
            symbols,
            imports,
            exports: symbols.filter((s) => s.exported).map((s) => s.name),
            namespace,
            references,
            parser: 'tree-sitter',
        };
    }

    private buildSymbols(defs: RawDef[], pack: LanguagePack, filePath: string, exportNames: Set<string>): SymbolInfo[] {
        const containerKinds = containerKindsOf(pack);
        // Outer definitions first, so a stack walk yields each def's container.
        defs.sort((a, b) => a.node.startIndex - b.node.startIndex || b.node.endIndex - a.node.endIndex);

        const symbols: SymbolInfo[] = [];
        const stack: RawDef[] = [];
        for (const def of defs) {
            while (stack.length && stack[stack.length - 1].node.endIndex <= def.node.startIndex) stack.pop();
            const parent = stack[stack.length - 1];
            stack.push(def);
            if (def.kind === 'impl') continue;

            let kind = def.kind;
            let container: string | undefined;
            if (parent) {
                if (!containerKinds.includes(parent.kind)) continue; // local to a function / module body
                if (TOP_LEVEL_ONLY.includes(kind) && kind !== 'function') continue; // fields, nested aliases
                if (kind === 'function') kind = 'method';
                container = parent.name;
            } else if (kind === 'method') {
                container = pack.containerName?.(def.node);
                if (!container) continue; // e.g. methods of an object literal
            }

            const topLevel = !parent && kind !== 'method';
            const exported =
                pack.isExported({ node: def.node, name: def.name, kind, topLevel }) ||
                (topLevel && exportNames.has(def.name));

            symbols.push({
                name: def.name,
                kind: KIND_MAP[kind as Exclude<DefKind, 'impl'>],
                filePath,
                startLine: def.node.startPosition.row,
                endLine: def.node.endPosition.row,
                exported,
                ...(container ? { container } : {}),
            });
        }
        return symbols;
    }

    private buildImports(
        stmts: Map<number, { stmt?: SyntaxNode; sources: string[] }>,
        pack: LanguagePack,
        filePath: string
    ): ImportInfo[] {
        const imports: ImportInfo[] = [];
        const seen = new Set<string>();
        for (const { stmt, sources } of stmts.values()) {
            const details = stmt && pack.importDetails
                ? pack.importDetails(stmt)
                : { specifiers: [], isDefault: false, isNamespace: false };
            for (const source of sources) {
                if (!source || seen.has(source)) continue;
                seen.add(source);
                imports.push({ source, ...details, filePath, line: stmt?.startPosition.row });
            }
        }
        return imports;
    }
}

function resolveRuntime(options: EngineOptions): string {
    if (options.runtimePath) return options.runtimePath;
    const vendored = path.join(options.grammarDir, 'web-tree-sitter.cjs');
    if (fs.existsSync(vendored)) return vendored;
    return require.resolve('web-tree-sitter');
}

function stripQuotes(text: string): string {
    return text.trim().replace(/^['"`]|['"`]$/g, '');
}

/** Generic names like `Foo<T>` become `Foo`. */
function cleanName(text: string): string {
    const idx = text.indexOf('<');
    return (idx > 0 ? text.slice(0, idx) : text).trim();
}

function collectReferences(root: SyntaxNode, types: string[]): string[] {
    const wanted = new Set(types);
    const out = new Set<string>();
    const cursor = root.walk();
    try {
        for (;;) {
            if (cursor.gotoFirstChild()) continue;
            if (wanted.has(cursor.nodeType)) {
                out.add(cursor.nodeText);
                if (out.size >= MAX_REFERENCES) break;
            }
            if (cursor.gotoNextSibling()) continue;
            // climb until a sibling exists
            let climbed = false;
            while (cursor.gotoParent()) {
                if (cursor.gotoNextSibling()) {
                    climbed = true;
                    break;
                }
            }
            if (!climbed) break;
        }
    } finally {
        cursor.delete();
    }
    return [...out];
}
