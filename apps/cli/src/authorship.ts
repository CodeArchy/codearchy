/**
 * `codearchy authorship …`: authorship notes from the command line.
 *
 *   notes [--root <dir>] [--commit <rev>]   write the commit's note from the Companion's ledger
 *   hook install|uninstall [--root <dir>]   a post-commit hook that runs `notes` after each commit
 *
 * Notes stay local until you push them (`git push origin refs/notes/codearchy-authorship`).
 * The hook is only ever installed by you, and never replaces a hook it didn't write.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileLedgerStore, companionDataDir, writeAuthorshipNote } from '@codearchy/platform-node';

export const HOOK_MARKER = '# codearchy-authorship-hook';

export function ledgerFile(root: string): string {
    return path.join(companionDataDir(root), 'authorship-ledger.json');
}

export async function writeNotes(root: string, commit = 'HEAD'): Promise<string> {
    const { ledger } = new FileLedgerStore(ledgerFile(root));
    const result = await writeAuthorshipNote(root, (rel) => ledger.ranges(rel), async (rel) => {
        try {
            return await fs.promises.readFile(path.join(root, rel), 'utf8');
        } catch {
            return undefined;
        }
    }, commit);
    const head = `${result.commit.slice(0, 7)}`;
    if (!result.files.length) return `Nothing to note for ${head}: no recorded authorship for the files it changed.`;
    return `Wrote authorship for ${result.files.length} file(s) to the note on ${head}${result.skipped.length ? ` (${result.skipped.length} changed since the commit, left out)` : ''}. Share: git push origin refs/notes/codearchy-authorship`;
}

function hookPath(root: string): string {
    const p = execFileSync('git', ['rev-parse', '--git-path', 'hooks/post-commit'], { cwd: root, encoding: 'utf8' }).trim();
    return path.resolve(root, p);
}

/** The script: run this CLI's `authorship notes` for the workspace, quietly, never failing the commit. */
export function hookScript(root: string, main = fileURLToPath(new URL('./main.js', import.meta.url))): string {
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    return ['#!/bin/sh', HOOK_MARKER, '# Records which lines of the new commit AI tools wrote, as a git note (refs/notes/codearchy-authorship).', `${q(process.execPath)} ${q(main)} authorship notes --root ${q(root)} >/dev/null 2>&1 || true`, ''].join('\n');
}

export function installHook(root: string): string {
    const file = hookPath(root);
    if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').includes(HOOK_MARKER)) {
        return `${file} already exists and wasn't written by CodeArchy; left as it is. To add CodeArchy to it, append:\n  ${hookScript(root).split('\n')[3]}`;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, hookScript(root), { mode: 0o755 });
    return `Installed ${file}: each commit's authorship is written to its git note.`;
}

export function uninstallHook(root: string): string {
    const file = hookPath(root);
    if (!fs.existsSync(file)) return 'No post-commit hook to remove.';
    if (!fs.readFileSync(file, 'utf8').includes(HOOK_MARKER)) return `${file} wasn't written by CodeArchy; left as it is.`;
    fs.rmSync(file);
    return `Removed ${file}.`;
}
