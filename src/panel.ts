import { DataAdapter, FileSystemAdapter } from 'obsidian';
import editorScript from 'virtual:panel-editor';
import { Bounds, NativeWindow, createWindow, isAlive, onSomeDisplay, safe, windowsTitled } from './native';
import type { CloseSource, EditingMode, Mode, OpenArgs, OpenRequest, PollResult, Rendered, RenderRequest, Stylesheet, Theme } from './panel-editor';
import type { FloatNoteSettings } from './settings';
import { readTheme } from './theme';

export type Log = (event: string, extra?: Record<string, unknown>) => void;

/**
 * The page title doubles as the marker for finding panels this plugin no
 * longer owns: the window lives in Electron's main process and survives a
 * renderer reload or crash that takes the plugin with it.
 */
export const PANEL_TITLE = 'Float Note panel';

const DEFAULT_SIZE = { width: 420, height: 480 };
const REAPPLY_DELAYS_MS = [150, 600];
const POLL_MS = 300;

/** A note for a tab. */
export interface TabContent {
	id: string;
	name: string;
	text: string;
	editingMode: EditingMode;
	unresolved: string[];
	renderedLanguages: string[];
}

export interface PanelEvents {
	/** A tab's text changed since the last poll. */
	onText(id: string, text: string): void;
	/** The user closed a tab, other than the last. The text is edits not yet reported. */
	onTabClosed(id: string, text: string | null): void;
	/** The user pressed Esc, or closed the last tab. */
	onCloseRequested(source: CloseSource): void;
	/** The active tab wants a rendering; the plugin should render it and call showView. */
	onViewRequested(): void;
	/** Live Preview wants blocks rendered; the plugin should answer with setRendered. */
	onRenderRequests(requests: RenderRequest[]): void;
	/** The user Cmd+clicked a link in a tab. */
	onOpenLink(request: OpenRequest): void;
	/** The panel was moved or resized. */
	onBounds(bounds: Bounds): void;
	/** After every poll, changed or not. */
	onTick(): void;
}

/**
 * Write the panel page to `path` in the vault - the plugin folder - and return
 * its absolute path for the window to load. Once per plugin load, on the
 * first float: the page is static - CodeMirror and a boot script - and the
 * note and theme arrive afterwards through `floatNote.load`. A file rather
 * than a data: URL because the bundled editor is too large for one; in the
 * plugin folder rather than the temp directory so the plugin writes nothing
 * outside the vault, and the file goes when the plugin is uninstalled.
 */
export async function writePanelPage(adapter: DataAdapter, path: string): Promise<string> {
	if (!(adapter instanceof FileSystemAdapter)) throw new Error('The panel page needs a vault on the local file system');
	await adapter.write(path, renderPage());
	return adapter.getFullPath(path);
}

/**
 * A plugin-created NSPanel (`type: 'panel'`) editing notes in tabs. Obsidian's
 * popouts cannot be panels - their window options are fixed - and only a
 * panel floats over another app's full-screen Space.
 *
 * The page is sandboxed with no Node and no preload, and nothing is registered
 * on the remote window: the plugin pushes with executeJavaScript and pulls by
 * polling, so there is no callback for a reload to leave dangling.
 */
export class FloatPanel {
	private timers: number[] = [];
	private pollTimer: number | null = null;
	private inflight: Promise<void> | null = null;
	/** The tab the page showed at the last poll, and its mode. */
	activeId: string | null = null;
	mode: Mode = 'live';
	private lastBounds: Bounds | null = null;
	/** Which main-window CSS the page last got for Live Preview's renderings. */
	stylesheetFingerprint: string | null = null;

	private constructor(
		private readonly native: NativeWindow,
		private readonly log: Log,
		private readonly events: PanelEvents,
	) {}

	static async open(
		pagePath: string,
		content: TabContent,
		settings: () => FloatNoteSettings,
		log: Log,
		events: PanelEvents,
	): Promise<FloatPanel> {
		const theme = readTheme();
		const remembered = settings().bounds;
		const placement = remembered
			? onSomeDisplay(remembered)
				? remembered
				: { width: remembered.width, height: remembered.height }
			: DEFAULT_SIZE;
		const native = createWindow({
			type: 'panel',
			...placement,
			minWidth: 220,
			minHeight: 120,
			show: false,
			frame: false,
			resizable: true,
			minimizable: false,
			maximizable: false,
			fullscreenable: false,
			// The plugin owns the lifecycle: closing only through the plugin lets
			// it save before the window goes.
			closable: false,
			skipTaskbar: true,
			hasShadow: true,
			backgroundColor: theme.background,
			title: PANEL_TITLE,
			webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
		});
		const panel = new FloatPanel(native, log, events);
		// Flags first, while hidden, so the window is ordered in with them.
		panel.applyFlags();
		panel.setOpacity(settings().opacity);
		panel.lastBounds = safe(() => native.getBounds(), null);
		await native.loadFile(pagePath);
		await panel.addTab(content, theme);
		panel.present();
		panel.pollTimer = window.setInterval(() => panel.tick(), POLL_MS);
		return panel;
	}

	isAlive(): boolean {
		return isAlive(this.native);
	}

	/** Another note, in a new tab, shown. */
	async openTab(content: TabContent): Promise<void> {
		await this.addTab(content, readTheme());
		this.present();
	}

	/** Show a tab already open. */
	async activate(id: string): Promise<void> {
		await this.exec(`window.floatNote.activate(${JSON.stringify(id)})`);
		this.activeId = id;
		this.present();
	}

	/** Take out a tab whose note is gone, without saving it. */
	async removeTab(id: string): Promise<void> {
		await this.exec(`window.floatNote.remove(${JSON.stringify(id)})`);
	}

	/** Offer a change made outside the panel. False when the tab has unpolled edits. */
	async replace(id: string, text: string): Promise<boolean> {
		return (await this.exec<boolean>(`window.floatNote.replace(${JSON.stringify(id)}, ${JSON.stringify(text)})`)) === true;
	}

	async toggleMode(): Promise<void> {
		await this.exec('window.floatNote.toggleMode()');
	}

	async toggleSource(): Promise<void> {
		await this.exec('window.floatNote.toggleSource()');
	}

	async setRendered(results: Rendered[]): Promise<void> {
		await this.exec(`window.floatNote.setRendered(${JSON.stringify(results)})`);
	}

	async setStylesheet(sheet: Stylesheet): Promise<void> {
		await this.exec(`window.floatNote.setStylesheet(${JSON.stringify(sheet)})`);
	}

	async setUnresolved(id: string, list: string[]): Promise<void> {
		await this.exec(`window.floatNote.setUnresolved(${JSON.stringify(id)}, ${JSON.stringify(list)})`);
	}

	async showView(id: string, srcdoc: string): Promise<void> {
		await this.exec(`window.floatNote.showView(${JSON.stringify(id)}, ${JSON.stringify(srcdoc)})`);
	}

	async setName(id: string, name: string): Promise<void> {
		await this.exec(`window.floatNote.setName(${JSON.stringify(id)}, ${JSON.stringify(name)})`);
	}

	/**
	 * Stop polling and report any edits and closed tabs not yet reported.
	 * Waits for a poll already in flight first, so nothing it took is lost
	 * between the two.
	 */
	async drain(): Promise<void> {
		this.stopPolling();
		if (this.inflight) await this.inflight;
		const result = await this.exec<PollResult>('window.floatNote.poll()');
		if (result) this.reportText(result);
	}

	setOpacity(opacity: number): void {
		if (this.isAlive()) safe(() => this.native.setOpacity(Math.min(1, Math.max(0.5, opacity))), undefined);
	}

	isVisible(): boolean {
		return this.isAlive() && safe(() => this.native.isVisible(), false);
	}

	/** Hide without closing: the note stays loaded, and polling and saving carry on. */
	hide(): void {
		if (this.isAlive()) safe(() => this.native.hide(), undefined);
		this.log('panel-hidden');
	}

	/** Show again after hide(), with its flags re-asserted. */
	unhide(): void {
		this.present();
		this.log('panel-shown');
	}

	/** Destroy the window. Idempotent; does not save. */
	close(): void {
		this.stopPolling();
		for (const id of this.timers) window.clearTimeout(id);
		this.timers = [];
		if (this.isAlive()) safe(() => this.native.destroy(), undefined);
		this.log('panel-closed');
	}

	/** State for the debug log. Never throws. */
	snapshot(): Record<string, unknown> {
		if (!this.isAlive()) return { alive: false };
		return {
			alive: true,
			visible: safe(() => this.native.isVisible(), null),
			allWorkspaces: safe(() => this.native.isVisibleOnAllWorkspaces(), null),
			alwaysOnTop: safe(() => this.native.isAlwaysOnTop(), null),
		};
	}

	/**
	 * On every Space, including other apps' full-screen ones, above ordinary
	 * windows. Because this is an NSPanel, that needs no change to Obsidian's
	 * place in the Dock: skipTransformProcessType keeps Electron from hiding it.
	 * 'floating' is the level Tot uses - below menus and notifications.
	 */
	private applyFlags(): void {
		if (!this.isAlive()) return;
		try {
			this.native.setFullScreenable(false);
			this.native.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
			this.native.setAlwaysOnTop(true, 'floating');
		} catch (e) {
			console.error('Float Note: could not apply window flags', e);
		}
	}

	private tick(): void {
		if (this.inflight) return;
		this.inflight = (async () => {
			const result = await this.exec<PollResult>('window.floatNote.poll()');
			if (result) {
				this.reportText(result);
				this.activeId = result.active;
				this.mode = result.mode;
			}
			if (result?.viewDiagnostics) this.log('view-diagnostics', result.viewDiagnostics);
			if (result?.viewRequested) this.events.onViewRequested();
			if (result?.renderRequests.length) this.events.onRenderRequests(result.renderRequests);
			if (result?.openLink) this.events.onOpenLink(result.openLink);
			if (result?.close) this.events.onCloseRequested(result.close);
			this.checkBounds();
			this.events.onTick();
		})().finally(() => {
			this.inflight = null;
		});
	}

	private reportText(result: PollResult): void {
		for (const { id, text } of result.texts) this.events.onText(id, text);
		for (const { id, text } of result.closed) this.events.onTabClosed(id, text);
	}

	/** Moving or resizing fires nothing the plugin can hear without a remote listener, so it is polled too. */
	private checkBounds(): void {
		const bounds = safe(() => (this.isAlive() ? this.native.getBounds() : null), null);
		if (!bounds) return;
		const last = this.lastBounds;
		if (last && last.x === bounds.x && last.y === bounds.y && last.width === bounds.width && last.height === bounds.height) return;
		this.lastBounds = bounds;
		this.events.onBounds(bounds);
	}

	/** Restart polling after drain(), for a panel that stays open. */
	resumePolling(): void {
		if (this.pollTimer === null) this.pollTimer = window.setInterval(() => this.tick(), POLL_MS);
	}

	private stopPolling(): void {
		if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
		this.pollTimer = null;
	}

	private present(): void {
		if (!this.isAlive()) return;
		safe(() => this.native.show(), undefined);
		this.applyFlags();
		for (const ms of REAPPLY_DELAYS_MS) this.timers.push(window.setTimeout(() => this.applyFlags(), ms));
	}

	private async addTab(content: TabContent, theme: Theme): Promise<void> {
		const args: OpenArgs = { ...content, theme };
		await this.exec(`window.floatNote.open(${JSON.stringify(args)})`);
		this.activeId = content.id;
		this.mode = content.editingMode;
	}

	/** Run code in the page. Null if the window is gone or the call fails. */
	private async exec<T>(code: string): Promise<T | null> {
		if (!this.isAlive()) return null;
		try {
			return (await this.native.webContents.executeJavaScript(code)) as T;
		} catch (e) {
			console.error('Float Note: panel script failed', e);
			return null;
		}
	}
}

/** Destroy panels left behind by an earlier load of the plugin. */
export function sweepOrphanPanels(): number {
	const orphans = windowsTitled(PANEL_TITLE);
	for (const w of orphans) safe(() => w.destroy(), undefined);
	return orphans.length;
}

function renderPage(): string {
	// The bundle is inlined into a <script>; a literal </script inside it would end the element early.
	const script = editorScript.replace(/<\/script/gi, '<\\/script');
	return `<!doctype html>
<html><head><meta charset="utf-8"><title>${PANEL_TITLE}</title>
<style>
:root { --fn-background: #1e1e1e; --fn-text: #dcddde; --fn-muted: #999; --fn-border: #333; --fn-font: system-ui, sans-serif; --fn-size: 16px; }
html, body { margin: 0; height: 100%; overflow: hidden; background: var(--fn-background); color: var(--fn-text); }
body { display: flex; flex-direction: column; font-family: var(--fn-font); }
.bar { -webkit-app-region: drag; flex: none; height: 26px; display: flex; align-items: center; gap: 4px; padding: 0 3px; font-size: 11px; color: var(--fn-muted); border-bottom: 1px solid var(--fn-border); user-select: none; }
#fn-tabs { flex: 0 1 auto; min-width: 0; display: flex; gap: 2px; overflow-x: auto; scrollbar-width: none; }
/* Always some strip left to drag the window by, however many tabs. */
.fn-drag { flex: 1 0 16px; align-self: stretch; }
.fn-tab { -webkit-app-region: no-drag; flex: 0 1 140px; min-width: 64px; height: 20px; box-sizing: border-box; display: flex; align-items: center; gap: 2px; padding: 0 2px 0 8px; border-radius: 4px; cursor: default; }
.fn-tab:hover { color: var(--fn-text); }
.fn-tab.is-active, .fn-tab.is-dragging { background: var(--fn-border); color: var(--fn-text); }
.fn-tab.is-dragging { position: relative; z-index: 1; opacity: 0.85; transform: translateX(var(--fn-shift, 0)); }
.fn-tab-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fn-tab-close { flex: none; border: 0; background: transparent; color: var(--fn-muted); font-size: 14px; line-height: 1; width: 16px; height: 16px; padding: 0; border-radius: 3px; cursor: pointer; }
.fn-tab-close:hover { background: rgba(127, 127, 127, 0.3); color: var(--fn-text); }
#fn-mode { -webkit-app-region: no-drag; border: 0; background: transparent; color: var(--fn-muted); font: inherit; font-size: 11px; padding: 2px 6px; border-radius: 4px; cursor: pointer; }
#fn-mode:hover { background: var(--fn-border); color: var(--fn-text); }
#fn-editor { flex: 1; min-height: 0; }
#fn-view { flex: 1; min-height: 0; border: 0; width: 100%; background: var(--fn-background); }
</style></head>
<body><div class="bar"><div id="fn-tabs"></div><div class="fn-drag"></div><button id="fn-mode" title="Show as Obsidian renders it (Cmd+E)">View</button></div>
<template id="fn-tab-template"><div class="fn-tab"><span class="fn-tab-name"></span><button class="fn-tab-close" title="Close tab (Cmd+W)">×</button></div></template><div id="fn-editor"></div><iframe id="fn-view" style="display: none" title="Rendered note"></iframe>
<script>${script}</script></body></html>`;
}
