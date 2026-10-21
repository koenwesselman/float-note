import { Notice, Platform, Plugin, TAbstractFile, TFile } from 'obsidian';
import { readEditingMode } from './editing-mode';
import { openLink, renderedLanguages, unresolvedLinks } from './links';
import type { Bounds } from './native';
import { FloatPanel, PanelContent, sweepOrphanPanels, writePanelPage } from './panel';
import { DEFAULT_SETTINGS, FloatNoteSettings, FloatNoteSettingTab } from './settings';
import { answerRenderRequests } from './snippets';
import { buildViewDocument } from './view';

/**
 * How long the panel must be idle before its text is written. Every write is
 * a file change the Obsidian Linter reacts to by rewriting the file, so writes
 * wait for a pause in typing rather than landing on every poll.
 */
const WRITE_IDLE_MS = 800;

/** How long after the last move or resize the panel's bounds are saved. */
const BOUNDS_SAVE_MS = 1000;

/** The note the panel is editing, and what the plugin knows about it. */
interface Binding {
	file: TFile;
	/** The text disk and panel last agreed on. */
	lastWritten: string;
	/** Panel text not yet written. */
	pending: string | null;
	changedAt: number;
}

export default class FloatNotePlugin extends Plugin {
	settings!: FloatNoteSettings;
	panel: FloatPanel | null = null;
	private binding: Binding | null = null;
	private pagePath = '';
	private busy = false;
	private writes: Promise<void> = Promise.resolve();
	private boundsTimer: number | null = null;

	async onload() {
		await this.loadSettings();

		// The panel relies on macOS window behaviour - a panel-type window over
		// full-screen Spaces - and is tested nowhere else. Elsewhere the commands
		// stay registered and say so, rather than vanishing without explanation.
		if (Platform.isMacOS) {
			const swept = sweepOrphanPanels();
			if (swept) this.log('orphans-swept', { count: swept });
		}

		this.addCommand({
			id: 'float-current-note',
			name: 'Float current note',
			callback: () => this.floatCurrentNote(),
		});

		this.addCommand({
			id: 'toggle-float-overlay',
			name: 'Toggle float overlay',
			callback: () => this.toggleOverlay(),
		});

		this.addCommand({
			id: 'close-float-overlay',
			name: 'Close float overlay',
			callback: () => {
				this.log('close-requested', { source: 'command' });
				return this.closePanel();
			},
		});

		// Cmd+E does this inside the panel; this is for when the panel does not have focus.
		this.addCommand({
			id: 'toggle-float-view',
			name: 'Toggle float view',
			checkCallback: (checking) => {
				if (!this.panel) return false;
				if (!checking) void this.panel.toggleMode();
				return true;
			},
		});

		this.addCommand({
			id: 'toggle-float-source-mode',
			name: 'Toggle float source mode',
			checkCallback: (checking) => {
				if (!this.panel) return false;
				if (!checking) void this.panel.toggleSource();
				return true;
			},
		});

		this.registerEvent(this.app.vault.on('modify', (file) => this.onVaultModify(file)));
		this.registerEvent(
			this.app.vault.on('rename', (file) => {
				if (this.panel && file instanceof TFile && file === this.binding?.file) void this.panel.setName(file.basename);
			}),
		);
		// Live Preview dims links to notes that do not exist; which those are changes as the note is saved and indexed.
		this.registerEvent(
			this.app.metadataCache.on('resolve', (file) => {
				if (this.panel && file === this.binding?.file) void this.panel.setUnresolved(unresolvedLinks(this.app, file));
			}),
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (file !== this.binding?.file) return;
				new Notice('Float Note: the floating note was deleted, so the panel was closed.');
				if (this.binding) this.binding.pending = null;
				this.closePanelNow();
			}),
		);

		// The panel lives in Electron's main process and would outlive the
		// plugin, unable to save. It goes when the main window does.
		this.registerDomEvent(window, 'beforeunload', () => {
			this.log('main-beforeunload');
			this.flushBounds();
			this.closePanelNow();
		});

		this.addSettingTab(new FloatNoteSettingTab(this.app, this));
	}

	onunload() {
		this.flushBounds();
		this.closePanelNow();
	}

	/** Save bounds still waiting on their debounce. Best effort: unload paths cannot await. */
	private flushBounds(): void {
		if (this.boundsTimer === null) return;
		window.clearTimeout(this.boundsTimer);
		this.boundsTimer = null;
		void this.saveSettings();
	}

	async floatCurrentNote(): Promise<void> {
		if (!Platform.isMacOS) {
			new Notice('Float Note works on macOS only.');
			return;
		}
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice('Float Note: no active note to float.');
			return;
		}
		if (this.busy) return;
		this.busy = true;
		try {
			if (this.panel?.isAlive()) {
				await this.saveNow();
				const text = await this.app.vault.read(file);
				this.binding = { file, lastWritten: text, pending: null, changedAt: 0 };
				await this.panel.show(this.content(file, text));
				this.log('panel-retargeted', { path: file.path });
				return;
			}
			this.closePanelNow();
			sweepOrphanPanels();
			if (!this.pagePath) this.pagePath = await writePanelPage(this.app.vault.adapter, `${this.manifest.dir}/panel.html`);
			const text = await this.app.vault.read(file);
			this.binding = { file, lastWritten: text, pending: null, changedAt: 0 };
			this.panel = await FloatPanel.open(
				this.pagePath,
				this.content(file, text),
				() => this.settings,
				(event, extra) => this.log(event, extra),
				{
					onText: (changed) => this.onPanelText(changed),
					onCloseRequested: (source) => {
						this.log('close-requested', { source });
						void this.closePanel();
					},
					onViewRequested: () => void this.renderView(),
					onRenderRequests: (requests) => {
						const b = this.binding;
						if (b && this.panel) void answerRenderRequests(this.app, b.file, this.panel, requests, (event, extra) => this.log(event, extra));
					},
					onOpenLink: (link) => {
						this.log('link-opened', { external: link.external });
						if (this.binding) openLink(this.app, this.binding.file, link);
					},
					onBounds: (bounds) => this.rememberBounds(bounds),
					onTick: () => this.writeIfIdle(),
				},
			);
			this.log('panel-opened', { path: file.path });
		} catch (e) {
			console.error('Float Note: could not open the panel', e);
			new Notice('Float Note: could not open the panel. See the console.');
			this.closePanelNow();
		} finally {
			this.busy = false;
		}
	}

	/** What the panel needs to show a note. */
	private content(file: TFile, text: string): PanelContent {
		return {
			name: file.basename,
			text,
			editingMode: readEditingMode(this.app),
			unresolved: unresolvedLinks(this.app, file),
			renderedLanguages: renderedLanguages(),
		};
	}

	/** Hide or show the open panel; with none open, float the current note. */
	async toggleOverlay(): Promise<void> {
		const panel = this.panel;
		if (!panel?.isAlive()) return this.floatCurrentNote();
		if (panel.isVisible()) {
			// Saved now rather than left to the idle timer, so nothing waits on a window nobody can see.
			const text = await panel.drain();
			if (text !== null) this.onPanelText(text);
			await this.saveNow();
			panel.resumePolling();
			panel.hide();
		} else {
			panel.unhide();
		}
	}

	private rememberBounds(bounds: Bounds): void {
		this.settings.bounds = bounds;
		if (this.boundsTimer !== null) window.clearTimeout(this.boundsTimer);
		this.boundsTimer = window.setTimeout(() => {
			this.boundsTimer = null;
			void this.saveSettings();
		}, BOUNDS_SAVE_MS);
	}

	/** Save what the panel holds, then close it. The path every close from the panel or palette takes. */
	async closePanel(): Promise<void> {
		const panel = this.panel;
		if (!panel) return;
		this.panel = null;
		const text = await panel.drain();
		if (text !== null) this.onPanelText(text);
		await this.saveNow();
		panel.close();
		this.binding = null;
	}

	/**
	 * Close without waiting, for unload paths that cannot await. A pending
	 * write is started but may not finish - up to about a second of typing.
	 */
	closePanelNow(): void {
		const b = this.binding;
		if (b?.pending != null && b.pending !== b.lastWritten) {
			void this.app.vault.modify(b.file, b.pending);
		}
		this.panel?.close();
		this.panel = null;
		this.binding = null;
	}

	private onPanelText(text: string): void {
		if (!this.binding) return;
		this.binding.pending = text;
		this.binding.changedAt = Date.now();
	}

	private writeIfIdle(): void {
		const b = this.binding;
		if (b?.pending != null && Date.now() - b.changedAt >= WRITE_IDLE_MS) void this.saveNow();
	}

	/** Write pending panel text. Writes are chained so two never overlap. */
	private saveNow(): Promise<void> {
		this.writes = this.writes.then(async () => {
			const b = this.binding;
			if (!b || b.pending === null) return;
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
		});
		return this.writes;
	}

	/**
	 * Render the panel's text - pending edits included, so View shows what was
	 * just typed - with Obsidian's renderer, and show it in the panel.
	 */
	private async renderView(): Promise<void> {
		const b = this.binding;
		const panel = this.panel;
		if (!b || !panel) return;
		const started = Date.now();
		try {
			const view = await buildViewDocument(this.app, b.file, b.pending ?? b.lastWritten, this.settings.debugLog ? `${this.manifest.dir}/last-view.html` : null);
			if (this.binding !== b || this.panel !== panel) return;
			await panel.showView(view.srcdoc);
			this.log('view-rendered', { ms: Date.now() - started, htmlBytes: view.htmlBytes, cssBytes: view.cssBytes, imagesRewritten: view.imagesRewritten });
		} catch (e) {
			console.error('Float Note: could not render the view', e);
			this.log('view-failed', { error: String(e) });
		}
	}

	/** A change from outside the panel - the main pane, the Linter, sync. */
	private onVaultModify(file: TAbstractFile): void {
		const b = this.binding;
		if (!this.panel || !b || file !== b.file) return;
		// Panel edits not yet saved win; the next save overwrites the change.
		if (b.pending !== null) return;
		void (async () => {
			const text = await this.app.vault.read(b.file);
			if (text === b.lastWritten || this.binding !== b || !this.panel) return;
			const applied = await this.panel.replace(text);
			if (applied) b.lastWritten = text;
			this.log('external-change', { applied });
			if (applied && this.panel.mode === 'view') await this.renderView();
		})();
	}

	/** One JSON line per event in debug.log beside main.js, when the setting is on. Never throws. */
	log(event: string, extra: Record<string, unknown> = {}): void {
		if (!this.settings.debugLog) return;
		try {
			const line = JSON.stringify({
				at: new Date().toISOString(),
				event,
				...extra,
				window: this.panel?.snapshot() ?? null,
			});
			this.app.vault.adapter
				.append(`${this.manifest.dir}/debug.log`, line + '\n')
				.catch((e) => console.error('Float Note: could not write debug.log', e));
		} catch (e) {
			console.error('Float Note: could not build a debug.log line', e);
		}
	}

	async loadSettings() {
		const data = ((await this.loadData()) ?? {}) as Partial<FloatNoteSettings> & Record<string, unknown>;
		// Settings from earlier versions, for working out what a panel needed:
		// a panel needs none of them (0.6.0).
		for (const key of ['skipTransformProcessType', 'fullScreenMethod', 'level']) delete data[key];
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
