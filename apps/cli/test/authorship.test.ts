import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HOOK_MARKER, hookScript, installHook, uninstallHook } from '../src/authorship.js';

function repo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codearchy-hook-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    return dir;
}

describe('codearchy authorship hook', () => {
    it('installs a post-commit hook that runs the notes command, and removes only its own', () => {
        const dir = repo();
        try {
            const hook = path.join(dir, '.git', 'hooks', 'post-commit');
            expect(installHook(dir)).toMatch(/Installed/);
            const text = fs.readFileSync(hook, 'utf8');
            expect(text.startsWith('#!/bin/sh\n')).toBe(true);
            expect(text).toContain(HOOK_MARKER);
            expect(text).toMatch(/authorship notes --root '.+' >\/dev\/null 2>&1 \|\| true/);
            if (process.platform !== 'win32') expect(fs.statSync(hook).mode & 0o111).not.toBe(0);
            expect(installHook(dir)).toMatch(/Installed/); // reinstalling its own hook is fine
            expect(uninstallHook(dir)).toMatch(/Removed/);
            expect(fs.existsSync(hook)).toBe(false);
            expect(uninstallHook(dir)).toMatch(/No post-commit hook/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("never replaces or removes a hook it didn't write", () => {
        const dir = repo();
        try {
            const hook = path.join(dir, '.git', 'hooks', 'post-commit');
            fs.mkdirSync(path.dirname(hook), { recursive: true });
            fs.writeFileSync(hook, '#!/bin/sh\necho mine\n');
            expect(installHook(dir)).toMatch(/already exists and wasn't written by CodeArchy/);
            expect(uninstallHook(dir)).toMatch(/wasn't written by CodeArchy/);
            expect(fs.readFileSync(hook, 'utf8')).toBe('#!/bin/sh\necho mine\n');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('quotes paths with spaces and quotes safely', () => {
        expect(hookScript("/tmp/it's here", '/opt/main.js')).toContain("--root '/tmp/it'\\''s here'");
    });
});
