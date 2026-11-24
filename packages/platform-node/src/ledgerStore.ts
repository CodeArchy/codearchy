/**
 * The authorship ledger on disk: one JSON file in the host's own storage (VS
 * Code's workspace storage, the Companion's data folder), never in the
 * workspace. Saves are debounced and atomic (write, then rename).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuthorshipLedger, contentHash } from '@codearchy/core';

export class FileLedgerStore {
    readonly ledger: AuthorshipLedger;
    private timer: NodeJS.Timeout | undefined;

    constructor(
        private readonly file: string,
        private readonly delayMs = 1500
    ) {
        let data: unknown;
        try {
            data = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            data = undefined; // first run, or unreadable: start empty
        }
        this.ledger = AuthorshipLedger.from(data);
    }

    /** Call after changing the ledger; writes once things settle. */
    changed(): void {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), this.delayMs);
    }

    flush(): void {
        clearTimeout(this.timer);
        this.timer = undefined;
        if (!this.ledger.takeChanged()) return;
        this.save();
    }

    /** Writes the ledger now, whatever its change flag says. */
    save(): void {
        clearTimeout(this.timer);
        this.timer = undefined;
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const tmp = `${this.file}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(this.ledger));
            fs.renameSync(tmp, this.file);
        } catch {
            // storage unavailable: the ledger lives on in memory for this session
        }
    }
}

/** The Companion's data folder for a workspace (outside the workspace): ~/.codearchy/companion/<hash>/. */
export function companionDataDir(root: string): string {
    return path.join(os.homedir(), '.codearchy', 'companion', contentHash(path.resolve(root)));
}
