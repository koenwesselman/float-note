import { App, PluginSettingTab, Setting } from 'obsidian';
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

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Opacity')
			.setDesc('How opaque the overlay is. Applies to an open overlay immediately.')
			.addSlider((slider) =>
				slider
					.setLimits(0.5, 1, 0.05)
					.setValue(this.plugin.settings.opacity)
					.onChange(async (value) => {
						this.plugin.settings.opacity = value;
						await this.plugin.saveSettings();
						this.plugin.panel?.setOpacity(value);
					}),
			);

		new Setting(containerEl)
			.setName('Debug log')
			.setDesc('Append panel and view events to debug.log in the plugin folder, for diagnosing problems.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.debugLog).onChange(async (value) => {
					this.plugin.settings.debugLog = value;
					await this.plugin.saveSettings();
				}),
			);
	}
}
