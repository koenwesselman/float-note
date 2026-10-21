import { App, MarkdownPreviewRenderer, TFile } from 'obsidian';
import { focusMainWindow } from './native';
import type { LinkTarget } from './panel-editor';

/** Open a link Cmd+clicked in the panel: a note in a new tab of the main window, as Cmd+click does in Obsidian, or a URL in its app. */
export function openLink(app: App, file: TFile, link: LinkTarget): void {
	if (link.external) {
		window.open(link.target);
		return;
	}
	focusMainWindow();
	void app.workspace.openLinkText(link.target, file.path, 'tab');
}

/** Link paths in the note that resolve to nothing, from the metadata cache. */
export function unresolvedLinks(app: App, file: TFile): string[] {
	return Object.keys(app.metadataCache.unresolvedLinks[file.path] ?? {});
}

/** Code block languages Obsidian draws itself, whatever plugins are installed. */
const CORE_LANGUAGES = ['mermaid', 'query'];

/**
 * Code block languages Obsidian draws rather than shows as code: its own,
 * and those plugins registered with registerMarkdownCodeBlockProcessor. The
 * registry is not public API; without it the panel falls back to a list of
 * common ones.
 */
export function renderedLanguages(): string[] {
	const registry = (MarkdownPreviewRenderer as unknown as { codeBlockPostProcessors?: Record<string, unknown> }).codeBlockPostProcessors;
	if (!registry || typeof registry !== 'object') return [];
	return [...new Set([...CORE_LANGUAGES, ...Object.keys(registry)])];
}
