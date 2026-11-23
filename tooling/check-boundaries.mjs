#!/usr/bin/env node
/**
 * Enforces the package dependency rules (ARCHITECTURE: "Dependency rules"):
 *
 *   protocol, sdk         depend on no other @codearchy package
 *   core                  protocol + sdk + language packs (no platform, no UI)
 *   lang-*                sdk (+ other packs)             (one package per language)
 *   treesitter            core + sdk                      (shared adapter)
 *   grammars              nothing                          (assets)
 *   platform-*            core, protocol, sdk, treesitter, grammars
 *   ui                    protocol only                   (renders views from an EngineClient)
 *   providers             no @codearchy packages          (AI provider adapters; vendor SDKs allowed)
 *   apps/*                anything (composition roots)
 *
 * Also checked by the compiler: core and sdk build with no DOM and no Node
 * types, so they can't call host APIs even indirectly.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const ALLOWED = {
    '@codearchy/protocol': [],
    '@codearchy/sdk': [],
    '@codearchy/core': ['@codearchy/protocol', '@codearchy/sdk', 'lang:*'],
    '@codearchy/treesitter': ['@codearchy/core', '@codearchy/sdk'],
    '@codearchy/grammars': [],
    '@codearchy/platform-node': ['@codearchy/core', '@codearchy/protocol', '@codearchy/sdk', '@codearchy/treesitter', '@codearchy/grammars'],
    '@codearchy/platform-browser': ['@codearchy/core', '@codearchy/protocol', '@codearchy/sdk', '@codearchy/treesitter'],
    '@codearchy/conformance': ['@codearchy/core', '@codearchy/protocol', '@codearchy/sdk'],
    // The UI renders views; it never runs the engine itself (data comes through EngineClient).
    '@codearchy/ui': ['@codearchy/protocol'],
    // Talks to model providers; knows nothing about the engine, so any host can use it.
    '@codearchy/providers': [],
};
/** Packages that must not depend on vscode, DOM-only or Node-only runtime libraries. */
const NO_HOST_DEPS = ['@codearchy/protocol', '@codearchy/sdk', '@codearchy/core'];
/** Language packs: the SDK and other packs only (a pack may build on another, e.g. TypeScript on JavaScript). */
const isLangPack = (name) => name.startsWith('@codearchy/lang-');

let failures = 0;
const packageDirs = [
    ...fs.readdirSync(path.join(ROOT, 'packages')).map((d) => path.join(ROOT, 'packages', d)),
    ...fs.readdirSync(path.join(ROOT, 'packages', 'languages')).map((d) => path.join(ROOT, 'packages', 'languages', d)),
];
for (const dir of packageDirs) {
    const file = path.join(dir, 'package.json');
    if (!fs.existsSync(file)) continue;
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const allowed = isLangPack(pkg.name) ? ['@codearchy/sdk', 'lang:*'] : ALLOWED[pkg.name];
    if (!allowed) {
        console.error(`✗ ${pkg.name}: not listed in tooling/check-boundaries.mjs (add its allowed dependencies)`);
        failures++;
        continue;
    }
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies });
    for (const dep of deps.filter((d) => d.startsWith('@codearchy/'))) {
        if (!allowed.includes(dep) && !(allowed.includes('lang:*') && isLangPack(dep))) {
            console.error(`✗ ${pkg.name} must not depend on ${dep}`);
            failures++;
        }
    }
    if (NO_HOST_DEPS.includes(pkg.name) || isLangPack(pkg.name)) {
        for (const dep of deps.filter((d) => !d.startsWith('@codearchy/'))) {
            console.error(`✗ ${pkg.name} must stay dependency-free of host libraries, found ${dep}`);
            failures++;
        }
    }
}
if (failures) {
    console.error(`\n${failures} dependency-rule violation(s).`);
    process.exit(1);
}
console.log('✓ package dependency rules hold');
