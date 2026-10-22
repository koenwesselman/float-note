/**
 * The slice of Electron's BrowserWindow this plugin calls. The object is a
 * proxy from @electron/remote, so every call is a synchronous IPC round trip
 * to the main process - and any of them can throw once the window is closing.
 */
export interface NativeWindow {
	isDestroyed(): boolean;
	isVisible(): boolean;
	show(): void;
	showInactive(): void;
	hide(): void;
	getBounds(): Bounds;
	setOpacity(opacity: number): void;
	setBackgroundColor(colour: string): void;
	destroy(): void;
	getTitle(): string;
	loadURL(url: string): Promise<void>;
	loadFile(path: string): Promise<void>;
	readonly webContents: { executeJavaScript(code: string): Promise<unknown>; setZoomFactor(factor: number): void };
	setFullScreenable(fullscreenable: boolean): void;
	setVisibleOnAllWorkspaces(
		visible: boolean,
		options?: { visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean },
	): void;
	isVisibleOnAllWorkspaces(): boolean;
	setAlwaysOnTop(flag: boolean, level?: string): void;
	isAlwaysOnTop(): boolean;
}

export interface Bounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface RemoteBrowserWindow {
	new (options: Record<string, unknown>): NativeWindow;
	getAllWindows(): NativeWindow[];
}

interface Remote {
	BrowserWindow?: RemoteBrowserWindow;
	app?: { focus(options?: { steal: boolean }): void };
	getCurrentWindow?: () => NativeWindow & { focus(): void };
	screen?: { getAllDisplays(): { workArea: Bounds }[] };
}

/**
 * `require('electron').remote` exists only because Obsidian assigns
 * `@electron/remote` to it at start-up; Electron itself removed it in v14.
 */
function remote(): Remote | null {
	try {
		// Obsidian's renderer puts Node's require on window. Typed here rather
		// than through @types/node, which the community review does not load.
		const nodeRequire = (window as unknown as { require?: (id: string) => unknown }).require;
		return (nodeRequire?.('electron') as { remote?: Remote } | undefined)?.remote ?? null;
	} catch {
		return null;
	}
}

/**
 * The main window's zoom - Obsidian's Cmd+plus and Cmd+minus - as a factor.
 * Read from this renderer's own webFrame, so it costs no call to the main
 * process. 1 when it cannot be read.
 */
export function mainZoomFactor(): number {
	try {
		const nodeRequire = (window as unknown as { require?: (id: string) => unknown }).require;
		const electron = nodeRequire?.('electron') as { webFrame?: { getZoomFactor(): number } } | undefined;
		const factor = electron?.webFrame?.getZoomFactor();
		return typeof factor === 'number' && factor > 0 ? factor : 1;
	} catch {
		return 1;
	}
}

/** A new window in Electron's main process. Throws if remote is unavailable. */
export function createWindow(options: Record<string, unknown>): NativeWindow {
	const BrowserWindow = remote()?.BrowserWindow;
	if (!BrowserWindow) throw new Error('@electron/remote BrowserWindow is not available');
	return new BrowserWindow(options);
}

/**
 * Whether at least a grabbable corner of these bounds - 60 x 40 px - is on a
 * connected display. A window remembered on a display since unplugged would
 * otherwise reopen somewhere nobody can reach it.
 */
export function onSomeDisplay(bounds: Bounds): boolean {
	const displays = safe(() => remote()?.screen?.getAllDisplays() ?? [], []);
	return displays.some(({ workArea: a }) => {
		const overlapX = Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x);
		const overlapY = Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y);
		return overlapX >= 60 && overlapY >= 40;
	});
}

/**
 * Bring Obsidian's main window to the front, over the app the panel floats
 * above - for a link opened from the panel, which lands in the main window.
 */
export function focusMainWindow(): void {
	const r = remote();
	safe(() => r?.app?.focus({ steal: true }), undefined);
	safe(() => r?.getCurrentWindow?.().focus(), undefined);
}

/** Every live main-process window with this title. */
export function windowsTitled(title: string): NativeWindow[] {
	const all = remote()?.BrowserWindow?.getAllWindows() ?? [];
	return all.filter((w) => isAlive(w) && safe(() => w.getTitle(), '') === title);
}

/** isDestroyed() that never throws: a window that cannot answer is treated as gone. */
export function isAlive(w: NativeWindow): boolean {
	return safe(() => !w.isDestroyed(), false);
}

export function safe<T>(fn: () => T, fallback: T): T {
	try {
		return fn();
	} catch {
		return fallback;
	}
}
