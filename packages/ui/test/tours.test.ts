import { describe, expect, test } from 'vitest';
import type { Flow, Tour } from '@codearchy/protocol';
import { addToDraft, draftFrom, firstUndone, moveStep, removeFromDraft, stepView, tourFile, tourFromFlow, tourToSave, updateStep } from '../src/tourModel.js';
import { speechText } from '../src/voice.js';
import { matrixCell } from '../src/Matrix.js';
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

    test('walks the calls in reading order on the flow itself (Flows mode), skipping shared helpers', () => {
        expect(tour.steps.map((s) => `${s.id}:${s.title}:${s.view?.mode}`)).toEqual(['entry:POST /orders:flows', 'step-0:create:flows', 'step-1:place:flows', 'step-3:insert:flows']);
        // Each call step targets the flow and the call, so Flows highlights it.
        expect(tour.steps[2]!.target).toEqual({ flow: flow.id, node: 'sym:core/o.ts#place' });
        expect(tour.steps[2]!.view?.focus).toBe('sym:core/o.ts#place');
        // …and links the file, so the map is one click away.
        expect(tour.steps[2]!.body).toContain('[o.ts](node:mod:core/o.ts)');
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

describe('managing tours', () => {
    const authored: Tour = {
        version: 1,
        id: 'orders',
        title: 'Orders',
        origin: 'authored',
        description: 'How orders flow',
        steps: [
            { id: 'a', target: { node: 'dir:api' }, title: 'API', body: 'one' },
            { id: 'b', target: { node: 'dir:core' }, title: 'Core', body: 'two', anchorHash: 'h' },
        ],
    };

    test('editing a repository tour keeps its id, so saving replaces its file', () => {
        const d = draftFrom(authored, true);
        expect(d).toMatchObject({ id: 'draft', title: 'Orders', replaces: 'orders', origin: 'authored' });
        expect(tourToSave(d)).toMatchObject({ id: 'orders', title: 'Orders' });
        expect('replaces' in tourToSave(d)).toBe(false);
        // Anchors are re-stamped on save, not copied.
        expect(d.steps[1]).not.toHaveProperty('anchorHash');
    });

    test('a copy (or a copy of a generated tour) saves as a new tour', () => {
        const copy = draftFrom(authored);
        expect(copy.title).toBe('Orders (my copy)');
        expect(copy.replaces).toBeUndefined();
        expect(tourToSave(copy).id).toBe('draft');
        expect(draftFrom({ ...authored, origin: 'generated', id: 'start-here' }, true).replaces).toBeUndefined();
    });

    test('steps move, change and keep their ids', () => {
        const d = draftFrom(authored, true);
        expect(moveStep(d, 'b', -1).steps.map((s) => s.id)).toEqual(['b', 'a']);
        expect(moveStep(d, 'a', -1)).toBe(d);
        expect(moveStep(d, 'b', 1)).toBe(d);
        expect(updateStep(d, 'a', { title: 'Edge' }).steps[0]).toMatchObject({ id: 'a', title: 'Edge', body: 'one' });
    });

    test('the file format carries only what the engine reads', () => {
        const text = tourFile({ ...authored, status: [{}, {}], file: '.codearchy/tours/orders.json' } as Tour);
        expect(Object.keys(JSON.parse(text))).toEqual(['version', 'title', 'description', 'steps']);
        expect(text.endsWith('\n')).toBe(true);
    });
});

describe('narration text', () => {
    test('links keep their label; code and markup marks go', () => {
        expect(speechText('It lives in [o.ts](node:mod:core/o.ts) and calls `place()` **twice**.')).toBe('It lives in o.ts and calls place() twice.');
    });
});

describe('matrix cells', () => {
    test('grow to fill the space, within readable bounds', () => {
        expect(matrixCell(8, 1600, 900)).toBe(64);
        expect(matrixCell(20, 800, 600)).toBe(30);
        expect(matrixCell(300, 800, 600)).toBe(10);
        expect(matrixCell(30, 0, 0)).toBe(26);
    });
});
