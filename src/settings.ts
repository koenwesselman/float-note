import { App, PluginSettingTab, Setting } from 'obsidian';
import type FloatNotePlugin from './main';
import type { Bounds } from './native';

export type AlwaysOnTopLevel = 'floating' | 'pop-up-menu' | 'screen-saver';

/**
 * How Obsidian stops being a regular Dock app while the overlay is open, which
 * macOS requires before an ordinary window may join another app's full-screen
 * Space. 'transform' is Electron's skipTransformProcessType: false;
 * 'accessory' is app.setActivationPolicy; 'none' is skipTransformProcessType: true.
 */
export type FullScreenMethod = 'accessory' | 'transform' | 'none';

export interface FloatNoteSettings {
	level: AlwaysOnTopLevel;
	fullScreenMethod: FullScreenMethod;
	opacity: number;
	debugLog: boolean;
	/** Where the panel was last left. Not shown in the settings tab. */
	bounds: Bounds | null;
}

// 'floating' is the level Tot uses and the least intrusive one: above ordinary
// windows, below menus and notifications. 'none' because a panel floats over
// full-screen apps without Obsidian leaving the Dock (Phase 3a).
export const DEFAULT_SETTINGS: FloatNoteSettings = {
	level: 'floating',
	fullScreenMethod: 'none',
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
			.setName('Always-on-top level')
			.setDesc('How high the overlay sits in the macOS window stack. Applies to an open overlay immediately.')
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						floating: 'Floating',
						'pop-up-menu': 'Pop-up menu',
						'screen-saver': 'Screen saver',
					})
					.setValue(this.plugin.settings.level)
					.onChange(async (value) => {
						this.plugin.settings.level = value as AlwaysOnTopLevel;
						await this.plugin.saveSettings();
						this.plugin.panel?.reapply();
					}),
			);

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
			.setName('Full-screen method')
			.setDesc(
				'Whether Obsidian leaves the Dock and Cmd+Tab while the overlay is open, which macOS may require before a window can float over another app in full screen. ' +
					'None: Obsidian stays in the Dock. Activation policy: the AppKit route. Process transform: Electron\'s own route. ' +
					'Applies to an open overlay immediately.',
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						none: 'None',
						accessory: 'Activation policy',
						transform: 'Process transform',
					})
					.setValue(this.plugin.settings.fullScreenMethod)
					.onChange(async (value) => {
						this.plugin.settings.fullScreenMethod = value as FullScreenMethod;
						await this.plugin.saveSettings();
						this.plugin.panel?.syncMethod();
					}),
			);

		new Setting(containerEl)
			.setName('Debug log')
			.setDesc('Append window and Dock state to debug.log in the plugin folder on every float, close and method change.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.debugLog).onChange(async (value) => {
					this.plugin.settings.debugLog = value;
					await this.plugin.saveSettings();
				}),
			);
	}
}
