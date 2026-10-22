import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';

/**
 * Code block languages Obsidian draws rather than shows as code: Mermaid,
 * search queries, and those of plugins. The plugin sends the languages it
 * finds registered; these are the fallback.
 */
let languages: ReadonlySet<string> = new Set(['mermaid', 'query', 'dataview', 'dataviewjs', 'tasks', 'chart']);

export function setRenderedLanguages(list: readonly string[]): void {
	if (list.length) languages = new Set(list.map((l) => l.toLowerCase()));
}

export function fenceLanguage(state: EditorState, node: SyntaxNode): string {
	const info = node.getChild('CodeInfo');
	return info ? (state.sliceDoc(info.from, info.to).trim().split(/\s/)[0] ?? '').toLowerCase() : '';
}

/** Whether a fenced code block is shown as Obsidian renders it. */
export function isRenderedFence(state: EditorState, node: SyntaxNode): boolean {
	return languages.has(fenceLanguage(state, node));
}
