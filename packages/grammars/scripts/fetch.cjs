#!/usr/bin/env node
/**
 * Populates wasm/ with the grammar .wasm files pinned in grammars.json:
 * npm tarballs downloaded, verified against their registry integrity hash,
 * and extracted without running any package install scripts.
 *
 * Hosts read the grammars from here (platform-node) or copy them into their
 * bundle (the VS Code extension's parsers/, the PWA's static assets).
 *
 * Usage: node scripts/fetch.cjs [--force]
 * Existing files are kept unless --force is given; a stamp file records which
 * versions produced them so a bumped manifest triggers a refresh.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const PARSERS_DIR = path.join(ROOT, 'wasm');
const MANIFEST = require('../grammars.json');
const STAMP = path.join(PARSERS_DIR, '.grammars-stamp.json');
const REGISTRY = 'https://registry.npmjs.org';
const force = process.argv.includes('--force');

function tarballUrl(pkg, version) {
    const bare = pkg.startsWith('@') ? pkg.split('/')[1] : pkg;
    return `${REGISTRY}/${pkg}/-/${bare}-${version}.tgz`;
}

function download(url, redirects = 5) {
    return new Promise((resolve, reject) => {
        https
            .get(url, { headers: { 'User-Agent': 'codearchy-build' } }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
                    res.resume();
                    resolve(download(new URL(res.headers.location, url).toString(), redirects - 1));
                    return;
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                    return;
                }
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks)));
                res.on('error', reject);
            })
            .on('error', reject);
    });
}

function verifyIntegrity(buffer, integrity, label) {
    const [algo, expected] = integrity.split('-', 2);
    const actual = crypto.createHash(algo).update(buffer).digest('base64');
    if (actual !== expected) {
        throw new Error(`integrity mismatch for ${label}: expected ${integrity}, got ${algo}-${actual}`);
    }
}

/** Minimal ustar reader: returns Map<path, Buffer> for regular files. */
function readTar(buffer) {
    const files = new Map();
    let offset = 0;
    let longName;
    while (offset + 512 <= buffer.length) {
        const header = buffer.subarray(offset, offset + 512);
        if (header.every((b) => b === 0)) break;
        const field = (start, len) => header.subarray(start, start + len).toString('utf8').replace(/\0.*$/s, '');
        let name = field(0, 100);
        const size = parseInt(field(124, 12).trim() || '0', 8);
        const type = String.fromCharCode(header[156] || 48);
        const prefix = field(345, 155);
        if (prefix) name = `${prefix}/${name}`;
        const dataStart = offset + 512;
        const data = buffer.subarray(dataStart, dataStart + size);
        if (type === 'L') {
            longName = data.toString('utf8').replace(/\0.*$/s, '');
        } else {
            if (longName) {
                name = longName;
                longName = undefined;
            }
            if (type === '0' || type === '\0') files.set(name, data);
        }
        offset = dataStart + Math.ceil(size / 512) * 512;
    }
    return files;
}


async function main() {
    fs.mkdirSync(PARSERS_DIR, { recursive: true });
    let stamp = {};
    try {
        stamp = JSON.parse(fs.readFileSync(STAMP, 'utf8'));
    } catch {
        // first run
    }

    console.log('Preparing tree-sitter grammars...');
    const next = { grammars: {} };
    let failures = 0;

    for (const g of MANIFEST.grammars) {
        const key = `${g.package}@${g.version}`;
        const present = g.files.every((f) => fs.existsSync(path.join(PARSERS_DIR, f)));
        if (!force && present && stamp.grammars?.[g.package] === g.version) {
            console.log(`  ✓ ${key} (cached)`);
            next.grammars[g.package] = g.version;
            continue;
        }
        try {
            const tgz = await download(tarballUrl(g.package, g.version));
            verifyIntegrity(tgz, g.integrity, key);
            const entries = readTar(zlib.gunzipSync(tgz));
            for (const file of g.files) {
                const data = entries.get(`package/${file}`);
                if (!data) throw new Error(`${file} not found in ${key}`);
                fs.writeFileSync(path.join(PARSERS_DIR, file), data);
            }
            next.grammars[g.package] = g.version;
            console.log(`  ↓ ${key} → ${g.files.join(', ')}`);
        } catch (err) {
            failures++;
            console.error(`  ✗ ${key}: ${err.message}`);
        }
    }

    fs.writeFileSync(STAMP, `${JSON.stringify(next, null, 2)}\n`);
    if (failures > 0) {
        console.error(`\n${failures} grammar(s) failed; those languages will use the regex fallback.`);
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
