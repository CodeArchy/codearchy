import { describe, test } from 'vitest';
import * as assert from 'node:assert';
import { analyzeSource, assertSymbols } from '../helpers.js';

describe('Ruby', () => {
    test('modules, classes, methods, constants and requires', async () => {
        const r = await analyzeSource('billing.rb', `
require 'json'
require_relative 'models/user'
require_relative '../lib/util'
load 'tasks/setup.rb'

VERSION = '1.0'

module Billing
  RATE = 3
  class Invoice < Base
    def initialize(total); end
    def self.build; end
  end
  class Admin::Report; end
end

def helper; end
`);
        assert.strictEqual(r.parser, 'tree-sitter');
        assertSymbols(r, [
            'class Billing.Admin::Report*',
            'class Billing.Invoice*',
            'function helper*',
            'method Invoice.build*',
            'method Invoice.initialize*',
            'module Billing*',
            'variable VERSION*',
        ]);
        assert.deepStrictEqual(r.imports.map((i) => i.source), ['json', './models/user', '../lib/util', 'tasks/setup.rb']);
    });

    test('private and protected sections, and `private def`, hide methods', async () => {
        const r = await analyzeSource('svc.rb', `
class Service
  def call; end

  protected

  def guarded; end

  private

  def hidden; end

  public

  def visible_again; end

  private def inline_hidden; end
end
`);
        assertSymbols(r, [
            'class Service*',
            'method Service.call*',
            'method Service.guarded',
            'method Service.hidden',
            'method Service.inline_hidden',
            'method Service.visible_again*',
        ]);
    });

    test('calls named like require but with no string literal are not imports', async () => {
        const r = await analyzeSource('dyn.rb', `
require name
require_relative File.join('a', 'b')
requires 'x'
`);
        assert.deepStrictEqual(r.imports, []);
    });
});
