#!/usr/bin/env node
/**
 * The npm package, as users get it: `npm pack` apps/cli/npm, install the
 * tarball into an empty folder (no workspace, no node_modules around it), then
 *   codearchy --version / --help
 *   codearchy mcp     on the polyglot fixture: initialize, then the overview tool
 *                     (38 files, all 10 languages, every file parsed with tree-sitter
 *                     from the packaged grammars)
 *   codearchy serve   prints its pairing link
 *
 * Usage: node scripts/smoke-package.mjs   (after scripts/package.mjs)
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(CLI, 'npm');
const FIXTURE = path.join(CLI, '..', '..', 'fixtures', 'polyglot');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });

assert.ok(fs.existsSync(path.join(PKG, 'package.json')), 'run scripts/package.mjs first');
const version = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')).version;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'codearchy-npm-'));
const started = Date.now();
try {
    const tarball = path.join(work, run(npm, ['pack', PKG, '--pack-destination', work, '--silent'], work).trim().split('\n').pop());
    const size = fs.statSync(tarball).size;
    const home = path.join(work, 'project');
    fs.mkdirSync(home);
    run(npm, ['install', '--no-audit', '--no-fund', '--silent', tarball], home);
    const bin = path.join(home, 'node_modules', 'codearchy', 'dist', 'main.js');
    assert.ok(fs.existsSync(path.join(home, 'node_modules', '.bin', process.platform === 'win32' ? 'codearchy.cmd' : 'codearchy')), 'the codearchy command is installed');
    // Nothing else is installed: the bundle carries every dependency.
    assert.deepEqual(fs.readdirSync(path.join(home, 'node_modules')).filter((d) => !d.startsWith('.')), ['codearchy']);

    assert.equal(run(process.execPath, [bin, '--version'], home).trim(), version);
    assert.match(run(process.execPath, [bin, '--help'], home), /codearchy serve/);

    // MCP: the whole engine (discovery, tree-sitter with the packaged grammars, the hierarchy).
    const { overview, log } = await mcpOverview(bin, FIXTURE);
    const index = JSON.parse(overview).index;
    assert.equal(index.files, 38, overview.slice(0, 600));
    assert.equal(index.languages.length, 10, `all 10 languages: ${index.languages}`);
    // Parsed with the packaged grammars, not the regex fallback.
    assert.match(log, /all with tree-sitter/, log);

    // The Companion prints its pairing link.
    const link = await serveLink(bin, FIXTURE);
    assert.match(link, /#pair=/);

    console.log(`✓ codearchy@${version}: ${(size / 1e6).toFixed(1)} MB tarball, installs alone; --version, --help, mcp overview (polyglot), serve pairing link (${Date.now() - started} ms)`);
} finally {
    fs.rmSync(work, { recursive: true, force: true });
}

function mcpOverview(bin, root) {
    return new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, [bin, 'mcp', '--root', root], { stdio: ['pipe', 'pipe', 'pipe'] });
        const timer = setTimeout(() => (proc.kill(), reject(new Error('mcp: no overview within 120 s'))), 120_000);
        let buffer = '';
        let stderr = '';
        proc.stderr.on('data', (d) => (stderr += d));
        proc.on('exit', (code) => code && reject(new Error(`mcp exited ${code}: ${stderr}`)));
        const send = (msg) => proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
        proc.stdout.on('data', (d) => {
            buffer += d;
            let nl;
            while ((nl = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, nl);
                buffer = buffer.slice(nl + 1);
                if (!line.trim()) continue;
                const msg = JSON.parse(line);
                if (msg.id === 1) {
                    send({ method: 'notifications/initialized' });
                    send({ id: 2, method: 'tools/call', params: { name: 'overview', arguments: {} } });
                } else if (msg.id === 2) {
                    clearTimeout(timer);
                    proc.kill();
                    if (msg.error) return reject(new Error(`overview: ${msg.error.message}`));
                    resolve({ overview: msg.result.content.map((c) => c.text ?? '').join('\n'), log: stderr });
                }
            }
        });
        send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } });
    });
}

function serveLink(bin, root) {
    return new Promise((resolve, reject) => {
        // A throwaway HOME: the Companion keeps its authorship ledger there.
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codearchy-npm-home-'));
        const proc = spawn(process.execPath, [bin, 'serve', '--root', root, '--app', 'http://127.0.0.1:9'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: home, USERPROFILE: home } });
        const timer = setTimeout(() => (proc.kill(), reject(new Error('serve: no pairing link within 120 s'))), 120_000);
        let out = '';
        proc.stdout.on('data', (d) => {
            out += d;
            const m = /(https?:\/\/\S+#pair=\S+)/.exec(out);
            if (m) {
                clearTimeout(timer);
                proc.kill();
                resolve(m[1]);
            }
        });
        proc.on('exit', (code) => code && reject(new Error(`serve exited ${code}: ${out}`)));
    });
}
