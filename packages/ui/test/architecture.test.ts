import { describe, expect, test } from 'vitest';
import type { ArchNode, Architecture } from '@codearchy/protocol';
import { layoutArchitecture } from '../src/Architecture.js';

const part = (id: string, layer: ArchNode['layer'], files = 1): ArchNode => ({ id, label: id, kind: 'part', layer, description: '', parts: [id], files });
const arch = (nodes: ArchNode[], edges: Architecture['edges'] = []): Architecture => ({ pattern: 'p', summary: 's', nodes, edges, source: 'deterministic', createdAt: 0 });

describe('architecture layout', () => {
    test('one row per layer, top to bottom in layer order; empty layers take no room', () => {
        const a = arch([part('db', 'data'), { ...part('users', 'actors'), kind: 'actor' }, part('api', 'interface'), { ...part('pg', 'external'), kind: 'external' }]);
        const { rows, boxes } = layoutArchitecture(a, 1200);
        expect(rows.map((r) => r.layer)).toEqual(['actors', 'interface', 'data', 'external']);
        const y = (id: string) => boxes.get(id)!.y;
        expect(y('users') < y('api') && y('api') < y('db') && y('db') < y('pg')).toBe(true);
    });

    test('a row orders its boxes under their neighbours (fewer crossings) and wraps when narrow', () => {
        const a = arch([part('a', 'interface'), part('b', 'interface'), part('y', 'data'), part('x', 'data')], [
            { source: 'a', target: 'x', label: '', kind: 'depends' },
            { source: 'b', target: 'y', label: '', kind: 'depends' },
        ]);
        const wide = layoutArchitecture(a, 1200).boxes;
        expect(wide.get('x')!.x < wide.get('y')!.x).toBe(wide.get('a')!.x < wide.get('b')!.x);
        const narrow = layoutArchitecture(a, 480);
        expect(new Set([...narrow.boxes.values()].filter((b) => b.node.layer === 'interface').map((b) => b.y)).size).toBe(2);
    });
});
