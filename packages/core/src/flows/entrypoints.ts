/**
 * Entrypoints: where execution enters the system from outside — HTTP routes,
 * CLI commands, jobs and listeners, UI routes and `main`. Found by a table of
 * per-line rules (framework conventions) plus a few file-path conventions
 * (Next.js, SvelteKit). Every pattern is anchored to short literals with
 * bounded repetition, and lines longer than MAX_LINE are skipped, so a scan is
 * linear in the file size.
 *
 * A rule names its handler (`router.post('/login', auth.login)`), binds the
 * function it decorates (`@app.get("/")` + `def index`), or marks the handler
 * inline (`app.get('/', (req, res) => { … })`), in which case the entry's
 * `endLine` closes its body so the tracer can take the calls inside.
 */
import { SymbolKind, type EntryPoint, type EntryPointKind, type FileAnalysis, type SymbolInfo } from '@codearchy/protocol';

const MAX_LINE = 600;
const MAX_ENTRIES = 200;
/** How far below a decorator the function it decorates may start. */
const DECORATOR_REACH = 6;
const BLOCK_REACH = 400;

const JS = new Set(['typescript', 'javascript']);
const HASH_COMMENTS = new Set(['python', 'ruby', 'php']);

/** Comment lines hold examples (`// app.get('/x', …)`), not declarations. */
function isCommentLine(line: string, language: string): boolean {
    const t = line.trimStart();
    return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || (HASH_COMMENTS.has(language) && t.startsWith('#') && !t.startsWith('#['));
}

type Binding =
    /** The handler is named on the line. */
    | { to: 'named'; name: string }
    /** The next function below (a decorator or attribute). */
    | { to: 'next' }
    /** An inline function: its body is the bracket at `col` of line `at` (default: the entry's line); col -1 = a Python block. */
    | { to: 'inline'; col: number; at?: number }
    /** A method of the class the line belongs to (`handle`, `perform`). */
    | { to: 'method'; names: string[] }
    | { to: 'none' };

interface Hit {
    kind: EntryPointKind;
    framework: string;
    /** Label; `{fn}` is replaced by the bound function's name. */
    label: string;
    bind: Binding;
    /** An HTTP route that joins the class-level prefix (Nest, Spring, ASP.NET, Symfony). */
    prefixed?: boolean;
}

interface Ctx {
    lines: string[];
    index: number;
    imports: string[];
    analysis: FileAnalysis;
    /** Class-level route prefix for the lines below it. */
    setPrefix(prefix: string): void;
}

type Rule = (line: string, ctx: Ctx) => Hit | undefined;

const imported = (ctx: Ctx, ...names: string[]) => ctx.imports.some((s) => names.some((n) => s === n || s.startsWith(`${n}/`) || s.startsWith(`${n}.`)));
const upper = (m: string) => m.toUpperCase();
/** A class declaration within the next few lines: the annotation above it is class-level. */
const classFollows = (ctx: Ctx) => ctx.lines.slice(ctx.index + 1, ctx.index + 5).some((l) => /\bclass\s/.test(l));

/** The handler argument at the end of a call: a name (`auth.login`), inline, or nothing. */
function handlerArg(rest: string, line: string, restStart: number): Binding {
    if (/=>|\bfunc(?:tion)?\s{0,2}\(|\bfn\s{0,2}\(|\blambda\b|\bdo\s{0,2}(?:\||$)/.test(rest) || /[,(]\s{0,4}$/.test(rest)) {
        const open = line.lastIndexOf('(', restStart);
        return { to: 'inline', col: open >= 0 ? open : restStart };
    }
    const m = /([A-Za-z_$][\w$.:]{0,80})\s{0,4}\)\s{0,4}[;,]?\s{0,4}$/.exec(rest);
    return m && !/^(true|false|null|nil|None)$/.test(m[1]) ? { to: 'named', name: m[1] } : { to: 'none' };
}

const jsHttpFramework = (ctx: Ctx) =>
    imported(ctx, 'hono') ? 'hono' : imported(ctx, 'fastify') ? 'fastify' : imported(ctx, 'koa', '@koa/router', 'koa-router') ? 'koa' : 'express';

// ─── rules by language ──────────────────────────────────────────────────────

const JS_RULES: Rule[] = [
    // Express, Koa, Hono, Fastify: `app.get('/x', handler)`, `router.post(...)`.
    (line, ctx) => {
        const m = /\b([A-Za-z_$][\w$]{0,40})\.(get|post|put|patch|delete|head|options|all)\(\s{0,4}(['"`])(\/[^'"`]{0,200})\3/.exec(line);
        if (!m || !/^(app|server|fastify|hono|routes?|r)$|[Rr]outer$|[Rr]outes$|App$/.test(m[1]) || m[4].includes('${')) return undefined;
        const restStart = m.index + m[0].length;
        const rest = line.slice(restStart);
        // A client call (`http.get('/users')`, `get('/x', { params })`) has no handler argument.
        if (!/^\s{0,4},/.test(rest) || /^\s{0,4},\s{0,4}\{/.test(rest)) return undefined;
        return { kind: 'http', framework: jsHttpFramework(ctx), label: `${m[2] === 'all' ? 'ANY' : upper(m[2])} ${m[4]}`, bind: handlerArg(rest, line, restStart) };
    },
    // NestJS
    (line, ctx) => {
        const c = /@Controller\(\s{0,4}(?:(['"`])([^'"`]{0,200})\1|\{[^}]{0,200}?path:\s{0,4}(['"`])([^'"`]{0,200})\3)?/.exec(line);
        if (c) ctx.setPrefix(c[2] ?? c[4] ?? '');
        const m = /@(Get|Post|Put|Patch|Delete|All|Head|Options)\(\s{0,4}(?:(['"`])([^'"`]{0,200})\2)?\s{0,4}\)/.exec(line);
        if (m) return { kind: 'http', framework: 'nestjs', label: `${m[1] === 'All' ? 'ANY' : upper(m[1])} ${m[3] ?? ''}`, bind: { to: 'next' }, prefixed: true };
        const e = /@(MessagePattern|EventPattern|OnEvent)\(\s{0,4}(?:\{[^}]{0,80}?:\s{0,4})?(['"`])([^'"`]{0,200})\2/.exec(line);
        if (e) return { kind: 'event', framework: 'nestjs', label: e[3], bind: { to: 'next' } };
        const j = /@(Cron|Interval|Timeout|Process)\(/.exec(line);
        if (j) return { kind: 'job', framework: 'nestjs', label: '{fn}', bind: { to: 'next' } };
        return undefined;
    },
    // React Router: `<Route path="/x" element={<Page />} />` and route objects.
    (line) => {
        const m = /<Route\b[^>]{0,300}?\bpath=\{?\s{0,4}(['"`])([^'"`]{0,200})\1/.exec(line);
        if (m) {
            const h = /\b(?:element=\{\s{0,4}<\s{0,4}|component=\{\s{0,4}|Component=\{\s{0,4})([A-Z][\w.]{0,60})/.exec(line);
            return { kind: 'ui', framework: 'react-router', label: m[2] || '/', bind: h ? { to: 'named', name: h[1] } : { to: 'none' } };
        }
        const o = /\bpath:\s{0,4}(['"`])([^'"`]{0,200})\1.{0,200}?\b(?:element|component|Component):\s{0,4}<?\s{0,4}([A-Z][\w.]{0,60})/.exec(line);
        return o ? { kind: 'ui', framework: 'router', label: o[2] || '/', bind: { to: 'named', name: o[3] } } : undefined;
    },
    // commander / yargs: `.command('deploy <env>')` with its `.action(...)` below.
    (line, ctx) => {
        const m = /\.command\(\s{0,4}(['"`])([\w:-][^'"`]{0,100})\1/.exec(line);
        if (!m || !imported(ctx, 'commander', 'yargs', 'sade', 'cac')) return undefined;
        const framework = imported(ctx, 'yargs') ? 'yargs' : imported(ctx, 'commander') ? 'commander' : 'cli';
        const label = m[2].split(/\s/)[0];
        for (let k = ctx.index; k < Math.min(ctx.lines.length, ctx.index + 40); k++) {
            const l = ctx.lines[k];
            if (k > ctx.index && /\.command\(/.test(l)) break;
            const a = /\.action\(/.exec(l);
            if (!a) continue;
            const restStart = a.index + a[0].length;
            const bind = handlerArg(l.slice(restStart), l, restStart);
            return { kind: 'cli', framework, label, bind: bind.to === 'inline' ? { ...bind, at: k } : bind };
        }
        return { kind: 'cli', framework, label, bind: { to: 'none' } };
    },
    // VS Code commands and MCP tools: `registerCommand('id', handler)`, `server.registerTool('name', {…}, handler)`.
    (line, ctx) => {
        const m = /\.(registerCommand|registerTextEditorCommand|registerTool|tool)\(\s{0,4}(?:(['"`])([^'"`]{1,100})\2)?/.exec(line);
        if (!m) return undefined;
        const vscode = m[1] !== 'registerTool' && m[1] !== 'tool';
        if (vscode ? !imported(ctx, 'vscode') : !imported(ctx, '@modelcontextprotocol/sdk')) return undefined;
        const name = m[3] ?? /^\s{0,24}(['"`])([^'"`]{1,100})\1\s{0,4},/.exec(ctx.lines[ctx.index + 1] ?? '')?.[2];
        if (!name) return undefined;
        const open = m.index + m[0].indexOf('(');
        const restStart = m.index + m[0].length;
        const bind = m[3] ? handlerArg(line.slice(restStart), line, restStart) : { to: 'inline' as const, col: open };
        return vscode
            ? { kind: 'cli', framework: 'vscode', label: name, bind }
            : { kind: 'event', framework: 'mcp', label: name, bind: bind.to === 'inline' ? { ...bind, col: open } : bind };
    },
    // BullMQ workers, node-cron
    (line, ctx) => {
        const w = /\bnew\s{1,4}Worker\(\s{0,4}(['"`])([^'"`]{0,100})\1\s{0,4},/.exec(line);
        if (w && imported(ctx, 'bullmq', 'bull')) {
            const restStart = w.index + w[0].length;
            return { kind: 'job', framework: 'bullmq', label: w[2], bind: handlerArg(line.slice(restStart), line, restStart) };
        }
        const c = /\bcron\.schedule\(\s{0,4}(['"`])([^'"`]{0,60})\1/.exec(line);
        if (c) return { kind: 'job', framework: 'node-cron', label: c[2], bind: { to: 'inline', col: c.index + c[0].indexOf('(') } };
        return undefined;
    },
];

const PY_RULES: Rule[] = [
    // FastAPI, Flask, Sanic…: `@app.get("/x")`, `@bp.route("/x", methods=["POST"])`, under a router's prefix.
    (line, ctx) => {
        const p = /\b(?:APIRouter|Blueprint)\([^)]{0,200}?\b(?:url_)?prefix\s{0,2}=\s{0,2}[rf]?(['"])([^'"]{0,200})\1/.exec(line);
        if (p) {
            ctx.setPrefix(p[2]);
            return undefined;
        }
        const m = /^\s{0,16}@(\w{1,40})\.(get|post|put|patch|delete|head|options|route|websocket|api_route)\(\s{0,4}(?:path\s{0,2}=\s{0,2})?[rf]?(['"])([^'"]{0,200})\3(.{0,300})$/.exec(line);
        if (!m) return undefined;
        let method = upper(m[2]);
        if (m[2] === 'route' || m[2] === 'api_route') method = /methods\s{0,2}=\s{0,2}[[(]\s{0,2}['"](\w{1,10})/.exec(m[5])?.[1].toUpperCase() ?? (m[2] === 'route' ? 'GET' : 'ANY');
        if (m[2] === 'websocket') method = 'WS';
        const framework = imported(ctx, 'fastapi') ? 'fastapi' : imported(ctx, 'flask') ? 'flask' : imported(ctx, 'sanic') ? 'sanic' : imported(ctx, 'quart') ? 'quart' : m[2] === 'route' ? 'flask' : 'fastapi';
        return { kind: 'http', framework, label: `${method} ${m[4]}`, bind: { to: 'next' }, prefixed: true };
    },
    // Django URLconf: `path("login/", views.login)`.
    (line, ctx) => {
        const m = /^\s{0,16}(?:re_)?path\(\s{0,4}r?(['"])([^'"]{0,200})\1\s{0,4},\s{0,4}([\w.]{1,80})/.exec(line);
        if (!m || m[3] === 'include' || !(imported(ctx, 'django') || /(^|\/)urls\.py$/.test(ctx.analysis.filePath))) return undefined;
        const view = /\.as_view$/.test(m[3]) ? m[3].slice(0, -'.as_view'.length) : m[3];
        return { kind: 'http', framework: 'django', label: `ANY /${m[2].replace(/^\^?\/?/, '').replace(/\$$/, '')}`, bind: { to: 'named', name: view } };
    },
    // click / typer
    (line, ctx) => {
        const m = /^\s{0,16}@(\w{1,40})\.command\(\s{0,4}(?:name\s{0,2}=\s{0,2})?(?:(['"])([^'"]{0,100})\2)?/.exec(line);
        if (!m) return undefined;
        const framework = imported(ctx, 'typer') ? 'typer' : 'click';
        return { kind: 'cli', framework, label: m[3] ?? '{fn}', bind: { to: 'next' } };
    },
    (line) => {
        const m = /\badd_parser\(\s{0,4}(['"])([^'"]{0,60})\1/.exec(line);
        return m ? { kind: 'cli', framework: 'argparse', label: m[2], bind: { to: 'none' } } : undefined;
    },
    // Celery, Dramatiq, RQ
    (line) => {
        if (/^\s{0,16}@(?:\w{1,40}\.task|shared_task|periodic_task)\b/.test(line)) return { kind: 'job', framework: 'celery', label: '{fn}', bind: { to: 'next' } };
        if (/^\s{0,16}@(?:dramatiq\.actor|actor)\b/.test(line)) return { kind: 'job', framework: 'dramatiq', label: '{fn}', bind: { to: 'next' } };
        return undefined;
    },
    (line) =>
        /^if\s{1,4}__name__\s{0,4}==\s{0,4}(['"])__main__\1\s{0,4}:/.test(line)
            ? { kind: 'main', framework: 'python', label: 'main', bind: { to: 'inline', col: -1 } }
            : undefined,
];

const SPRING_METHOD = /method\s{0,4}=\s{0,4}\{?\s{0,4}(?:RequestMethod\.)?(GET|POST|PUT|PATCH|DELETE)/;

const JVM_RULES: Rule[] = [
    // Spring MVC / WebFlux
    (line, ctx) => {
        const m = /@(Get|Post|Put|Patch|Delete|Request)Mapping\b(?:\(\s{0,4}(?:(?:value|path)\s{0,4}=\s{0,4})?(?:[{[]\s{0,4})?"([^"]{0,200})")?/.exec(line);
        if (!m) return undefined;
        if (m[1] === 'Request' && classFollows(ctx)) {
            ctx.setPrefix(m[2] ?? '');
            return undefined;
        }
        const method = m[1] === 'Request' ? (SPRING_METHOD.exec(line)?.[1] ?? 'ANY') : upper(m[1]);
        return { kind: 'http', framework: 'spring', label: `${method} ${m[2] ?? ''}`, bind: { to: 'next' }, prefixed: true };
    },
    (line) => {
        if (/@Scheduled\b/.test(line)) return { kind: 'job', framework: 'spring', label: '{fn}', bind: { to: 'next' } };
        const l = /@(KafkaListener|RabbitListener|JmsListener|SqsListener|StreamListener)\b(?:\((?:[^)]{0,200}?(?:topics|queues|destination|value)\s{0,4}=\s{0,4})?\{?\s{0,4}"([^"]{0,100})")?/.exec(line);
        if (l) return { kind: 'event', framework: l[1].replace(/Listener$/, '').toLowerCase(), label: l[2] ?? '{fn}', bind: { to: 'next' } };
        if (/@EventListener\b/.test(line)) return { kind: 'event', framework: 'spring', label: '{fn}', bind: { to: 'next' } };
        return undefined;
    },
    (line) => {
        const m = /@Command\(\s{0,4}name\s{0,4}=\s{0,4}"([^"]{0,60})"/.exec(line);
        return m ? { kind: 'cli', framework: 'picocli', label: m[1], bind: { to: 'method', names: ['call', 'run'] } } : undefined;
    },
    (line) =>
        /\bstatic\s{1,4}void\s{1,4}main\s{0,4}\(/.test(line) || /^\s{0,4}fun\s{1,4}main\s{0,4}\(/.test(line)
            ? { kind: 'main', framework: 'jvm', label: 'main', bind: { to: 'named', name: 'main' } }
            : undefined,
];

const CS_RULES: Rule[] = [
    // ASP.NET Core MVC: `[Route("api/[controller]")]` + `[HttpGet("{id}")]`.
    (line, ctx) => {
        const r = /\[Route\(\s{0,4}"([^"]{0,200})"/.exec(line);
        if (r && classFollows(ctx)) {
            const cls = ctx.lines.slice(ctx.index + 1, ctx.index + 5).join(' ').match(/\bclass\s{1,4}(\w{1,80})/)?.[1] ?? '';
            ctx.setPrefix(r[1].replace('[controller]', cls.replace(/Controller$/, '').toLowerCase()));
        }
        const m = /\[Http(Get|Post|Put|Patch|Delete)(?:\(\s{0,4}"([^"]{0,200})")?/.exec(line);
        return m ? { kind: 'http', framework: 'aspnet', label: `${upper(m[1])} ${m[2] ?? ''}`, bind: { to: 'next' }, prefixed: true } : undefined;
    },
    // Minimal APIs: `app.MapGet("/x", handler)`.
    (line) => {
        const m = /\.Map(Get|Post|Put|Patch|Delete)\(\s{0,4}"([^"]{0,200})"\s{0,4},/.exec(line);
        if (!m) return undefined;
        const restStart = m.index + m[0].length;
        return { kind: 'http', framework: 'aspnet', label: `${upper(m[1])} ${m[2]}`, bind: handlerArg(line.slice(restStart), line, restStart) };
    },
    (line) => {
        const f = /\[(?:FunctionName|Function)\(\s{0,4}(?:nameof\((\w{1,80})\)|"([^"]{0,100})")/.exec(line);
        if (f) return { kind: 'job', framework: 'azure-functions', label: f[2] ?? f[1], bind: { to: 'next' } };
        const b = /\bclass\s{1,4}(\w{1,80})[^{]{0,200}:\s{0,4}(?:BackgroundService|IHostedService)\b/.exec(line);
        if (b) return { kind: 'job', framework: 'hosted-service', label: b[1], bind: { to: 'method', names: ['ExecuteAsync', 'StartAsync'] } };
        return undefined;
    },
    (line) =>
        /\bstatic\s{1,4}(?:async\s{1,4})?(?:void|int|Task(?:<int>)?)\s{1,4}Main\s{0,4}\(/.test(line)
            ? { kind: 'main', framework: 'dotnet', label: 'main', bind: { to: 'named', name: 'Main' } }
            : undefined,
];

const GO_HTTP = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /;

const GO_RULES: Rule[] = [
    // net/http (with Go 1.22 method patterns) and gorilla/mux
    (line) => {
        const m = /\b\w{1,30}\.(HandleFunc|Handle)\(\s{0,4}"([^"]{0,200})"\s{0,4},/.exec(line);
        if (!m) return undefined;
        const restStart = m.index + m[0].length;
        const label = GO_HTTP.test(m[2]) ? m[2] : `ANY ${m[2]}`;
        return { kind: 'http', framework: 'net/http', label, bind: handlerArg(line.slice(restStart), line, restStart) };
    },
    // gin, echo, fiber, chi
    (line, ctx) => {
        const m = /\b\w{1,30}\.(GET|POST|PUT|PATCH|DELETE|Any|Get|Post|Put|Patch|Delete)\(\s{0,4}"(\/[^"]{0,200})"\s{0,4},/.exec(line);
        if (!m) return undefined;
        const restStart = m.index + m[0].length;
        const framework = imported(ctx, 'github.com/gin-gonic/gin') ? 'gin' : imported(ctx, 'github.com/labstack/echo') ? 'echo' : imported(ctx, 'github.com/gofiber/fiber') ? 'fiber' : imported(ctx, 'github.com/go-chi/chi') ? 'chi' : 'go';
        return { kind: 'http', framework, label: `${m[1] === 'Any' ? 'ANY' : upper(m[1])} ${m[2]}`, bind: handlerArg(line.slice(restStart), line, restStart) };
    },
    // cobra: `Use: "deploy [env]"` with `RunE: runDeploy` below.
    (line, ctx) => {
        const m = /\bUse:\s{0,4}"([\w:-]{1,60})/.exec(line);
        if (!m) return undefined;
        for (let k = ctx.index; k < Math.min(ctx.lines.length, ctx.index + 15); k++) {
            const r = /\bRunE?:\s{0,4}([\w.]{1,80})/.exec(ctx.lines[k]);
            if (!r) continue;
            if (r[1] === 'func') return { kind: 'cli', framework: 'cobra', label: m[1], bind: { to: 'inline', col: Math.max(0, ctx.lines[k].lastIndexOf('{')), at: k } };
            return { kind: 'cli', framework: 'cobra', label: m[1], bind: { to: 'named', name: r[1] } };
        }
        return { kind: 'cli', framework: 'cobra', label: m[1], bind: { to: 'none' } };
    },
    (line, ctx) =>
        ctx.analysis.namespace === 'main' && /^func\s{1,4}main\s{0,4}\(\s{0,4}\)/.test(line)
            ? { kind: 'main', framework: 'go', label: 'main', bind: { to: 'named', name: 'main' } }
            : undefined,
];

const RUST_RULES: Rule[] = [
    (line, ctx) => {
        const m = /#\[(get|post|put|patch|delete)\(\s{0,4}"([^"]{0,200})"/.exec(line);
        return m ? { kind: 'http', framework: imported(ctx, 'rocket') ? 'rocket' : 'actix', label: `${upper(m[1])} ${m[2]}`, bind: { to: 'next' } } : undefined;
    },
    (line) => {
        const m = /\.route\(\s{0,4}"([^"]{0,200})"\s{0,4},\s{0,4}(get|post|put|patch|delete|any)\(\s{0,4}([\w:]{1,80})/.exec(line);
        return m ? { kind: 'http', framework: 'axum', label: `${m[2] === 'any' ? 'ANY' : upper(m[2])} ${m[1]}`, bind: { to: 'named', name: m[3] } } : undefined;
    },
    (line) =>
        /^\s{0,4}(?:pub\s{1,4})?(?:async\s{1,4})?fn\s{1,4}main\s{0,4}\(/.test(line)
            ? { kind: 'main', framework: 'rust', label: 'main', bind: { to: 'named', name: 'main' } }
            : undefined,
];

const PHP_RULES: Rule[] = [
    // Laravel routes
    (line) => {
        const m = /Route::(get|post|put|patch|delete|any|options)\(\s{0,4}(['"])([^'"]{0,200})\2\s{0,4},/.exec(line);
        if (!m) return undefined;
        const restStart = m.index + m[0].length;
        const rest = line.slice(restStart);
        const label = `${m[1] === 'any' ? 'ANY' : upper(m[1])} /${m[3].replace(/^\//, '')}`;
        const arr = /\[\s{0,4}[\w\\]{1,80}::class\s{0,4},\s{0,4}['"](\w{1,80})['"]/.exec(rest);
        const at = /['"][\w\\]{1,80}@(\w{1,80})['"]/.exec(rest);
        const invokable = /^\s{0,4}[\w\\]{1,80}::class\s{0,4}\)/.exec(rest);
        const bind: Binding = arr
            ? { to: 'named', name: arr[1] }
            : at
              ? { to: 'named', name: at[1] }
              : invokable
                ? { to: 'named', name: '__invoke' }
                : handlerArg(rest, line, restStart);
        return { kind: 'http', framework: 'laravel', label, bind };
    },
    // Symfony
    (line, ctx) => {
        const m = /#\[Route\(\s{0,4}(?:path:\s{0,4})?(['"])([^'"]{0,200})\1(.{0,200})$/.exec(line);
        if (!m) return undefined;
        if (classFollows(ctx)) {
            ctx.setPrefix(m[2]);
            return undefined;
        }
        const method = /methods:\s{0,4}\[\s{0,4}['"](\w{1,10})/.exec(m[3])?.[1].toUpperCase() ?? 'ANY';
        return { kind: 'http', framework: 'symfony', label: `${method} ${m[2]}`, bind: { to: 'next' }, prefixed: true };
    },
    (line) => {
        const s = /protected\s{1,4}\$signature\s{0,4}=\s{0,4}(['"])([\w:-]{1,80})/.exec(line);
        if (s) return { kind: 'cli', framework: 'laravel', label: s[2], bind: { to: 'method', names: ['handle'] } };
        const a = /#\[AsCommand\(\s{0,4}(?:name:\s{0,4})?(['"])([\w:-]{1,80})\1/.exec(line);
        if (a) return { kind: 'cli', framework: 'symfony', label: a[2], bind: { to: 'method', names: ['execute', '__invoke'] } };
        const j = /\bclass\s{1,4}(\w{1,80})[^{]{0,200}\bimplements\b[^{]{0,200}\bShouldQueue\b/.exec(line);
        if (j) return { kind: 'job', framework: 'laravel', label: j[1], bind: { to: 'method', names: ['handle'] } };
        return undefined;
    },
];

const RUBY_RULES: Rule[] = [
    // Rails routes and Sinatra
    (line, ctx) => {
        const m = /^\s{0,16}(get|post|put|patch|delete|match)\s{1,4}\(?\s{0,4}(['"])([^'"]{0,200})\2(.{0,200})$/.exec(line);
        if (!m) return undefined;
        const rails = /(^|\/)config\/routes\.rb$/.test(ctx.analysis.filePath);
        const to = /to:\s{0,4}['"](\w{1,60})#(\w{1,60})['"]/.exec(m[4]);
        const label = `${m[1] === 'match' ? 'ANY' : upper(m[1])} /${m[3].replace(/^\//, '')}`;
        if (rails) return { kind: 'http', framework: 'rails', label, bind: to ? { to: 'named', name: to[2] } : { to: 'none' } };
        return /\bdo\b/.test(m[4]) ? { kind: 'http', framework: 'sinatra', label, bind: { to: 'none' } } : undefined;
    },
    (line, ctx) => {
        const m = /^\s{0,16}resources?\s{1,4}:(\w{1,60})/.exec(line);
        return m && /(^|\/)config\/routes\.rb$/.test(ctx.analysis.filePath) ? { kind: 'http', framework: 'rails', label: `resources /${m[1]}`, bind: { to: 'none' } } : undefined;
    },
    (line, ctx) => {
        if (/^\s{0,16}include\s{1,4}Sidekiq::(?:Worker|Job)\b/.test(line)) {
            const cls = [...ctx.lines.slice(Math.max(0, ctx.index - 10), ctx.index)].reverse().join('\n').match(/\bclass\s{1,4}([\w:]{1,80})/)?.[1];
            return { kind: 'job', framework: 'sidekiq', label: cls ?? 'worker', bind: { to: 'method', names: ['perform'] } };
        }
        const a = /\bclass\s{1,4}([\w:]{1,80})\s{0,4}<\s{0,4}(?:ApplicationJob|ActiveJob::Base)\b/.exec(line);
        if (a) return { kind: 'job', framework: 'activejob', label: a[1], bind: { to: 'method', names: ['perform'] } };
        const t = /^\s{0,16}desc\s{1,4}(['"])([\w:-]{1,60})\1/.exec(line);
        if (t && ctx.imports.some((s) => s === 'thor')) return { kind: 'cli', framework: 'thor', label: t[2], bind: { to: 'next' } };
        return undefined;
    },
];

const RULES: Record<string, Rule[]> = {
    typescript: JS_RULES,
    javascript: JS_RULES,
    python: PY_RULES,
    java: JVM_RULES,
    kotlin: JVM_RULES,
    csharp: CS_RULES,
    go: GO_RULES,
    rust: RUST_RULES,
    php: PHP_RULES,
    ruby: RUBY_RULES,
};

// ─── file conventions ───────────────────────────────────────────────────────

const HTTP_EXPORTS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** `app/(shop)/api/users/[id]/route.ts` → `/api/users/[id]`. */
function routeFromSegments(segments: string): string {
    const parts = segments.split('/').filter((p) => p && !/^\(.*\)$/.test(p) && !p.startsWith('@'));
    return `/${parts.join('/')}`;
}

function fileConventions(a: FileAnalysis): EntryPoint[] {
    if (!JS.has(a.language)) return [];
    const out: EntryPoint[] = [];
    const exported = a.symbols.filter((s) => s.exported && (s.kind === SymbolKind.Function || s.kind === SymbolKind.Variable));
    const route = /(?:^|\/)app\/((?:[^/]+\/)*?)route\.[jt]sx?$/.exec(a.filePath) ?? /(?:^|\/)src\/routes\/((?:[^/]+\/)*?)\+server\.[jt]s$/.exec(a.filePath);
    if (route) {
        const framework = a.filePath.includes('+server.') ? 'sveltekit' : 'nextjs';
        for (const s of exported) {
            if (HTTP_EXPORTS.has(s.name)) out.push({ kind: 'http', framework, label: `${s.name} ${routeFromSegments(route[1])}`, line: s.startLine, handler: s.name });
        }
        return out;
    }
    const api = /(?:^|\/)pages\/api\/(.+)\.[jt]sx?$/.exec(a.filePath);
    if (api) {
        const main = exported.find((s) => s.kind === SymbolKind.Function) ?? exported[0];
        const path = routeFromSegments(`api/${api[1].replace(/(^|\/)index$/, '')}`);
        out.push({ kind: 'http', framework: 'nextjs', label: `ANY ${path}`, line: main?.startLine ?? 0, ...(main ? { handler: main.name } : {}) });
        return out;
    }
    const page = /(?:^|\/)app\/((?:[^/]+\/)*?)page\.[jt]sx$/.exec(a.filePath);
    if (page) {
        const main = exported.find((s) => s.kind === SymbolKind.Function) ?? exported[0];
        out.push({ kind: 'ui', framework: 'nextjs', label: routeFromSegments(page[1]), line: main?.startLine ?? 0, ...(main ? { handler: main.name } : {}) });
    }
    return out;
}

// ─── scanning ───────────────────────────────────────────────────────────────

const CALLABLE = new Set<string>([SymbolKind.Function, SymbolKind.Method]);

/** Test code registers routes too (supertest, fixtures); they aren't the system's entrypoints. */
export function isTestPath(path: string): boolean {
    return /(?:^|\/)(?:tests?|__tests__|spec|e2e)\//.test(path) || /\.(?:test|spec)\.\w+$/.test(path) || /_test\.go$/.test(path) || /(?:^|\/)test_\w+\.py$/.test(path);
}

/**
 * The last line of a bracketed body starting at `line`/`col` (the first
 * opener at or after it), skipping string literals. Approximate; bounded.
 */
export function blockEnd(lines: string[], line: number, col: number): number {
    let depth = 0;
    let opened = false;
    let quote = 0;
    for (let l = line; l < Math.min(lines.length, line + BLOCK_REACH); l++) {
        const text = lines[l];
        for (let i = l === line ? Math.max(0, col) : 0; i < text.length; i++) {
            const c = text.charCodeAt(i);
            if (quote) {
                if (c === 92) i++;
                else if (c === quote) quote = 0;
                continue;
            }
            if (c === 47 && text.charCodeAt(i + 1) === 47) break; // a line comment
            if (c === 34 || c === 39 || c === 96) quote = c;
            else if (c === 40 || c === 123 || c === 91) {
                depth++;
                opened = true;
            } else if (c === 41 || c === 125 || c === 93) {
                depth--;
                if (opened && depth <= 0) return l;
            }
        }
        if (quote !== 96) quote = 0; // only template literals span lines
    }
    return opened ? Math.min(lines.length, line + BLOCK_REACH) - 1 : line;
}

/** Python: the indented block under `line`. */
function indentEnd(lines: string[], line: number): number {
    const indent = (s: string) => s.length - s.trimStart().length;
    const base = indent(lines[line]);
    let end = line;
    for (let l = line + 1; l < Math.min(lines.length, line + BLOCK_REACH); l++) {
        if (!lines[l].trim()) continue;
        if (indent(lines[l]) <= base) break;
        end = l;
    }
    return end;
}

function joinPath(prefix: string, path: string): string {
    const joined = [prefix, path].map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
    return `/${joined}`;
}

function nextCallable(symbols: SymbolInfo[], line: number): SymbolInfo | undefined {
    let best: SymbolInfo | undefined;
    for (const s of symbols) {
        if (!CALLABLE.has(s.kind) || s.startLine < line || s.startLine > line + DECORATOR_REACH) continue;
        if (!best || s.startLine < best.startLine) best = s;
    }
    return best;
}

/** Entrypoints declared in one file. */
export function detectEntryPoints(source: string, analysis: FileAnalysis): EntryPoint[] {
    if (isTestPath(analysis.filePath)) return [];
    const out = fileConventions(analysis);
    const rules = RULES[analysis.language];
    if (!rules) return out;
    const lines = source.split('\n');
    let prefix = '';
    const ctx: Ctx = {
        lines,
        index: 0,
        imports: analysis.imports.map((i) => i.source),
        analysis,
        setPrefix: (p) => {
            prefix = p;
        },
    };
    for (let i = 0; i < lines.length && out.length < MAX_ENTRIES; i++) {
        const line = lines[i];
        if (line.length > MAX_LINE || line.length < 4 || isCommentLine(line, analysis.language)) continue;
        ctx.index = i;
        for (const rule of rules) {
            const hit = rule(line, ctx);
            if (!hit) continue;
            const entry = bind(hit, i, lines, analysis, prefix);
            if (entry) out.push(entry);
            break;
        }
    }
    return out;
}

function bind(hit: Hit, line: number, lines: string[], analysis: FileAnalysis, prefix: string): EntryPoint | undefined {
    let label = hit.label;
    if (hit.prefixed && hit.kind === 'http') {
        const sp = label.indexOf(' ');
        label = `${label.slice(0, sp)} ${joinPath(prefix, label.slice(sp + 1))}`;
    }
    const entry: EntryPoint = { kind: hit.kind, label, framework: hit.framework, line };
    const b = hit.bind;
    if (b.to === 'named') entry.handler = b.name;
    else if (b.to === 'next') {
        const fn = nextCallable(analysis.symbols, line);
        if (fn) entry.handler = fn.name;
    } else if (b.to === 'method') {
        const fn = analysis.symbols.find((s) => CALLABLE.has(s.kind) && b.names.includes(s.name) && s.startLine >= line);
        if (fn) entry.handler = fn.name;
    } else if (b.to === 'inline') {
        entry.endLine = b.col < 0 ? indentEnd(lines, line) : blockEnd(lines, b.at ?? line, b.col);
    }
    if (entry.label.includes('{fn}')) {
        if (!entry.handler) return undefined;
        entry.label = entry.label.replace('{fn}', hit.kind === 'cli' ? entry.handler.replace(/_/g, '-') : entry.handler);
    }
    if (entry.handler) entry.handler = entry.handler.trim();
    return entry;
}
