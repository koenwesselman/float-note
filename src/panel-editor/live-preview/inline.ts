import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common';
import type { Builder } from './builder';
import { isUnresolved } from './links';
import { RenderedWidget } from './render';
import { isRevealed } from './reveal';

/** Elements whose markers hide, and the name of those markers. */
const MARKED: Record<string, string> = {
	Emphasis: 'EmphasisMark',
	StrongEmphasis: 'EmphasisMark',
	Strikethrough: 'StrikethroughMark',
	Highlight: 'HighlightMark',
	InlineCode: 'CodeMark',
	Autolink: 'LinkMark',
};

/** Elements Obsidian renders, shown as its rendering. */
const RENDERED = new Set(['Embed', 'Image', 'InlineMath', 'DisplayMath']);

/**
 * Inline Live Preview for one syntax node: markers hidden and links shown as
 * their text, except where the selection touches the element. Returns false
 * when the node's children need no visit.
 */
export function decorateInline(b: Builder, ref: SyntaxNodeRef): boolean {
	const { state } = b;
	const name = ref.name;
	const marks = MARKED[name];
	if (marks) {
		if (!isRevealed(state, ref.from, ref.to)) for (const m of ref.node.getChildren(marks)) b.hide(m.from, m.to);
		return true;
	}
	switch (name) {
		case 'Escape':
			if (!isRevealed(state, ref.from, ref.to)) b.hide(ref.from, ref.from + 1);
			return false;
		case 'Link':
			decorateLink(b, ref.node);
			return true;
		case 'WikiLink':
			decorateWikiLink(b, ref.node);
			return false;
		case 'URL': {
			const parent = ref.node.parent?.name;
			if (parent !== 'Link' && parent !== 'Image' && parent !== 'Autolink') b.mark(ref.from, ref.to, 'fn-link');
			return false;
		}
	}
	if (RENDERED.has(name)) {
		const multiline = state.doc.lineAt(ref.from).number !== state.doc.lineAt(ref.to).number;
		// Multi-line math is a block, which only blocks.ts may replace.
		if (!multiline && !isRevealed(state, ref.from, ref.to)) b.widget(ref.from, ref.to, new RenderedWidget(state, state.sliceDoc(ref.from, ref.to), true));
		return false;
	}
	return true;
}

/** `[text](url)` shows as text; `[text]` with no destination or label is left alone. */
function decorateLink(b: Builder, node: SyntaxNode): void {
	if (!node.getChild('URL') && !node.getChild('LinkLabel')) return;
	if (isRevealed(b.state, node.from, node.to)) return;
	const marks = node.getChildren('LinkMark');
	const open = marks[0];
	const close = marks[1];
	if (!open || !close) return;
	b.hide(open.from, open.to);
	b.hide(close.from, node.to);
	b.mark(open.to, close.from, 'fn-link');
}

/** `[[target|alias]]` shows as its alias, or its target; dimmed when the target does not exist. */
function decorateWikiLink(b: Builder, node: SyntaxNode): void {
	const target = node.getChild('WikiTarget');
	if (!target) return;
	const alias = node.getChild('WikiAlias');
	const shown = alias ?? target;
	const unresolved = isUnresolved(b.state, b.state.sliceDoc(target.from, target.to));
	b.mark(shown.from, shown.to, unresolved ? 'fn-link fn-unresolved' : 'fn-link');
	if (isRevealed(b.state, node.from, node.to)) return;
	b.hide(node.from, shown.from);
	b.hide(shown.to, node.to);
}
