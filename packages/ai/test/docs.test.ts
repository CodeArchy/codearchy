import { describe, expect, it } from 'vitest';
import { extractJson, fileDoc, signature, symbolDoc, validate } from '../src/index.js';

describe('file docs', () => {
    it('skips a shebang and a licence header, then takes the doc block', () => {
        const text = ['#!/usr/bin/env node', '// Copyright 2026 Acme. MIT License.', '', '/**', ' * Session handling for the API.', ' * Issues and refreshes tokens.', ' */', 'import x from "y";'].join('\n');
        expect(fileDoc(text)).toBe('Session handling for the API. Issues and refreshes tokens.');
    });

    it('reads Python module docstrings and hash comments', () => {
        expect(fileDoc('"""Billing: invoices and payment runs."""\nimport os')).toBe('Billing: invoices and payment runs.');
        expect(fileDoc('# -*- coding: utf-8 -*-\n# Routes for the admin area.\nfrom x import y')).toBe('Routes for the admin area.');
    });

    it('returns nothing when code comes first', () => {
        expect(fileDoc('import a from "b";\n// later comment')).toBeUndefined();
    });
});

describe('symbol docs and signatures', () => {
    const lines = [
        '/** Logs a user in and returns a session. */', // 0
        '@Injectable()', // 1
        'export async function login(', // 2
        '    user: string,', // 3
        '    password: string,', // 4
        '): Promise<Session> {', // 5
        '    return secretInternalLogic(user);', // 6
        '}', // 7
        'def charge(invoice, amount):', // 8
        '    """Charge an invoice."""', // 9
        '    pass', // 10
        '// Formats money.', // 11
        'export const format = (n: number) => {', // 12
    ];

    it('finds the doc above a declaration (skipping decorators) or the docstring below it', () => {
        expect(symbolDoc(lines, 2)).toBe('Logs a user in and returns a session.');
        expect(symbolDoc(lines, 8)).toBe('Charge an invoice.');
        expect(symbolDoc(lines, 12)).toBe('Formats money.');
    });

    it('takes the declaration up to where the body opens, never the body', () => {
        expect(signature(lines, 1, 7)).toBe('export async function login( user: string, password: string, ): Promise<Session>');
        expect(signature(lines, 8, 10)).toBe('def charge(invoice, amount)');
        expect(signature(lines, 12, 12)).toBe('export const format = (n: number) =>'.replace(/ =>$/, ''));
        expect(signature(lines, 1, 7)).not.toContain('secretInternalLogic');
    });
});

describe('card replies', () => {
    const refs = new Map([
        ['C1', 'dir:src/auth'],
        ['C2', 'dir:src/billing'],
    ]);

    it('extracts JSON from fenced or chatty replies', () => {
        expect(extractJson('Here you go:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
        expect(() => extractJson('no json here')).toThrow(/no JSON/);
    });

    it('maps refs back to keys, drops made-up ones and lowers confidence for them', () => {
        const { draft, unknownRefs } = validate(
            { title: 'Payments', purpose: 'Takes payments.', responsibilities: ['a', 'b'], keyNodes: ['c2', 'C9', 'C2'], risks: [], confidence: 0.9 },
            refs,
        );
        expect(draft.keyNodes).toEqual(['dir:src/billing']);
        expect(unknownRefs).toEqual(['C9']);
        expect(draft.confidence).toBe(0.4);
    });

    it('accepts exact names as citations, turns refs in prose into names, and drops filler risks', () => {
        const labels = new Map([
            ['C1', 'auth'],
            ['C2', 'billing'],
        ]);
        const { draft, unknownRefs } = validate(
            {
                title: 'Shop',
                purpose: 'C1 signs users in; C2 charges them.',
                responsibilities: ['Login via C1'],
                keyNodes: ['Billing', 'C1: auth'],
                risks: ['None', 'No specific risks identified', 'No explicit risk identified', 'Thin facts', 'C2 is in a dependency cycle'],
                confidence: 0.7,
            },
            refs,
            labels,
        );
        expect(unknownRefs).toEqual([]);
        expect(draft).toMatchObject({
            purpose: 'auth signs users in; billing charges them.',
            responsibilities: ['Login via auth'],
            keyNodes: ['dir:src/billing', 'dir:src/auth'],
            risks: ['billing is in a dependency cycle'],
            confidence: 0.7,
        });
    });

    it('caps lengths and rejects missing fields', () => {
        const long = 'x'.repeat(1000);
        const { draft } = validate({ title: long, purpose: long, responsibilities: Array(9).fill('r'), keyNodes: [], risks: Array(9).fill('k'), confidence: 7 }, refs);
        expect(draft.title.length).toBeLessThanOrEqual(60);
        expect(draft.purpose.length).toBeLessThanOrEqual(320);
        expect(draft.responsibilities).toHaveLength(5);
        expect(draft.risks).toHaveLength(3);
        expect(draft.confidence).toBe(1);
        expect(() => validate({ purpose: 'p' }, refs)).toThrow(/title/);
    });
});
