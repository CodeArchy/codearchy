/**
 * Deterministic architectural roles. Words are matched against whole path
 * tokens (`controllers` matches, `controllerish` and `rebuild` don't), and
 * every assignment carries a confidence and the reason it was made.
 * Deliberately absent: `lib` (the main code in Ruby gems and many JS
 * packages) and `client` (as often a frontend as an API client).
 */
import type { ComponentRole, RoleAssignment } from '@codearchy/protocol';
import { tokenizeSegment } from '../graph/inference.js';

const ROLE_WORDS: Record<ComponentRole, string[]> = {
    test: ['test', 'tests', 'spec', 'specs', 'e2e', 'fixture', 'fixtures', 'mock', 'mocks', 'testing', 'conftest', 'testdata'],
    api: ['api', 'apis', 'route', 'routes', 'router', 'routers', 'controller', 'controllers', 'handler', 'handlers', 'endpoint', 'endpoints', 'rest', 'graphql', 'rpc', 'grpc', 'http', 'middleware', 'middlewares', 'resolver', 'resolvers'],
    ui: ['ui', 'view', 'views', 'component', 'components', 'page', 'pages', 'screen', 'screens', 'widget', 'widgets', 'frontend', 'layout', 'layouts', 'template', 'templates', 'webview', 'hooks', 'styles'],
    data: ['model', 'models', 'schema', 'schemas', 'entity', 'entities', 'repository', 'repositories', 'repo', 'repos', 'dao', 'db', 'database', 'migration', 'migrations', 'orm', 'sql', 'prisma', 'store', 'stores', 'persistence', 'dto', 'dtos'],
    domain: ['domain', 'service', 'services', 'usecase', 'usecases', 'core', 'logic', 'business', 'engine', 'workflow', 'workflows'],
    infra: ['infra', 'infrastructure', 'deploy', 'deployment', 'docker', 'k8s', 'kubernetes', 'terraform', 'ops', 'scripts', 'ci', 'tooling', 'build', 'adapters', 'adapter', 'gateway', 'gateways'],
    config: ['config', 'configs', 'configuration', 'settings', 'env', 'environment', 'constants'],
    util: ['util', 'utils', 'utility', 'utilities', 'helper', 'helpers', 'common', 'shared', 'tools', 'support', 'misc'],
};

const WORD_TO_ROLE = new Map<string, ComponentRole>();
for (const [role, words] of Object.entries(ROLE_WORDS) as Array<[ComponentRole, string[]]>) {
    for (const w of words) if (!WORD_TO_ROLE.has(w)) WORD_TO_ROLE.set(w, role);
}

/** Role from one name (a folder or file name): the last matching word wins ("user_controller" → api). */
export function roleOfName(name: string): ComponentRole | undefined {
    const tokens = tokenizeSegment(name.replace(/\.[^.]+$/, ''));
    for (let i = tokens.length - 1; i >= 0; i--) {
        const role = WORD_TO_ROLE.get(tokens[i]);
        if (role) return role;
    }
    return undefined;
}

/** A module's role: test markers anywhere on its path win, then the file name, then its folders (nearest first). */
export function roleOfModule(path: string): RoleAssignment | undefined {
    const segments = path.split('/');
    const file = segments[segments.length - 1];
    const testSegment = segments.find((s) => roleOfName(s) === 'test');
    if (testSegment) return { role: 'test', confidence: 0.95, reason: `path segment "${testSegment}"` };
    const own = roleOfName(file);
    if (own) return { role: own, confidence: 0.8, reason: `file name "${file}"` };
    for (let i = segments.length - 2; i >= 0; i--) {
        const role = roleOfName(segments[i]);
        if (role) return { role, confidence: 0.6, reason: `folder "${segments[i]}"` };
    }
    return undefined;
}

/**
 * A component's role: from its own folder name(s) when they say, otherwise
 * from the roles of the modules inside it when a clear majority agrees.
 */
export function roleOfComponent(name: string, memberRoles: Array<ComponentRole | undefined>): RoleAssignment | undefined {
    const parts = name.split('/');
    for (let i = parts.length - 1; i >= 0; i--) {
        const role = roleOfName(parts[i]);
        if (role) return { role, confidence: role === 'test' ? 0.95 : 0.9, reason: `folder name "${parts[i]}"` };
    }
    const counts = new Map<ComponentRole, number>();
    for (const r of memberRoles) if (r) counts.set(r, (counts.get(r) ?? 0) + 1);
    let best: ComponentRole | undefined;
    let bestCount = 0;
    for (const [role, count] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (count > bestCount) {
            best = role;
            bestCount = count;
        }
    }
    const total = memberRoles.length;
    if (!best || total === 0 || bestCount / total < 0.5) return undefined;
    return { role: best, confidence: Math.round((bestCount / total) * 0.8 * 100) / 100, reason: `${bestCount} of ${total} files look like ${best}` };
}
