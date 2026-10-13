import { NativeWindow, isAlive, restoreDock, safe, setActivationPolicy } from './native';
import type { FloatNoteSettings, FullScreenMethod } from './settings';

export type Log = (event: string, extra?: Record<string, unknown>) => void;

/**
 * The native flags that keep one window on top on every Space, including
 * other apps' full-screen ones.
 *
 * Getting there may need the whole Obsidian process out of the Dock, which is
 * process-wide and sticky. So the process change is made at most once,
 * recorded in `processChange`, and release() undoes it before anything else -
 * a remote call on a closing window can throw, and nothing that can throw may
 * stand between a release and the Dock coming back.
 */
export class WindowFlags {
	private processChange: Exclude<FullScreenMethod, 'none'> | null = null;

	constructor(
		private readonly native: NativeWindow,
		private readonly settings: () => FloatNoteSettings,
		private readonly log: Log,
	) {}

	/** Apply level and collection behaviour; with allowProcessChange, also the method's process change. */
	apply(allowProcessChange: boolean): void {
		if (!isAlive(this.native)) return;
		const s = this.settings();
		const change = allowProcessChange && !this.processChange && s.fullScreenMethod !== 'none' ? s.fullScreenMethod : null;
		try {
			this.native.setFullScreenable(false);
			if (change === 'accessory') setActivationPolicy('accessory');
			// 'transform' is Electron's own route: without skipTransformProcessType
			// it calls DockHide (TransformProcessType) before setting the flags.
			this.native.setVisibleOnAllWorkspaces(true, {
				visibleOnFullScreen: true,
				skipTransformProcessType: change !== 'transform',
			});
			this.native.setAlwaysOnTop(true, this.settings().level);
			if (change) this.processChange = change;

			// A window already on screen when the process stopped being a regular
			// app is ordered out and back in, so the window server places it again
			// under the new policy. A hidden window needs nothing.
			if (change === 'accessory' && this.native.isVisible()) {
				this.native.hide();
				this.native.show();
			}
		} catch (e) {
			console.error('Float Note: could not apply window flags', e);
		}
		if (allowProcessChange) this.log('apply', { change });
	}

	/** Make a change to the full-screen method take effect on the live window. */
	syncMethod(): void {
		if (!isAlive(this.native)) return;
		if (this.processChange === this.settings().fullScreenMethod) return;
		if (this.processChange) this.undoProcessChange();
		this.apply(true);
	}

	/** Undo the process change, then unpin the window if it is still there. Idempotent. */
	release(): void {
		this.undoProcessChange();
		if (isAlive(this.native)) {
			safe(() => this.native.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: false, skipTransformProcessType: true }), undefined);
			safe(() => this.native.setAlwaysOnTop(false), undefined);
		}
	}

	private undoProcessChange(): void {
		if (!this.processChange) return;
		const was = this.processChange;
		this.processChange = null;
		// Whichever route hid it, the Dock comes back through AppKit first.
		restoreDock();
		if (was === 'transform' && isAlive(this.native)) {
			// Electron's DockShow, the counterpart of the DockHide it ran.
			safe(() => this.native.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: false, skipTransformProcessType: false }), undefined);
		}
		this.log('undo-process-change', { was });
		// DockShow is asynchronous (about two seconds when Obsidian is active),
		// so the outcome is only knowable later.
		window.setTimeout(() => this.log('undo-process-change+2.5s', { was }), 2500);
	}

	/** State for the debug log. Never throws. */
	snapshot(): Record<string, unknown> {
		if (!isAlive(this.native)) return { alive: false, processChange: this.processChange };
		return {
			alive: true,
			processChange: this.processChange,
			visible: safe(() => this.native.isVisible(), null),
			allWorkspaces: safe(() => this.native.isVisibleOnAllWorkspaces(), null),
			alwaysOnTop: safe(() => this.native.isAlwaysOnTop(), null),
		};
	}
}
