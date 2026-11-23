import * as assert from 'assert';
import { analyzeSource, assertSymbols, getAnalyzer } from './helpers';
import { analyzeWithRegex } from '../../analysis/regexFallback';

suite('Extraction (tree-sitter)', () => {
    suiteSetup(async () => {
        const a = await getAnalyzer();
        assert.ok(a.treeSitterAvailable, 'tree-sitter runtime must load; run `npm run grammars`');
    });

    test('TypeScript: exports, classes, methods, arrow functions, imports', async () => {
        const r = await analyzeSource('svc.ts', `
import { Injectable, Logger as L } from '@nestjs/common';
import * as fs from 'fs';
import Default from './default';
import type { Foo } from '../types';
export * from './barrel';
export { a, b } from './ab';
const cfg = require('./config');
const lazy = () => import('./lazy');

export interface Repo { find(id: string): Promise<User>; }
export type Id = string;
export enum Status { Active }
export abstract class Base { abstract run(): void; }
export class UserService extends Base {
    private cache = new Map();
    constructor(private repo: Repo) { super(); }
    async findOne(id: Id) { const local = 1; return local; }
    run() {}
}
export const handler = async (req: Request) => { const inner = () => 1; return inner(); };
export default function main() {}
function helper() {}
const internal = 42;
let a = 1, b = 2;
export { internal as publicName, helper };
`);
        assert.strictEqual(r.parser, 'tree-sitter');
        assertSymbols(r, [
            'class Base*',
            'class UserService*',
            'enum Status*',
            'function handler*',
            'function helper*',
            'function lazy',
            'function main*',
            'interface Repo*',
            'method Base.run',
            'method UserService.constructor',
            'method UserService.findOne',
            'method UserService.run',
            'type Id*',
            'variable a',
            'variable b',
            'variable cfg',
            'variable internal*',
        ]);
        assert.deepStrictEqual(
            r.imports.map((i) => i.source).sort(),
            ['../types', './ab', './barrel', './config', './default', './lazy', '@nestjs/common', 'fs']
        );
        const common = r.imports.find((i) => i.source === '@nestjs/common')!;
        assert.deepStrictEqual(common.specifiers, ['Injectable', 'Logger']);
        assert.strictEqual(r.imports.find((i) => i.source === 'fs')!.isNamespace, true);
        assert.strictEqual(r.imports.find((i) => i.source === './default')!.isDefault, true);
        // Names are identifiers, never the declaration's source text (v1 bug L3).
        assert.ok(r.symbols.every((s) => /^[\w$]+$/.test(s.name)));
    });

    test('TSX and JavaScript use their own grammars', async () => {
        const tsx = await analyzeSource('App.tsx', `
import React from 'react';
export function App(): JSX.Element { return <div className="x">{1}</div>; }
`);
        assertSymbols(tsx, ['function App*']);
        assert.strictEqual(tsx.parser, 'tree-sitter');

        const js = await analyzeSource('index.mjs', `
import { x } from './x.js';
const { y } = require('./y');
export class Widget { render() {} }
export { a, b } from './ab';
module.exports = { Widget };
`);
        // Destructuring isn't a named declaration; a re-export doesn't export local names.
        assertSymbols(js, ['class Widget*', 'method Widget.render']);
        assert.deepStrictEqual(js.imports.map((i) => i.source).sort(), ['./ab', './x.js', './y']);
    });

    test('Python: classes, methods, privacy, relative and absolute imports', async () => {
        const r = await analyzeSource('orders/service.py', `
import os
import app.models.user as user_model
from . import utils, helpers
from ..core.db import Session, engine
from app.payments import client

MAX_RETRIES = 3
_cache = {}

class OrderService(Base):
    timeout = 5
    def place(self, order):
        def inner():
            pass
        return inner()

    @staticmethod
    def _validate(order):
        pass

def create_app():
    local = 1
    return local

async def _private():
    pass
`);
        assertSymbols(r, [
            'class OrderService*',
            'function _private',
            'function create_app*',
            'method OrderService._validate',
            'method OrderService.place',
            'variable MAX_RETRIES*',
            'variable _cache',
        ]);
        const bySource = Object.fromEntries(r.imports.map((i) => [i.source, i.specifiers]));
        assert.deepStrictEqual(bySource, {
            os: [],
            'app.models.user': [],
            '.': ['utils', 'helpers'],
            '..core.db': ['Session', 'engine'],
            'app.payments': ['client'],
        });
    });

    test('Java: package, imports, public types, methods', async () => {
        const r = await analyzeSource('OrderService.java', `
package com.acme.orders;

import com.acme.payments.PaymentClient;
import com.acme.util.*;
import static com.acme.util.Strings.isBlank;

public class OrderService implements Service {
    private final PaymentClient client;
    public boolean place(String id) { return !isBlank(id); }
    private void audit() {}
    static class Inner { void run() {} }
}
interface Hidden {}
public enum Status { ACTIVE }
public record Order(String id) {}
`);
        assert.strictEqual(r.namespace, 'com.acme.orders');
        assertSymbols(r, [
            'class OrderService*',
            'class OrderService.Inner',
            'class Order*',
            'enum Status*',
            'interface Hidden',
            'method Inner.run',
            'method OrderService.audit',
            'method OrderService.place',
        ]);
        assert.deepStrictEqual(
            r.imports.map((i) => i.source).sort(),
            ['com.acme.payments.PaymentClient', 'com.acme.util.*', 'com.acme.util.Strings.isBlank']
        );
        assert.ok(r.references?.includes('PaymentClient'));
    });

    test('Kotlin: package, imports, classes, objects, functions, visibility', async () => {
        const r = await analyzeSource('Orders.kt', `
package com.acme.orders

import com.acme.payments.PaymentClient
import com.acme.util.*

class OrderService(private val client: PaymentClient) {
    fun place(id: String): Boolean {
        return true
    }
}

object Registry {
    fun lookup(): Int {
        return 1
    }
}

private fun helper(): Int {
    return 2
}

fun publicTop() = 3
`);
        assert.strictEqual(r.namespace, 'com.acme.orders');
        assertSymbols(r, [
            'class OrderService*',
            'class Registry*',
            'function helper',
            'function publicTop*',
            'method OrderService.place',
            'method Registry.lookup',
        ]);
        assert.deepStrictEqual(r.imports.map((i) => i.source).sort(), ['com.acme.payments.PaymentClient', 'com.acme.util.*']);
    });

    test('Go: package, imports, receivers, exported names', async () => {
        const r = await analyzeSource('server.go', `
package server

import (
    "fmt"
    db "example.com/app/internal/db"
)
import "net/http"

type Server struct { store *db.Store }
type Handler interface { Serve() }
type ID string

func New() *Server { return &Server{} }
func (s *Server) Start() error { return nil }
func (s Server) stop() {}
func helper() {}
`);
        assert.strictEqual(r.namespace, 'server');
        assertSymbols(r, [
            'class Server*',
            'function New*',
            'function helper',
            'interface Handler*',
            'method Server.Start',
            'method Server.stop',
            'type ID*',
        ]);
        assert.deepStrictEqual(r.imports.map((i) => i.source).sort(), ['example.com/app/internal/db', 'fmt', 'net/http']);
        assert.ok(r.references?.includes('Store'));
    });

    test('Rust: items, impl methods, mod declarations, use trees', async () => {
        const r = await analyzeSource('src/lib.rs', `
mod config;
pub mod handlers;
mod inline { fn hidden() {} }
use crate::models::{User, order::Order};
use std::collections::HashMap;
use super::util as u;

pub struct Server { port: u16 }
enum State { On, Off }
pub trait Service { fn call(&self); fn ready(&self) -> bool { true } }
pub type Result<T> = std::result::Result<T, Error>;

impl Server {
    pub fn new() -> Self { Server { port: 0 } }
    fn bind(&self) {}
}
impl<T> Service for Wrapper<T> { fn call(&self) {} }
pub fn run() {}
fn internal() {}
`);
        assertSymbols(r, [
            'class Server*',
            'enum State',
            'function internal',
            'function run*',
            'interface Service*',
            'method Server.bind',
            'method Server.new',
            'method Service.ready',
            'method Wrapper.call',
            'module inline',
            'type Result*',
        ]);
        assert.deepStrictEqual(r.imports.map((i) => i.source).sort(), [
            'crate::models::User',
            'crate::models::order::Order',
            'mod:config',
            'mod:handlers',
            'std::collections::HashMap',
            'super::util',
        ]);
    });

    test('C#: namespaces, usings, types, members, modifiers', async () => {
        const r = await analyzeSource('OrderService.cs', `
using System;
using Acme.Payments;
using static Acme.Util.Strings;
using Json = System.Text.Json;
global using Acme.Shared;

namespace Acme.Orders
{
    public class OrderService
    {
        public bool Place(string id) { return true; }
        private void Audit() {}
    }
    internal interface IRepo { int Find(); }
    public record Order(string Id);
    public struct Money {}
    public enum Status { Active }
}
`);
        assert.strictEqual(r.namespace, 'Acme.Orders');
        assertSymbols(r, [
            'class Money*',
            'class OrderService*',
            'class Order*',
            'enum Status*',
            'interface IRepo',
            'method IRepo.Find',
            'method OrderService.Audit',
            'method OrderService.Place',
        ]);
        assert.deepStrictEqual(
            r.imports.map((i) => i.source).sort(),
            ['Acme.Payments', 'Acme.Shared', 'Acme.Util.Strings', 'System', 'System.Text.Json']
        );

        const fileScoped = await analyzeSource('Invoice.cs', 'namespace Acme.Billing;\npublic class Invoice {}\n');
        assert.strictEqual(fileScoped.namespace, 'Acme.Billing');
    });

    test('PHP: namespace, use (incl. groups), includes, types', async () => {
        const r = await analyzeSource('UserController.php', `<?php
namespace App\\Http\\Controllers;

use App\\Models\\User;
use App\\Services\\{Billing, Mailer as M};
require_once __DIR__ . '/helpers.php';
include 'config.php';

class UserController extends Controller {
    public function show($id) { return User::find($id); }
}
interface Shape {}
trait Loggable {}
enum Suit { case Hearts; }
function helper() {}
`);
        assert.strictEqual(r.namespace, 'App\\Http\\Controllers');
        assertSymbols(r, [
            'class UserController*',
            'enum Suit*',
            'function helper*',
            'interface Loggable*',
            'interface Shape*',
            'method UserController.show',
        ]);
        assert.deepStrictEqual(r.imports.map((i) => i.source).sort(), [
            '/helpers.php',
            'App\\Models\\User',
            'App\\Services\\Billing',
            'App\\Services\\Mailer',
            'config.php',
        ]);
    });

    test('records 0-based line ranges', async () => {
        const r = await analyzeSource('lines.ts', 'import a from "./a";\n\nexport function f() {\n  return 1;\n}\n');
        const f = r.symbols.find((s) => s.name === 'f')!;
        assert.deepStrictEqual([f.startLine, f.endLine], [2, 4]);
        assert.strictEqual(r.imports[0].line, 0);
    });

    test('skips binary content', async () => {
        const a = await getAnalyzer();
        assert.strictEqual(await a.analyzeFile('/virtual/bin.ts', 'abc\u0000def'), undefined);
    });
});

suite('Extraction (regex fallback)', () => {
    test('TypeScript top-level declarations and imports', () => {
        const r = analyzeWithRegex(
            "import { a } from './a';\nexport class Foo {\n}\nfunction bar() {}\nconst x = require('./x');\n",
            '/v/a.ts',
            'typescript'
        )!;
        assert.strictEqual(r.parser, 'regex');
        assertSymbols(r, ['class Foo*', 'function bar']);
        assert.deepStrictEqual(r.imports.map((i) => i.source), ['./a', './x']);
    });

    test('Go import blocks and Rust use trees', () => {
        const go = analyzeWithRegex('package x\nimport (\n  "fmt"\n  db "a/b/db"\n)\nfunc Run() {}\n', '/v/x.go', 'go')!;
        assert.deepStrictEqual(go.imports.map((i) => i.source), ['fmt', 'a/b/db']);
        assertSymbols(go, ['function Run*']);

        const rs = analyzeWithRegex('mod a;\nuse crate::{b, c::D};\npub fn f() {}\n', '/v/lib.rs', 'rust')!;
        assert.deepStrictEqual(rs.imports.map((i) => i.source), ['mod:a', 'crate::b', 'crate::c::D']);
    });
});
