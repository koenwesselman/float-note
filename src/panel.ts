import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import editorScript from 'virtual:panel-editor';
import { Bounds, NativeWindow, createWindow, isAlive, onSomeDisplay, safe, windowsTitled } from './native';
import type { CloseSource, LoadArgs, PollResult, Theme } from './panel-editor';
import type { FloatNoteSettings } from './settings';

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
}

export interface PanelEvents {
	/** The panel's text changed since the last poll. */
	onText(text: string): void;
	/** The user pressed the ×, Esc or Cmd+W in the panel. */
	onCloseRequested(source: CloseSource): void;
	/** The user switched to View; the plugin should render and call showView. */
	onViewRequested(): void;
	/** The panel was moved or resized. */
	onBounds(bounds: Bounds): void;
	/** After every poll, changed or not. */
	onTick(): void;
}

/**
 * Write the panel page to the temp directory and return its path. Once per
 * plugin load: the page is static - CodeMirror and a boot script - and the
 * note and theme arrive afterwards through `floatNote.load`. A file rather
 * than a data: URL because the bundled editor is too large for one.
 */
export function writePanelPage(version: string): string {
	const dir = join(tmpdir(), 'obsidian-float-note');
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `panel-${version}.html`);
	writeFileSync(path, renderPage(), 'utf8');
	return path;
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
	mode: 'edit' | 'view' = 'edit';
	private lastBounds: Bounds | null = null;

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
		this.mode = 'edit';
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

	async showView(srcdoc: string): Promise<void> {
		await this.exec(`window.floatNote.showView(${JSON.stringify(srcdoc)})`);
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

/**
 * Obsidian's current theme, read from the main window at the moment of opening.
 *
 * Token colours are measured rather than read from variables: themes style
 * CodeMirror's own classes directly (Things sets `span.cm-strong` to its own
 * `--strong-color` and never touches Obsidian's `--bold-color`), so the only
 * theme-agnostic answer is what the theme actually renders. A hidden copy of
 * Obsidian's source-editor markup is put in the main window, measured, and
 * removed.
 */
function readTheme(): Theme {
	const style = getComputedStyle(document.body);
	const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
	const probe = measureTokens();
	return {
		background: v('--background-primary', '#1e1e1e'),
		text: v('--text-normal', '#dcddde'),
		muted: v('--text-muted', '#999999'),
		accent: v('--text-accent', '#8a5cf5'),
		link: probe.link?.color ?? v('--link-color', v('--text-accent', '#8a5cf5')),
		bold: probe.strong?.color ?? 'inherit',
		italic: probe.em?.color ?? 'inherit',
		quote: probe.quote?.color ?? v('--text-muted', '#999999'),
		quoteStyle: probe.quote?.fontStyle ?? 'normal',
		headingColours: [1, 2, 3, 4, 5, 6].map((n) => probe[`h${n}`]?.color ?? 'inherit'),
		headingSizes: [1, 2, 3, 4, 5, 6].map((n, i) => probe[`h${n}`]?.fontSize ?? ['1.6em', '1.4em', '1.2em', '1.1em', '1em', '1em'][i] ?? '1em'),
		yamlKey: probe.frontmatterKey?.color ?? v('--text-muted', '#999999'),
		border: v('--background-modifier-border', '#333333'),
		selection: v('--text-selection', 'rgba(138, 92, 245, 0.25)'),
		codeBackground: v('--code-background', 'rgba(127, 127, 127, 0.15)'),
		font: v('--font-text', style.fontFamily || 'system-ui, sans-serif'),
		monospace: v('--font-monospace', 'ui-monospace, Menlo, monospace'),
		size: v('--font-text-size', '16px'),
	};
}

interface Measured {
	color: string;
	fontStyle: string;
	fontSize: string;
}

/** Line and token classes as Obsidian's CodeMirror 6 source view emits them. */
const PROBES: Record<string, { line?: string; token: string }> = {
	strong: { token: 'cm-strong' },
	em: { token: 'cm-em' },
	link: { token: 'cm-link' },
	quote: { line: 'HyperMD-quote HyperMD-quote-1', token: 'cm-quote cm-quote-1' },
	frontmatterKey: { line: 'cm-hmd-frontmatter', token: 'cm-hmd-frontmatter cm-atom' },
	...Object.fromEntries(
		[1, 2, 3, 4, 5, 6].map((n) => [`h${n}`, { line: `HyperMD-header HyperMD-header-${n}`, token: `cm-header cm-header-${n}` }]),
	),
};

function measureTokens(): Record<string, Measured | undefined> {
	const results: Record<string, Measured | undefined> = {};
	const host = document.body.createDiv({ cls: 'markdown-source-view mod-cm6 cm-s-obsidian' });
	host.setCssStyles({ position: 'absolute', left: '-10000px', top: '0', visibility: 'hidden', pointerEvents: 'none' });
	try {
		const content = host.createDiv({ cls: 'cm-editor' }).createDiv({ cls: 'cm-scroller' }).createDiv({ cls: 'cm-content' });
		const spans: Record<string, HTMLElement> = {};
		for (const [name, probe] of Object.entries(PROBES)) {
			spans[name] = content.createDiv({ cls: `cm-line ${probe.line ?? ''}`.trim() }).createSpan({ cls: probe.token, text: 'x' });
		}
		for (const [name, span] of Object.entries(spans)) {
			const computed = getComputedStyle(span);
			results[name] = { color: computed.color, fontStyle: computed.fontStyle, fontSize: computed.fontSize };
		}
	} catch (e) {
		console.error('Float Note: could not measure the theme', e);
	} finally {
		host.remove();
	}
	return results;
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
