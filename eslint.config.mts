import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		rules: {
			// "Float Note" is the plugin's name, so its capital N stays in the notices it prefixes.
			'obsidianmd/ui/sentence-case': ['warn', { ignoreRegex: ['^Float Note\\b'] }],
		},
	},
	{
		// The panel page runs in its own sandboxed window, where Obsidian's
		// createEl and friends do not exist.
		files: ['src/panel-editor/**/*.ts'],
		rules: { 'obsidianmd/prefer-create-el': 'off' },
	},
);
