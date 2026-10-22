import { App, Notice, TAbstractFile, TFile } from 'obsidian';

/**
 * How long a tab must be idle before its text is written. Every write is a
 * file change the Obsidian Linter reacts to by rewriting the file, so writes
 * wait for a pause in typing rather than landing on every poll.
 */
const WRITE_IDLE_MS = 800;

/** A note open in one of the panel's tabs, and what the plugin knows about it. */
export interface Binding {
	/** The tab's id in the panel. */
	id: string;
	file: TFile;
	/** The text disk and panel last agreed on. */
	lastWritten: string;
	/** Panel text not yet written. */
	pending: string | null;
	changedAt: number;
}

/** The notes open in the panel's tabs, and the writing of what is typed into them. */
export class Notes {
	private readonly bindings = new Map<string, Binding>();
	private writes: Promise<void> = Promise.resolve();
	private nextId = 1;

	constructor(private readonly app: App) {}

	get size(): number {
		return this.bindings.size;
	}

	get(id: string): Binding | undefined {
		return this.bindings.get(id);
	}

	byFile(file: TAbstractFile): Binding | undefined {
		for (const b of this.bindings.values()) if (b.file === file) return b;
		return undefined;
	}

	/** Whether this binding is still open, rather than closed - and perhaps reopened - since. */
	has(b: Binding): boolean {
		return this.bindings.get(b.id) === b;
	}

	add(file: TFile, text: string): Binding {
		const b: Binding = { id: `tab-${this.nextId++}`, file, lastWritten: text, pending: null, changedAt: 0 };
		this.bindings.set(b.id, b);
		return b;
	}

	/** Text typed in a tab, to be written once typing pauses. */
	edited(id: string, text: string): void {
		const b = this.bindings.get(id);
		if (!b) return;
		b.pending = text;
		b.changedAt = Date.now();
	}

	/** Write the tabs idle long enough. */
	writeIdle(): void {
		const now = Date.now();
		for (const b of this.bindings.values()) {
			if (b.pending !== null && now - b.changedAt >= WRITE_IDLE_MS) void this.save(b);
		}
	}

	/** Write pending text - one note's, or every open note's. Writes are chained so two never overlap. */
	save(only?: Binding): Promise<void> {
		this.writes = this.writes.then(async () => {
			for (const b of only ? [only] : Array.from(this.bindings.values())) await this.write(b);
		});
		return this.writes;
	}

	/** Stop tracking a closed tab's note, once what it has pending is written. */
	remove(id: string): Promise<void> {
		const b = this.bindings.get(id);
		if (!b) return Promise.resolve();
		this.bindings.delete(id);
		return this.save(b);
	}

	/** Stop tracking a note without writing it: it was deleted. */
	discard(id: string): void {
		this.bindings.delete(id);
	}

	clear(): void {
		this.bindings.clear();
	}

	/**
	 * Start every pending write without waiting, for unload paths that cannot
	 * await. They may not finish - up to about a second of typing.
	 */
	flushNow(): void {
		for (const b of this.bindings.values()) {
			if (b.pending !== null && b.pending !== b.lastWritten) void this.app.vault.modify(b.file, b.pending);
		}
	}

	private async write(b: Binding): Promise<void> {
		if (b.pending === null) return;
		const text = b.pending;
		b.pending = null;
		if (text === b.lastWritten) return;
		b.lastWritten = text;
		try {
			await this.app.vault.modify(b.file, text);
		} catch (e) {
			console.error('Float Note: could not save the note', e);
			new Notice('Float Note: could not save the floating note. See the console.');
		}
	}
}
