import { describe, test } from 'vitest';
import * as assert from 'node:assert';
import { SymbolKind, type FileAnalysis } from '@codearchy/protocol';
import { analyzeWithRegex, buildGraph, buildHierarchy, detectEntryPoints, enrich, extractCalls, FlowIndex, FLOW_LIMITS, HierarchyIndex } from '../src/index.js';

type Sym = [name: string, kind: SymbolKind, start: number, end: number, container?: string];

function fa(filePath: string, language: string, symbols: Sym[] = [], imports: string[] = [], namespace?: string): FileAnalysis {
    return {
        filePath,
        language,
        symbols: symbols.map(([name, kind, startLine, endLine, container]) => ({ name, kind, filePath, startLine, endLine, exported: true, ...(container ? { container } : {}) })),
        imports: imports.map((source) => ({ source, specifiers: [], isDefault: false, isNamespace: false, filePath })),
        exports: [],
        ...(namespace ? { namespace } : {}),
    };
}

const F = SymbolKind.Function;
const M = SymbolKind.Method;
const C = SymbolKind.Class;
const entries = (source: string, a: FileAnalysis) => detectEntryPoints(source, a).map((e) => `${e.kind} ${e.label} [${e.framework}]${e.handler ? ` -> ${e.handler}` : ''}${e.endLine !== undefined ? ` ..${e.endLine}` : ''}`);

describe('call sites', () => {
    test('names followed by `(`, outside strings and comments, with their enclosing function', () => {
        const src = [
            'export function handle(req) {', // 0
            '  // notCalled(x)', // 1
            '  const s = "fake(1)" + `tpl(${real()})`;', // 2
            '  /* block(', // 3
            '     still() */ repo.save(req);', // 4
            '  return useState<number>(0);', // 5
            '}', // 6
            'function other() { if (x) helper(); }', // 7
        ].join('\n');
        const calls = extractCalls(src, 'typescript', fa('a.ts', 'typescript', [['handle', F, 0, 6], ['other', F, 7, 7]]).symbols);
        assert.deepStrictEqual(calls.map((c) => `${c.name}@${c.line}<${c.from ?? '-'}`), ['real@2<0', 'save@4<0', 'useState@5<0', 'helper@7<1']);
    });

    test('Python: hash comments, triple-quoted strings, decorators and defs', () => {
        const src = ['def run():', '    """doc: fake()"""', '    # nope()', '    return go(1)', '', 'run()'].join('\n');
        const calls = extractCalls(src, 'python', fa('a.py', 'python', [['run', F, 0, 3]]).symbols);
        assert.deepStrictEqual(calls.map((c) => `${c.name}@${c.line}<${c.from ?? '-'}`), ['go@3<0', 'run@5<-']);
    });

    test('receivers: bare, own class, another object', () => {
        const ts = 'save(); this.load(); repo?.find(1); make().then(); Foo::bar(); async (x) => go(x);';
        assert.deepStrictEqual(extractCalls(ts, 'typescript', []).map((c) => `${c.name}:${c.via ?? 'bare'}`), [
            'save:bare', 'load:self', 'find:member', 'make:bare', 'then:member', 'bar:member', 'go:bare',
        ]);
        const php = '$this->render(); $repo->find(); self::boot(); helper();';
        assert.deepStrictEqual(extractCalls(php, 'php', []).map((c) => `${c.name}:${c.via ?? 'bare'}`), ['render:self', 'find:member', 'boot:self', 'helper:bare']);
    });

    test('Rust lifetimes and char literals do not open strings', () => {
        const src = "fn f<'a>(x: &'a str) -> char { let c = '('; g(c) }";
        const calls = extractCalls(src, 'rust', fa('a.rs', 'rust', [['f', F, 0, 0]]).symbols);
        assert.deepStrictEqual(calls.map((c) => c.name), ['g']);
    });
});

describe('entrypoints', () => {
    test('Express: named and inline handlers; client calls and tests are not routes', () => {
        const src = [
            "router.post('/login', validate, auth.login);",
            "app.get('/health', (req, res) => {",
            '  res.json(ok());',
            '});',
            "const r = await api.get('/users');",
            "axios.post('/x', data);",
            "router.get(`/logs/${name}`, cb);",
            "router.get('/items', { params });",
        ].join('\n');
        assert.deepStrictEqual(entries(src, fa('src/routes.ts', 'typescript', [], ['express'])), [
            'http POST /login [express] -> auth.login',
            'http GET /health [express] ..3',
        ]);
        assert.deepStrictEqual(entries(src, fa('src/routes.test.ts', 'typescript', [], ['express'])), []);
    });

    test('NestJS: controller prefix and the decorated method', () => {
        const src = ["@Controller('users')", 'export class UsersController {', "  @Get(':id')", '  findOne() {}', '  @Post()', '  create() {}', '}'].join('\n');
        const a = fa('src/users.controller.ts', 'typescript', [['UsersController', C, 1, 6], ['findOne', M, 3, 3, 'UsersController'], ['create', M, 5, 5, 'UsersController']]);
        assert.deepStrictEqual(entries(src, a), ['http GET /users/:id [nestjs] -> findOne', 'http POST /users [nestjs] -> create']);
    });

    test('Next.js and SvelteKit file conventions', () => {
        const route = fa('app/(shop)/api/orders/[id]/route.ts', 'typescript', [['GET', F, 2, 4], ['POST', F, 5, 9], ['helper', F, 10, 12]]);
        assert.deepStrictEqual(entries('', route), ['http GET /api/orders/[id] [nextjs] -> GET', 'http POST /api/orders/[id] [nextjs] -> POST']);
        assert.deepStrictEqual(entries('', fa('pages/api/users/index.ts', 'typescript', [['handler', F, 0, 3]])), ['http ANY /api/users [nextjs] -> handler']);
        assert.deepStrictEqual(entries('', fa('src/app/settings/page.tsx', 'typescript', [['Settings', F, 0, 9]])), ['ui /settings [nextjs] -> Settings']);
        assert.deepStrictEqual(entries('', fa('src/routes/api/+server.ts', 'typescript', [['GET', F, 0, 2]])), ['http GET /api [sveltekit] -> GET']);
    });

    test('Python: FastAPI, Flask, Django, click, Celery and __main__', () => {
        const api = ['@app.get("/items/{id}")', 'async def read_item(id):', '    return load(id)', '@bp.route("/login", methods=["POST"])', 'def login():', '    pass'].join('\n');
        assert.deepStrictEqual(entries(api, fa('app/main.py', 'python', [['read_item', F, 1, 2], ['login', F, 4, 5]], ['fastapi'])), [
            'http GET /items/{id} [fastapi] -> read_item',
            'http POST /login [fastapi] -> login',
        ]);
        const routed = ['router = APIRouter(prefix="/meetings", tags=["m"])', '@router.get("/")', 'def list_meetings():', '    pass'].join('\n');
        assert.deepStrictEqual(entries(routed, fa('app/routers/meetings.py', 'python', [['list_meetings', F, 2, 3]], ['fastapi'])), ['http GET /meetings [fastapi] -> list_meetings']);
        const urls = ['urlpatterns = [', '    path("login/", views.login),', '    path("api/", include("api.urls")),', ']'].join('\n');
        assert.deepStrictEqual(entries(urls, fa('shop/urls.py', 'python')), ['http ANY /login/ [django] -> views.login']);
        const cli = ['@cli.command()', 'def sync_all():', '    pass', '@app.task', 'def send_mail():', '    pass', 'if __name__ == "__main__":', '    cli()', '    print(1)', 'x = 1'].join('\n');
        assert.deepStrictEqual(entries(cli, fa('tool.py', 'python', [['sync_all', F, 1, 2], ['send_mail', F, 4, 5]], ['click'])), [
            'cli sync-all [click] -> sync_all',
            'job send_mail [celery] -> send_mail',
            'main main [python] ..8',
        ]);
    });

    test('Spring and ASP.NET: class-level prefixes', () => {
        const java = ['@RestController', '@RequestMapping("/api/orders")', 'public class OrderController {', '  @GetMapping("/{id}")', '  public Order get(Long id) {}', '  @PostMapping', '  public Order create() {}', '}'].join('\n');
        const ja = fa('src/OrderController.java', 'java', [['OrderController', C, 2, 7], ['get', M, 4, 4, 'OrderController'], ['create', M, 6, 6, 'OrderController']]);
        assert.deepStrictEqual(entries(java, ja), ['http GET /api/orders/{id} [spring] -> get', 'http POST /api/orders [spring] -> create']);
        const cs = ['[ApiController]', '[Route("api/[controller]")]', 'public class UsersController : ControllerBase {', '  [HttpGet("{id}")]', '  public IActionResult Get(int id) {}', '}'].join('\n');
        const ca = fa('Controllers/UsersController.cs', 'csharp', [['UsersController', C, 2, 5], ['Get', M, 4, 4, 'UsersController']]);
        assert.deepStrictEqual(entries(cs, ca), ['http GET /api/users/{id} [aspnet] -> Get']);
    });

    test('Go: net/http patterns, gin, cobra and main', () => {
        const src = [
            'package main',
            'func main() {',
            '  http.HandleFunc("POST /orders", createOrder)',
            '  r.GET("/users/:id", h.GetUser)',
            '}',
            'var deployCmd = &cobra.Command{',
            '  Use:   "deploy [env]",',
            '  RunE: runDeploy,',
            '}',
        ].join('\n');
        const a = fa('cmd/main.go', 'go', [['main', F, 1, 4]], ['github.com/gin-gonic/gin', 'github.com/spf13/cobra'], 'main');
        assert.deepStrictEqual(entries(src, a), [
            'main main [go] -> main',
            'http POST /orders [net/http] -> createOrder',
            'http GET /users/:id [gin] -> h.GetUser',
            'cli deploy [cobra] -> runDeploy',
        ]);
    });

    test('Laravel and Rails', () => {
        const php = ["Route::get('/users', [UserController::class, 'index']);", "Route::post('login', 'AuthController@login');"].join('\n');
        assert.deepStrictEqual(entries(php, fa('routes/web.php', 'php')), ['http GET /users [laravel] -> index', 'http POST /login [laravel] -> login']);
        const rb = ["get '/profile', to: 'users#show'", 'resources :orders'].join('\n');
        assert.deepStrictEqual(entries(rb, fa('config/routes.rb', 'ruby')), ['http GET /profile [rails] -> show', 'http resources /orders [rails]']);
    });
});

describe('FlowIndex', () => {
    const FILES: Record<string, string> = {
        'api/routes.ts': [
            "import express from 'express';",
            "import { login } from './handlers';",
            'const router = express.Router();',
            "router.post('/login', login);",
            "router.get('/health', (req, res) => {",
            '  res.json(checkHealth());',
            '});',
        ].join('\n'),
        'api/handlers.ts': [
            "import { authenticate } from '../core/auth/service';",
            'export async function login(req, res) {',
            '  const user = await authenticate(req.body.email, req.body.password);',
            '  res.json(user);',
            '}',
            'export function checkHealth() { return { ok: true }; }',
        ].join('\n'),
        'core/auth/service.ts': [
            "import { findUser } from '../../db/users';",
            'export async function authenticate(email: string, password: string) {',
            '  const user = await findUser(email);',
            '  if (!verify(user, password)) throw new Error("bad");',
            '  return user;',
            '}',
            'function verify(user, password) { return hash(password) === user.hash; }',
            'function hash(s) { return s; }',
        ].join('\n'),
        'core/auth/token.ts': 'export function sign(x) { return x; }',
        'db/users.ts': ["import { Pool } from 'pg';", 'const pool = new Pool();', 'export async function findUser(email: string) {', "  return pool.query('select 1', [email]);", '}'].join('\n'),
        'db/schema.ts': 'export function migrate() {}',
    };

    function flows(files: Record<string, string>) {
        const analyses = new Map<string, FileAnalysis>();
        for (const [path, src] of Object.entries(files)) analyses.set(path, enrich(analyzeWithRegex(src, path, 'typescript')!, src));
        return new FlowIndex(analyses, new HierarchyIndex(buildHierarchy(buildGraph(analyses.values()), { systemName: 'shop' })));
    }

    test('lists entrypoints with their resolved handlers', () => {
        assert.deepStrictEqual(
            flows(FILES).list().map((f) => `${f.id} ${f.handler ?? ''}`),
            ['flow:api/routes.ts#http:GET /health ', 'flow:api/routes.ts#http:POST /login sym:api/handlers.ts#login']
        );
    });

    test('traces a handler through imports and local calls, with lanes and sinks', () => {
        const flow = flows(FILES).trace('flow:api/routes.ts#http:POST /login')!;
        assert.deepStrictEqual(
            flow.steps.map((s) => `${'  '.repeat(s.depth)}${s.name} (${s.resolution}) in ${s.lane}`),
            [
                'login (entry) in dir:api',
                '  authenticate (import) in dir:core/auth',
                '    findUser (import) in dir:db',
                '    verify (local) in dir:core/auth',
                '      hash (local) in dir:core/auth',
            ]
        );
        assert.deepStrictEqual(flow.lanes.map((l) => l.key), ['dir:api', 'dir:core/auth', 'dir:db']);
        assert.deepStrictEqual(flow.sinks, [{ kind: 'database', name: 'pg', step: 2 }]);
        assert.deepStrictEqual([flow.approximate, flow.truncated], [false, false]);
        assert.deepStrictEqual(flow.steps[1].callSite, { file: 'api/handlers.ts', line: 2 });
    });

    test('an inline handler takes the calls inside its body', () => {
        const flow = flows(FILES).trace('flow:api/routes.ts#http:GET /health')!;
        assert.deepStrictEqual(flow.steps.map((s) => `${s.key} ${s.resolution}`), ['mod:api/routes.ts entry', 'sym:api/handlers.ts#checkHealth import']);
    });

    test("calls through a package's index (re-exports, `export *`, a few files deep) reach the declaration", () => {
        const flow = flows({
            'api/routes.ts': ["import express from 'express';", "import { placeOrder } from '../orders';", 'const router = express.Router();', "router.post('/checkout', (req, res) => {", '  placeOrder(req.body);', '});'].join('\n'),
            'orders/index.ts': ["export { placeOrder } from './placeOrder';", "export * from './repository';"].join('\n'),
            'orders/placeOrder.ts': ["import { charge } from '../payments';", 'export function placeOrder(items) {', '  return charge(items);', '}'].join('\n'),
            'orders/repository.ts': 'export function getOrder(id) { return id; }',
            'payments/index.ts': "export * from './stripe';",
            'payments/stripe.ts': "export * from './charge';",
            'payments/charge.ts': 'export function charge(items) { return items; }',
        }).trace('flow:api/routes.ts#http:POST /checkout')!;
        assert.deepStrictEqual(
            flow.steps.map((s) => `${'  '.repeat(s.depth)}${s.key} (${s.resolution})`),
            ['mod:api/routes.ts (entry)', '  sym:orders/placeOrder.ts#placeOrder (import)', '    sym:payments/charge.ts#charge (import)']
        );
        assert.strictEqual(flow.approximate, false);
    });

    test('unknown ids are undefined', () => {
        assert.strictEqual(flows(FILES).trace('flow:nope'), undefined);
    });

    test('name-only hops mark the flow approximate; hubs are shown, not followed', () => {
        const files: Record<string, string> = {
            'api/routes.ts': "router.get('/a', handleA);\nexport function handleA() { audit(); }",
            'lib/audit.ts': 'export function audit() { deepInside(); }\nfunction deepInside() {}',
        };
        // No import from routes to audit: matched by name only.
        let flow = flows(files).trace('flow:api/routes.ts#http:GET /a')!;
        assert.deepStrictEqual(flow.steps.map((s) => `${s.name}:${s.resolution}`), ['handleA:entry', 'audit:name', 'deepInside:local']);
        assert.strictEqual(flow.approximate, true);

        for (let i = 0; i <= FLOW_LIMITS.hubCallers; i++) files[`x/caller${i}.ts`] = `export function c${i}() { audit(); }`;
        flow = flows(files).trace('flow:api/routes.ts#http:GET /a')!;
        assert.deepStrictEqual(flow.steps.map((s) => `${s.name}${s.crossCutting ? ' (cross-cutting)' : ''}`), ['handleA', 'audit (cross-cutting)']);
    });

    test('fan-out and depth limits truncate the trace', () => {
        const many = Array.from({ length: FLOW_LIMITS.fanOut + 3 }, (_, i) => `f${i}`);
        const chain = Array.from({ length: FLOW_LIMITS.depth + 3 }, (_, i) => `export function d${i}() { d${i + 1}(); }`);
        const files: Record<string, string> = {
            'api/routes.ts': [`router.get('/wide', wide);`, `router.get('/deep', d0);`, `export function wide() { ${many.map((n) => `${n}();`).join(' ')} }`, ...many.map((n) => `function ${n}() {}`), ...chain].join('\n'),
        };
        const index = flows(files);
        const wide = index.trace('flow:api/routes.ts#http:GET /wide')!;
        assert.strictEqual(wide.steps.length, 1 + FLOW_LIMITS.fanOut);
        assert.strictEqual(wide.truncated, true);
        const deep = index.trace('flow:api/routes.ts#http:GET /deep')!;
        assert.strictEqual(Math.max(...deep.steps.map((s) => s.depth)), FLOW_LIMITS.depth);
        assert.strictEqual(deep.truncated, true);
    });
});
