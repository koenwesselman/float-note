import { App, PluginSettingTab, SettingDefinitionItem } from 'obsidian';
import type FloatNotePlugin from './main';
import type { Bounds } from './native';

export interface FloatNoteSettings {
	opacity: number;
	debugLog: boolean;
	/** Where the panel was last left. Not shown in the settings tab. */
	bounds: Bounds | null;
}

export const DEFAULT_SETTINGS: FloatNoteSettings = {
	opacity: 1,
	debugLog: false,
	bounds: null,
};

export class FloatNoteSettingTab extends PluginSettingTab {
	plugin: FloatNotePlugin;

	constructor(app: App, plugin: FloatNotePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: 'Opacity',
				desc: 'How opaque the overlay is. Applies to an open overlay immediately.',
				control: { type: 'slider', key: 'opacity', min: 0.5, max: 1, step: 0.05 },
			},
			{
				name: 'Debug log',
				desc: 'Append panel and view events to debug.log in the plugin folder, for diagnosing problems.',
				control: { type: 'toggle', key: 'debugLog' },
			},
		];
	}

	/** Written here rather than by the base class, so opacity reaches an open panel at once. */
	async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = this.plugin.settings;
		if (key === 'opacity' && typeof value === 'number') {
			settings.opacity = value;
			this.plugin.panel?.setOpacity(value);
		} else if (key === 'debugLog' && typeof value === 'boolean') {
			settings.debugLog = value;
		} else {
			return;
		}
		await this.plugin.saveSettings();
	}
}
