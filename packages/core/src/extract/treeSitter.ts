/**
 * Tree-sitter extraction against the host-provided ParserRuntime. One query
 * per language captures definitions and imports; definitions are nested by
 * byte range (no tree copying), and the native tree is freed straight away.
 */
import { SymbolKind, type FileAnalysis, type ImportInfo, type SymbolInfo } from '@codearchy/protocol';
import { containerKindsOf, type DefKind, type LanguagePack, type SyntaxNode } from '@codearchy/sdk';
import { grammarFor } from '../languages/index.js';
import type { CompiledQuery, LanguageHandle, Logger, ParserRuntime } from '../ports.js';
import { extname } from '../util/posixPath.js';

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
    language: LanguageHandle;
    query: CompiledQuery;
}

export class TreeSitterExtractor {
    private readonly grammars = new Map<string, LoadedGrammar | null>();
    private readonly pending = new Map<string, Promise<LoadedGrammar | null>>();

    constructor(
        private readonly runtime: ParserRuntime,
        private readonly log: Logger = () => undefined
    ) {}

    /** Undefined when the pack's grammar or query is unavailable (caller falls back). */
    async analyze(source: string, filePath: string, pack: LanguagePack): Promise<FileAnalysis | undefined> {
        const grammar = await this.loadGrammar(pack, grammarFor(pack, extname(filePath)));
        if (!grammar) return undefined;
        const tree = this.runtime.parse(grammar.language, source);
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
        this.runtime.dispose();
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
        try {
            const language = await this.runtime.loadLanguage(file);
            if (!language) {
                this.log(`grammar missing for ${pack.id}: ${file} (regex fallback)`);
                return null;
            }
            return { language, query: this.runtime.compileQuery(language, pack.query) };
        } catch (err) {
            this.log(`grammar/query failed for ${pack.id} (${file}): ${(err as Error).message}`);
            return null;
        }
    }

    private extract(root: SyntaxNode, filePath: string, pack: LanguagePack, query: CompiledQuery): FileAnalysis {
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
                // Fields and nested aliases are dropped, unless the kind is itself a container (Ruby's nested modules).
                if (TOP_LEVEL_ONLY.includes(kind) && kind !== 'function' && !containerKinds.includes(kind)) continue;
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
