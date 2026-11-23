/**
 * Tier-3 extraction: line-based regexes used only when a tree-sitter grammar
 * is unavailable. Top-level declarations and imports only; good enough to
 * draw a module graph, not to reason about code.
 */
import { FileAnalysis, ImportInfo, SymbolInfo, SymbolKind } from '../model';
import { expandRustUse } from './languages';

interface Rule {
    re: RegExp;
    kind?: SymbolKind;
    /** Group holding the import source (import rules). */
    source?: number;
    /** Group holding the symbol name (definition rules). */
    name?: number;
    exported?: boolean;
    block?: 'brace' | 'indent' | 'none';
}

const TS_RULES: Rule[] = [
    { re: /^import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/, source: 1 },
    { re: /^export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/, source: 1 },
    { re: /(?:const|let|var)\s+[\w{}\s,]+=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/, source: 1 },
    { re: /^export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/, kind: SymbolKind.Function, name: 1, exported: true, block: 'brace' },
    { re: /^export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/, kind: SymbolKind.Class, name: 1, exported: true, block: 'brace' },
    { re: /^export\s+interface\s+(\w+)/, kind: SymbolKind.Interface, name: 1, exported: true, block: 'brace' },
    { re: /^export\s+type\s+(\w+)/, kind: SymbolKind.Type, name: 1, exported: true },
    { re: /^export\s+(?:const\s+)?enum\s+(\w+)/, kind: SymbolKind.Enum, name: 1, exported: true, block: 'brace' },
    { re: /^export\s+(?:const|let|var)\s+(\w+)/, kind: SymbolKind.Variable, name: 1, exported: true },
    { re: /^(?:async\s+)?function\s*\*?\s*(\w+)/, kind: SymbolKind.Function, name: 1, block: 'brace' },
    { re: /^(?:abstract\s+)?class\s+(\w+)/, kind: SymbolKind.Class, name: 1, block: 'brace' },
    { re: /^interface\s+(\w+)/, kind: SymbolKind.Interface, name: 1, block: 'brace' },
    { re: /^type\s+(\w+)/, kind: SymbolKind.Type, name: 1 },
    { re: /^(?:const\s+)?enum\s+(\w+)/, kind: SymbolKind.Enum, name: 1, block: 'brace' },
    { re: /^(?:const|let|var)\s+(\w+)/, kind: SymbolKind.Variable, name: 1 },
];

const RULES: Record<string, Rule[]> = {
    typescript: TS_RULES,
    javascript: TS_RULES,
    python: [
        { re: /^from\s+(\S+)\s+import\s/, source: 1 },
        { re: /^import\s+([\w.]+)/, source: 1 },
        { re: /^(?:async\s+)?def\s+(\w+)/, kind: SymbolKind.Function, name: 1, block: 'indent' },
        { re: /^class\s+(\w+)/, kind: SymbolKind.Class, name: 1, block: 'indent' },
    ],
    java: [
        { re: /^import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/, source: 1 },
        { re: /^(?:public\s+|protected\s+|private\s+)?(?:abstract\s+|final\s+|static\s+)*(?:class|record)\s+(\w+)/, kind: SymbolKind.Class, name: 1, block: 'brace' },
        { re: /^(?:public\s+)?(?:sealed\s+)?interface\s+(\w+)/, kind: SymbolKind.Interface, name: 1, block: 'brace' },
        { re: /^(?:public\s+)?enum\s+(\w+)/, kind: SymbolKind.Enum, name: 1, block: 'brace' },
    ],
    kotlin: [
        { re: /^import\s+([\w.]+(?:\.\*)?)/, source: 1 },
        { re: /^(?:(?:public|internal|private|open|abstract|data|sealed|enum)\s+)*(?:class|object|interface)\s+(\w+)/, kind: SymbolKind.Class, name: 1, block: 'brace' },
        { re: /^(?:(?:public|internal|private|suspend|inline)\s+)*fun\s+(?:<[^>]+>\s*)?(\w+)/, kind: SymbolKind.Function, name: 1, block: 'brace' },
    ],
    go: [
        { re: /^import\s+(?:\w+\s+)?"([^"]+)"/, source: 1 },
        { re: /^func\s+(\w+)/, kind: SymbolKind.Function, name: 1, block: 'brace' },
        { re: /^type\s+(\w+)\s+struct/, kind: SymbolKind.Class, name: 1, block: 'brace' },
        { re: /^type\s+(\w+)\s+interface/, kind: SymbolKind.Interface, name: 1, block: 'brace' },
    ],
    rust: [
        { re: /^(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+);/, source: 1 },
        { re: /^(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/, source: 1 },
        { re: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/, kind: SymbolKind.Function, name: 1, block: 'brace' },
        { re: /^(?:pub(?:\([^)]*\))?\s+)?struct\s+(\w+)/, kind: SymbolKind.Class, name: 1, block: 'brace' },
        { re: /^(?:pub(?:\([^)]*\))?\s+)?enum\s+(\w+)/, kind: SymbolKind.Enum, name: 1, block: 'brace' },
        { re: /^(?:pub(?:\([^)]*\))?\s+)?trait\s+(\w+)/, kind: SymbolKind.Interface, name: 1, block: 'brace' },
    ],
    csharp: [
        { re: /^(?:global\s+)?using\s+(?:static\s+)?(?:\w+\s*=\s*)?([\w.]+)\s*;/, source: 1 },
        { re: /^(?:(?:public|internal|private|protected|static|sealed|abstract|partial)\s+)*(?:class|struct|record)\s+(\w+)/, kind: SymbolKind.Class, name: 1, block: 'brace' },
        { re: /^(?:(?:public|internal|private|protected|partial)\s+)*interface\s+(\w+)/, kind: SymbolKind.Interface, name: 1, block: 'brace' },
        { re: /^(?:(?:public|internal|private|protected)\s+)*enum\s+(\w+)/, kind: SymbolKind.Enum, name: 1, block: 'brace' },
    ],
    php: [
        { re: /^use\s+\\?([\w\\]+)/, source: 1 },
        { re: /^(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?['"]([^'"]+)['"]/, source: 1 },
        { re: /^(?:(?:abstract|final|readonly)\s+)*class\s+(\w+)/, kind: SymbolKind.Class, name: 1, block: 'brace' },
        { re: /^(?:interface|trait)\s+(\w+)/, kind: SymbolKind.Interface, name: 1, block: 'brace' },
        { re: /^function\s+(\w+)/, kind: SymbolKind.Function, name: 1, block: 'brace' },
    ],
};

export function hasRegexFallback(language: string): boolean {
    return language in RULES;
}

export function analyzeWithRegex(source: string, filePath: string, language: string): FileAnalysis | undefined {
    const rules = RULES[language];
    if (!rules) return undefined;

    const lines = source.split(/\r?\n/);
    const symbols: SymbolInfo[] = [];
    const imports: ImportInfo[] = [];
    const seenImports = new Set<string>();
    let inGoImportBlock = false;

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed || /^(\/\/|#|\/\*|\*)/.test(trimmed)) continue;

        if (language === 'go') {
            if (/^import\s*\($/.test(trimmed)) {
                inGoImportBlock = true;
                continue;
            }
            if (inGoImportBlock) {
                if (trimmed === ')') inGoImportBlock = false;
                const m = trimmed.match(/^(?:\w+\s+)?"([^"]+)"/);
                if (m) addImport(imports, seenImports, m[1], filePath, i);
                continue;
            }
        }

        for (const rule of rules) {
            const m = trimmed.match(rule.re);
            if (!m) continue;
            if (rule.source !== undefined) {
                const raw = m[rule.source].trim();
                const sources = language !== 'rust'
                    ? [raw]
                    : /^(pub(\([^)]*\))?\s+)?mod\s/.test(trimmed)
                        ? [`mod:${raw}`]
                        : expandRustUse(raw);
                for (const src of sources) addImport(imports, seenImports, src, filePath, i);
            } else if (rule.kind && rule.name !== undefined) {
                const endLine = rule.block === 'brace'
                    ? findBraceBlockEnd(lines, i)
                    : rule.block === 'indent'
                        ? findIndentBlockEnd(lines, i)
                        : i;
                symbols.push({
                    name: m[rule.name],
                    kind: rule.kind,
                    filePath,
                    startLine: i,
                    endLine,
                    exported: rule.exported ?? defaultExported(language, m[rule.name], trimmed),
                });
            }
            break;
        }
    }

    return {
        filePath,
        language,
        symbols,
        imports,
        exports: symbols.filter((s) => s.exported).map((s) => s.name),
        parser: 'regex',
    };
}

function addImport(imports: ImportInfo[], seen: Set<string>, source: string, filePath: string, line: number) {
    if (seen.has(source)) return;
    seen.add(source);
    imports.push({ source, specifiers: [], isDefault: false, isNamespace: false, filePath, line });
}

function defaultExported(language: string, name: string, line: string): boolean {
    switch (language) {
        case 'go':
            return /^[A-Z]/.test(name);
        case 'python':
            return !name.startsWith('_');
        case 'rust':
            return /^pub\b/.test(line);
        case 'java':
        case 'csharp':
            return /\bpublic\b/.test(line);
        case 'kotlin':
            return !/\b(private|internal)\b/.test(line);
        case 'php':
            return true;
        default:
            return false;
    }
}

function findBraceBlockEnd(lines: string[], start: number): number {
    let depth = 0;
    let opened = false;
    for (let i = start; i < lines.length; i++) {
        for (const ch of lines[i]) {
            if (ch === '{') {
                depth++;
                opened = true;
            } else if (ch === '}') {
                depth--;
                if (opened && depth === 0) return i;
            }
        }
    }
    return start;
}

function findIndentBlockEnd(lines: string[], start: number): number {
    const base = lines[start].search(/\S/);
    let last = start;
    for (let i = start + 1; i < lines.length; i++) {
        if (lines[i].trim() === '') continue;
        if (lines[i].search(/\S/) <= base) break;
        last = i;
    }
    return last;
}
