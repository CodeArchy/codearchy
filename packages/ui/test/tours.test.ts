import { describe, expect, test } from 'vitest';
import type { Flow, Tour } from '@codearchy/protocol';
import { addToDraft, firstUndone, removeFromDraft, stepView, tourFromFlow } from '../src/tourModel.js';
import { flowRows } from '../src/flowModel.js';

const flow: Flow = {
    id: 'flow:api/r.ts#http:POST /orders',
    kind: 'http',
    label: 'POST /orders',
    framework: 'express',
    file: 'api/r.ts',
    line: 4,
    handler: 'sym:api/h.ts#create',
    steps: [
        { key: 'sym:api/h.ts#create', name: 'create', file: 'api/h.ts', line: 1, lane: 'dir:api', depth: 0, resolution: 'entry' },
        { key: 'sym:core/o.ts#place', name: 'place', file: 'core/o.ts', line: 3, lane: 'dir:core', depth: 1, parent: 0, callSite: { file: 'api/h.ts', line: 2 }, resolution: 'import' },
        { key: 'sym:lib/log.ts#log', name: 'log', file: 'lib/log.ts', line: 0, lane: 'dir:lib', depth: 1, parent: 0, resolution: 'name', crossCutting: true },
        { key: 'sym:db/o.ts#insert', name: 'insert', file: 'db/o.ts', line: 7, lane: 'dir:db', depth: 2, parent: 1, callSite: { file: 'core/o.ts', line: 4 }, resolution: 'name' },
    ],
    lanes: [
        { key: 'dir:api', name: 'api', kind: 'component' },
        { key: 'dir:core', name: 'core', kind: 'component' },
        { key: 'dir:lib', name: 'lib', kind: 'component' },
        { key: 'dir:db', name: 'db', kind: 'component' },
    ],
    sinks: [{ kind: 'database', name: 'pg', step: 3 }],
    approximate: true,
    truncated: false,
};

describe('tourFromFlow', () => {
    const tour = tourFromFlow(flow, flowRows(flow).map((r) => r.index));

    test('starts at the entrypoint in Flows mode, then walks the calls in reading order, skipping shared helpers', () => {
        expect(tour.steps.map((s) => `${s.id}:${s.title}:${s.view?.mode}`)).toEqual(['entry:POST /orders:flows', 'step-0:create:map', 'step-1:place:map', 'step-3:insert:map']);
        expect(tour.steps[0]!.target).toEqual({ flow: flow.id, node: 'sym:api/h.ts#create' });
        expect(tour.steps[0]!.body).toMatch(/reaches pg/);
        expect(tour.status).toHaveLength(tour.steps.length);
    });

    test('each call step says who calls it, where, and what it reaches', () => {
        const insert = tour.steps.find((s) => s.title === 'insert')!;
        expect(insert.body).toMatch(/^place calls insert on line 5 of o\.ts\./);
        expect(insert.body).toMatch(/matched by name only/);
        expect(insert.body).toMatch(/pg \(database\)/);
        expect(insert.code).toEqual([{ path: 'db/o.ts', start: 8, end: 8 }]);
    });
});

describe('draft tours', () => {
    const capture = { title: 'Orders', body: ' Where orders live. ', target: { node: 'dir:core' }, view: { mode: 'map' as const, focus: 'dir:core' } };

    test('the first step creates the draft with its title; later ones join it with fresh ids', () => {
        const one = addToDraft(undefined, capture, 'How orders work');
        expect(one).toMatchObject({ id: 'draft', title: 'How orders work', origin: 'authored', version: 1 });
        expect(one.steps).toEqual([{ id: 's1', target: { node: 'dir:core' }, view: { mode: 'map', focus: 'dir:core' }, title: 'Orders', body: 'Where orders live.' }]);
        const two = addToDraft(one, { ...capture, title: '  ' }, 'ignored');
        expect(two.title).toBe('How orders work');
        expect(two.steps.map((s) => `${s.id}:${s.title}`)).toEqual(['s1:Orders', 's2:Untitled step']);
        const removed = removeFromDraft(two, 's1')!;
        expect(addToDraft(removed, capture, '').steps.map((s) => s.id)).toEqual(['s2', 's3']);
        expect(removeFromDraft(removeFromDraft(two, 's1')!, 's2')).toBeUndefined();
    });
});

test('firstUndone resumes at the first step not done', () => {
    const t: Pick<Tour, 'steps'> = { steps: ['a', 'b', 'c'].map((id) => ({ id, target: {}, title: id, body: '' })) };
    expect(firstUndone(t, new Set())).toBe(0);
    expect(firstUndone(t, new Set(['a']))).toBe(1);
    expect(firstUndone(t, new Set(['a', 'b', 'c']))).toBe(0);
});

test('stepView: flows for flow-only steps, the focus node otherwise', () => {
    expect(stepView({ id: 'a', target: { flow: 'f' }, title: '', body: '' })).toEqual({ mode: 'flows', flow: 'f' });
    expect(stepView({ id: 'a', target: { node: 'n', flow: 'f' }, title: '', body: '' })).toEqual({ mode: 'map', node: 'n', flow: 'f' });
    expect(stepView({ id: 'a', target: { node: 'n' }, view: { mode: 'matrix', focus: 'm', lens: 'health' }, title: '', body: '' })).toEqual({ mode: 'matrix', node: 'm', lens: 'health' });
});
