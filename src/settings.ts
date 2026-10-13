import { App, PluginSettingTab, Setting, SettingDefinitionItem } from 'obsidian';
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

const OPACITY = { name: 'Opacity', desc: 'How opaque the overlay is. Applies to an open overlay immediately.', min: 0.5, max: 1, step: 0.05 };
const DEBUG_LOG = { name: 'Debug log', desc: 'Append panel and view events to debug.log in the plugin folder, for diagnosing problems.' };

/**
 * Declarative on Obsidian 1.13 and later, which puts the settings in
 * settings search; display() is the fallback for 1.9 to 1.12, which
 * minAppVersion still admits.
 */
export class FloatNoteSettingTab extends PluginSettingTab {
	plugin: FloatNotePlugin;

	constructor(app: App, plugin: FloatNotePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{ name: OPACITY.name, desc: OPACITY.desc, control: { type: 'slider', key: 'opacity', min: OPACITY.min, max: OPACITY.max, step: OPACITY.step } },
			{ name: DEBUG_LOG.name, desc: DEBUG_LOG.desc, control: { type: 'toggle', key: 'debugLog' } },
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

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName(OPACITY.name)
			.setDesc(OPACITY.desc)
			.addSlider((slider) =>
				slider
					.setLimits(OPACITY.min, OPACITY.max, OPACITY.step)
					.setValue(this.plugin.settings.opacity)
					.onChange(async (value) => {
						this.plugin.settings.opacity = value;
						await this.plugin.saveSettings();
						this.plugin.panel?.setOpacity(value);
					}),
			);

		new Setting(containerEl)
			.setName(DEBUG_LOG.name)
			.setDesc(DEBUG_LOG.desc)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.debugLog).onChange(async (value) => {
					this.plugin.settings.debugLog = value;
					await this.plugin.saveSettings();
				}),
			);
	}
}
