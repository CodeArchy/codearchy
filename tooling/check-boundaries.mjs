#!/usr/bin/env node
/**
 * Enforces the package dependency rules (ARCHITECTURE: "Dependency rules"):
 *
 *   protocol, sdk         depend on no other @codearchy package
 *   core                  protocol + sdk only            (no platform, no UI)
 *   treesitter            core + sdk                      (shared adapter)
 *   grammars              nothing                          (assets)
 *   platform-*            core, protocol, sdk, treesitter, grammars
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
    '@codearchy/core': ['@codearchy/protocol', '@codearchy/sdk'],
    '@codearchy/treesitter': ['@codearchy/core', '@codearchy/sdk'],
    '@codearchy/grammars': [],
    '@codearchy/platform-node': ['@codearchy/core', '@codearchy/protocol', '@codearchy/sdk', '@codearchy/treesitter', '@codearchy/grammars'],
};
/** Packages that must not depend on vscode, DOM-only or Node-only runtime libraries. */
const NO_HOST_DEPS = ['@codearchy/protocol', '@codearchy/sdk', '@codearchy/core'];

let failures = 0;
for (const dir of fs.readdirSync(path.join(ROOT, 'packages'))) {
    const file = path.join(ROOT, 'packages', dir, 'package.json');
    if (!fs.existsSync(file)) continue;
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const allowed = ALLOWED[pkg.name];
    if (!allowed) {
        console.error(`✗ ${pkg.name}: not listed in tooling/check-boundaries.mjs (add its allowed dependencies)`);
        failures++;
        continue;
    }
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies });
    for (const dep of deps.filter((d) => d.startsWith('@codearchy/'))) {
        if (!allowed.includes(dep)) {
            console.error(`✗ ${pkg.name} must not depend on ${dep}`);
            failures++;
        }
    }
    if (NO_HOST_DEPS.includes(pkg.name)) {
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
