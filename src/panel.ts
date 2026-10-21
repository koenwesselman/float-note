import { DataAdapter, FileSystemAdapter } from 'obsidian';
import editorScript from 'virtual:panel-editor';
import { Bounds, NativeWindow, createWindow, isAlive, onSomeDisplay, safe, windowsTitled } from './native';
import type { CloseSource, EditingMode, LinkTarget, LoadArgs, Mode, PollResult, Rendered, RenderRequest, Stylesheet, Theme } from './panel-editor';
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

export interface PanelContent {
	name: string;
	text: string;
	editingMode: EditingMode;
	unresolved: string[];
	renderedLanguages: string[];
}

export interface PanelEvents {
	/** The panel's text changed since the last poll. */
	onText(text: string): void;
	/** The user pressed the ×, Esc or Cmd+W in the panel. */
	onCloseRequested(source: CloseSource): void;
	/** The user switched to View; the plugin should render and call showView. */
	onViewRequested(): void;
	/** Live Preview wants blocks rendered; the plugin should answer with setRendered. */
	onRenderRequests(requests: RenderRequest[]): void;
	/** The user Cmd+clicked a link. */
	onOpenLink(link: LinkTarget): void;
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
 * A plugin-created NSPanel (`type: 'panel'`) editing one note. Obsidian's
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
	/** What the page showed at the last poll. */
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
		content: PanelContent,
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
		panel.mode = content.editingMode;
		// Flags first, while hidden, so the window is ordered in with them.
		panel.applyFlags();
		panel.setOpacity(settings().opacity);
		panel.lastBounds = safe(() => native.getBounds(), null);
		await native.loadFile(pagePath);
		await panel.load(content, theme);
		panel.present();
		panel.pollTimer = window.setInterval(() => panel.tick(), POLL_MS);
		return panel;
	}

	isAlive(): boolean {
		return isAlive(this.native);
	}

	/** Re-target to another note. */
	async show(content: PanelContent): Promise<void> {
		this.mode = content.editingMode;
		await this.load(content, readTheme());
		this.present();
	}

	/** Offer a change made outside the panel. False when the panel has unpolled edits. */
	async replace(text: string): Promise<boolean> {
		return (await this.exec<boolean>(`window.floatNote.replace(${JSON.stringify(text)})`)) === true;
	}

	async toggleMode(): Promise<void> {
		await this.exec('window.floatNote.toggleMode()');
	}

	async toggleSource(): Promise<void> {
		await this.exec('window.floatNote.toggleSource()');
	}

	async showView(srcdoc: string): Promise<void> {
		await this.exec(`window.floatNote.showView(${JSON.stringify(srcdoc)})`);
	}

	async setRendered(results: Rendered[]): Promise<void> {
		await this.exec(`window.floatNote.setRendered(${JSON.stringify(results)})`);
	}

	async setStylesheet(sheet: Stylesheet): Promise<void> {
		await this.exec(`window.floatNote.setStylesheet(${JSON.stringify(sheet)})`);
	}

	async setUnresolved(list: string[]): Promise<void> {
		await this.exec(`window.floatNote.setUnresolved(${JSON.stringify(list)})`);
	}

	async setName(name: string): Promise<void> {
		await this.exec(`window.floatNote.setName(${JSON.stringify(name)})`);
	}

	/**
	 * Stop polling and return any edits not yet reported. Waits for a poll
	 * already in flight first, so nothing it took is lost between the two.
	 */
	async drain(): Promise<string | null> {
		this.stopPolling();
		if (this.inflight) await this.inflight;
		const result = await this.exec<PollResult>('window.floatNote.poll()');
		return result?.text ?? null;
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
			if (result?.text != null) this.events.onText(result.text);
			if (result) this.mode = result.mode;
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

	private async load(content: PanelContent, theme: Theme): Promise<void> {
		const args: LoadArgs = { ...content, theme };
		await this.exec(`window.floatNote.load(${JSON.stringify(args)})`);
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
.bar { -webkit-app-region: drag; flex: none; height: 24px; display: flex; align-items: center; gap: 6px; padding: 0 3px 0 10px; font-size: 11px; color: var(--fn-muted); border-bottom: 1px solid var(--fn-border); user-select: none; }
#fn-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#fn-close { -webkit-app-region: no-drag; border: 0; background: transparent; color: var(--fn-muted); font-size: 15px; line-height: 1; width: 20px; height: 20px; border-radius: 4px; cursor: pointer; }
#fn-close:hover { background: var(--fn-border); color: var(--fn-text); }
#fn-mode { -webkit-app-region: no-drag; border: 0; background: transparent; color: var(--fn-muted); font: inherit; font-size: 11px; padding: 2px 6px; border-radius: 4px; cursor: pointer; }
#fn-mode:hover, #fn-close:hover { background: var(--fn-border); color: var(--fn-text); }
#fn-editor { flex: 1; min-height: 0; }
#fn-view { flex: 1; min-height: 0; border: 0; width: 100%; background: var(--fn-background); }
</style></head>
<body><div class="bar"><span id="fn-name"></span><button id="fn-mode" title="Show as Obsidian renders it (Cmd+E)">View</button><button id="fn-close" title="Close (Esc)">×</button></div><div id="fn-editor"></div><iframe id="fn-view" style="display: none" title="Rendered note"></iframe>
<script>${script}</script></body></html>`;
}
