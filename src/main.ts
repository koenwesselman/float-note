import { Notice, Platform, Plugin, TAbstractFile, TFile } from 'obsidian';
import { readEditingMode } from './editing-mode';
import { openLink, renderedLanguages, unresolvedLinks } from './links';
import type { Bounds } from './native';
import { Binding, Notes } from './notes';
import { FloatPanel, TabContent, sweepOrphanPanels, writePanelPage } from './panel';
import type { RenderRequest } from './panel-editor';
import { DEFAULT_SETTINGS, FloatNoteSettings, FloatNoteSettingTab } from './settings';
import { answerRenderRequests } from './snippets';
import { buildViewDocument } from './view';

/** How long after the last move or resize the panel's bounds are saved. */
const BOUNDS_SAVE_MS = 1000;

export default class FloatNotePlugin extends Plugin {
	settings!: FloatNoteSettings;
	panel: FloatPanel | null = null;
	/** The notes open in the panel's tabs. */
	private readonly notes = new Notes(this.app);
	private pagePath = '';
	private busy = false;
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
		// Live Preview dims links to notes that do not exist; which those are changes as notes are saved and indexed.
		this.registerEvent(
			this.app.metadataCache.on('resolve', (file) => {
				const b = this.notes.byFile(file);
				if (this.panel && b) void this.panel.setUnresolved(b.id, unresolvedLinks(this.app, file));
			}),
		);
		this.registerEvent(
			this.app.vault.on('rename', (file) => {
				const b = this.notes.byFile(file);
				if (this.panel && b && file instanceof TFile) void this.panel.setName(b.id, file.basename);
			}),
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				const b = this.notes.byFile(file);
				if (!b) return;
				this.notes.discard(b.id);
				if (this.notes.size > 0) {
					new Notice('Float Note: a floating note was deleted, so its tab was closed.');
					void this.panel?.removeTab(b.id);
					return;
				}
				new Notice('Float Note: the floating note was deleted, so the panel was closed.');
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
			// Already floating: show its tab rather than open a second.
			const open = this.notes.byFile(file);
			if (this.panel?.isAlive() && open) {
				await this.panel.activate(open.id);
				this.log('tab-activated', { path: file.path });
				return;
			}
			if (this.panel?.isAlive()) {
				const text = await this.app.vault.read(file);
				const b = this.notes.add(file, text);
				await this.panel.openTab(this.content(b, text));
				this.log('tab-opened', { path: file.path });
				return;
			}
			this.closePanelNow();
			sweepOrphanPanels();
			if (!this.pagePath) this.pagePath = await writePanelPage(this.app.vault.adapter, `${this.manifest.dir}/panel.html`);
			const text = await this.app.vault.read(file);
			const b = this.notes.add(file, text);
			this.panel = await FloatPanel.open(
				this.pagePath,
				this.content(b, text),
				() => this.settings,
				(event, extra) => this.log(event, extra),
				{
					onText: (id, changed) => this.notes.edited(id, changed),
					onTabClosed: (id, changed) => {
						if (changed !== null) this.notes.edited(id, changed);
						this.log('tab-closed', { path: this.notes.get(id)?.file.path });
						void this.notes.remove(id);
						// The page closes its last tab through onCloseRequested; this catches
						// one emptied by a note deleted while this close was on its way.
						if (this.notes.size === 0) void this.closePanel();
					},
					onCloseRequested: (source) => {
						this.log('close-requested', { source });
						void this.closePanel();
					},
					onViewRequested: () => void this.renderView(),
					onRenderRequests: (requests) => this.renderSnippets(requests),
					onOpenLink: (request) => {
						const b = this.notes.get(request.tab);
						this.log('link-opened', { external: request.external });
						if (b) openLink(this.app, b.file, request);
					},
					onBounds: (bounds) => this.rememberBounds(bounds),
					onTick: () => this.notes.writeIdle(),
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

	/** What the panel needs to show a note in a tab. */
	private content(b: Binding, text: string): TabContent {
		return {
			id: b.id,
			name: b.file.basename,
			text,
			editingMode: readEditingMode(this.app),
			unresolved: unresolvedLinks(this.app, b.file),
			renderedLanguages: renderedLanguages(),
		};
	}

	/** Render what Live Preview asked for, each against the note of the tab that asked. */
	private renderSnippets(requests: RenderRequest[]): void {
		const panel = this.panel;
		if (!panel) return;
		const byTab = new Map<string, RenderRequest[]>();
		for (const r of requests) byTab.set(r.tab, [...(byTab.get(r.tab) ?? []), r]);
		for (const [id, list] of byTab) {
			const b = this.notes.get(id);
			if (b) void answerRenderRequests(this.app, b.file, panel, list, (event, extra) => this.log(event, extra));
		}
	}

	/** Hide or show the open panel; with none open, float the current note. */
	async toggleOverlay(): Promise<void> {
		const panel = this.panel;
		if (!panel?.isAlive()) return this.floatCurrentNote();
		if (panel.isVisible()) {
			// Saved now rather than left to the idle timer, so nothing waits on a window nobody can see.
			await panel.drain();
			await this.notes.save();
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

	/** Save every tab, then close the panel. The path every close from the panel or palette takes. */
	async closePanel(): Promise<void> {
		const panel = this.panel;
		if (!panel) return;
		this.panel = null;
		await panel.drain();
		await this.notes.save();
		panel.close();
		this.notes.clear();
	}

	/**
	 * Close without waiting, for unload paths that cannot await. Pending
	 * writes are started but may not finish - up to about a second of typing.
	 */
	closePanelNow(): void {
		this.notes.flushNow();
		this.panel?.close();
		this.panel = null;
		this.notes.clear();
	}

	/**
	 * Render the active tab's text - pending edits included, so View shows what
	 * was just typed - with Obsidian's renderer, and show it in the panel.
	 */
	private async renderView(): Promise<void> {
		const panel = this.panel;
		const b = panel?.activeId ? this.notes.get(panel.activeId) : undefined;
		if (!b || !panel) return;
		const started = Date.now();
		try {
			const view = await buildViewDocument(this.app, b.file, b.pending ?? b.lastWritten, this.settings.debugLog ? `${this.manifest.dir}/last-view.html` : null);
			if (!this.notes.has(b) || this.panel !== panel) return;
			await panel.showView(b.id, view.srcdoc);
			this.log('view-rendered', { ms: Date.now() - started, htmlBytes: view.htmlBytes, cssBytes: view.cssBytes, imagesRewritten: view.imagesRewritten });
		} catch (e) {
			console.error('Float Note: could not render the view', e);
			this.log('view-failed', { error: String(e) });
		}
	}

	/** A change from outside the panel - the main pane, the Linter, sync. */
	private onVaultModify(file: TAbstractFile): void {
		const panel = this.panel;
		const b = this.notes.byFile(file);
		if (!panel || !b) return;
		// Panel edits not yet saved win; the next save overwrites the change.
		if (b.pending !== null) return;
		void (async () => {
			const text = await this.app.vault.read(b.file);
			if (text === b.lastWritten || !this.notes.has(b) || this.panel !== panel) return;
			const applied = await panel.replace(b.id, text);
			if (applied) b.lastWritten = text;
			this.log('external-change', { applied });
			// A tab in the background is rendered when it next shows.
			if (applied && panel.activeId === b.id && panel.mode === 'view') await this.renderView();
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
				tabs: this.notes.size,
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
