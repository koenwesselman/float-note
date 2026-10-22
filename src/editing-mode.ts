import type { App } from 'obsidian';
import type { EditingMode } from './panel-editor';

/**
 * Obsidian's **Default editing mode**, which the panel follows. Read from the
 * vault's `livePreview` config through `vault.getConfig`, which is not public
 * API; when it is missing, Live Preview, Obsidian's own default.
 */
export function readEditingMode(app: App): EditingMode {
	const vault = app.vault as unknown as { getConfig?: (key: string) => unknown };
	try {
		return vault.getConfig?.('livePreview') === false ? 'source' : 'live';
	} catch {
		return 'live';
	}
}
