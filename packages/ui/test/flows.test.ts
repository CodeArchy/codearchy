import { describe, expect, test } from 'vitest';
import type { Flow, FlowSummary } from '@codearchy/protocol';
import { flowModules, flowRows, groupFlows, splitLabel } from '../src/flowModel.js';

const summary = (kind: FlowSummary['kind'], label: string, file = 'api/routes.ts', framework = 'express'): FlowSummary => ({ id: `${file}#${label}`, kind, label, framework, file, line: 0 });

describe('groupFlows', () => {
    const flows = [summary('cli', 'deploy', 'cmd/deploy.go', 'cobra'), summary('http', 'GET /users'), summary('http', 'POST /login'), summary('main', 'main', 'cmd/main.go', 'go')];

    test('groups by kind in a fixed order, routes first', () => {
        expect(groupFlows(flows).map((g) => `${g.title}: ${g.flows.map((f) => f.label).join(', ')}`)).toEqual([
            'HTTP routes: GET /users, POST /login',
            'Commands: deploy',
            'Programs: main',
        ]);
    });

    test('filters on every word, across label, framework and file', () => {
        expect(groupFlows(flows, 'post').flatMap((g) => g.flows.map((f) => f.label))).toEqual(['POST /login']);
        expect(groupFlows(flows, 'cobra deploy').flatMap((g) => g.flows.map((f) => f.label))).toEqual(['deploy']);
        expect(groupFlows(flows, 'cmd main.go').flatMap((g) => g.flows.map((f) => f.label))).toEqual(['main']);
        expect(groupFlows(flows, 'nothing-like-this')).toEqual([]);
    });
});

test('splitLabel separates HTTP verbs only', () => {
    expect(splitLabel('GET /api/users')).toEqual({ verb: 'GET', rest: '/api/users' });
    expect(splitLabel('resources /orders')).toEqual({ verb: 'resources', rest: '/orders' });
    expect(splitLabel('deploy env')).toEqual({ rest: 'deploy env' });
    expect(splitLabel('codearchy.analyze')).toEqual({ rest: 'codearchy.analyze' });
});

describe('flowRows', () => {
    // BFS order: 0 entry → 1, 2; 1 → 3; 2 → 4
    const flow: Flow = {
        ...summary('http', 'POST /login'),
        steps: [
            { key: 'sym:api/h.ts#login', name: 'login', file: 'api/h.ts', line: 1, lane: 'dir:api', depth: 0, resolution: 'entry' },
            { key: 'sym:core/auth.ts#auth', name: 'auth', file: 'core/auth.ts', line: 2, lane: 'dir:core', depth: 1, parent: 0, resolution: 'import' },
            { key: 'sym:api/h.ts#reply', name: 'reply', file: 'api/h.ts', line: 9, lane: 'dir:api', depth: 1, parent: 0, resolution: 'local' },
            { key: 'sym:db/users.ts#find', name: 'find', file: 'db/users.ts', line: 3, lane: 'dir:db', depth: 2, parent: 1, resolution: 'import' },
            { key: 'sym:api/fmt.ts#fmt', name: 'fmt', file: 'api/fmt.ts', line: 0, lane: 'dir:api', depth: 2, parent: 2, resolution: 'name', crossCutting: true },
        ],
        lanes: [
            { key: 'dir:api', name: 'api', kind: 'component' },
            { key: 'dir:core', name: 'core', kind: 'component' },
            { key: 'dir:db', name: 'db', kind: 'component' },
        ],
        sinks: [{ kind: 'database', name: 'pg', step: 3 }],
        approximate: true,
        truncated: false,
    };

    test('reads depth-first: each call right under its caller', () => {
        expect(flowRows(flow).map((r) => `${r.step.name} lane=${r.lane} from=${r.from ?? '-'}`)).toEqual([
            'login lane=0 from=-',
            'auth lane=1 from=0',
            'find lane=2 from=1',
            'reply lane=0 from=0',
            'fmt lane=0 from=0',
        ]);
    });

    test('sinks sit on the step whose file imports them', () => {
        const rows = flowRows(flow);
        expect(rows.find((r) => r.step.name === 'find')!.sinks).toEqual([{ kind: 'database', name: 'pg', step: 3 }]);
        expect(rows.filter((r) => r.sinks.length)).toHaveLength(1);
    });

    test('flowModules lists each file once, entry first', () => {
        expect(flowModules(flow)).toEqual(['mod:api/h.ts', 'mod:core/auth.ts', 'mod:db/users.ts', 'mod:api/fmt.ts']);
    });
});
