import type { EditorState } from '@codemirror/state';
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common';
import { calloutStyle } from '../theme';
import type { Builder } from './builder';
import { isRenderedFence } from './fences';
import { isRevealed } from './reveal';
import { BulletWidget, CalloutTitleWidget, CheckboxWidget, RuleWidget } from './widgets';

const CALLOUT = /^(\s*>\s*)\[!([^\]\s]+)\]([+-]?)[ \t]*/;

function lineRevealed(state: EditorState, pos: number): boolean {
	const line = state.doc.lineAt(pos);
	return isRevealed(state, line.from, line.to);
}

/**
 * Line-level Live Preview for one syntax node: headings, quotes and
 * callouts, lists and tasks, rules and code blocks. Line markup shows while
 * the cursor is on that line. `from` and `to` bound the lines styled.
 * Returns false when the node's children need no visit.
 */
export function decorateLines(b: Builder, ref: SyntaxNodeRef, from: number, to: number): boolean {
	const { state } = b;
	const name = ref.name;
	if (/^ATXHeading[1-6]$/.test(name)) {
		if (!lineRevealed(state, ref.from)) decorateHeading(b, ref.node);
		return true;
	}
	switch (name) {
		case 'Blockquote':
			decorateQuote(b, ref.node, from, to);
			return true;
		case 'QuoteMark': {
			const line = state.doc.lineAt(ref.from);
			if (!b.calloutTitles.has(line.number) && !isRevealed(state, line.from, line.to)) b.hide(ref.from, ref.to + (state.sliceDoc(ref.to, ref.to + 1) === ' ' ? 1 : 0));
			return false;
		}
		case 'ListMark':
			decorateListMark(b, ref.node);
			return false;
		case 'Task':
			decorateTask(b, ref.node);
			return true;
		case 'HorizontalRule':
			if (!lineRevealed(state, ref.from)) b.widget(ref.from, ref.to, new RuleWidget());
			return false;
		case 'FencedCode':
			decorateFence(b, ref.node, from, to);
			return false;
		case 'CodeBlock':
			forLines(state, ref.from, ref.to, from, to, (pos, first, last) => b.line(pos, codeLineClass(first, last)));
			return false;
	}
	return true;
}

/** Each line of from..to that also lies in the visible range lo..hi. */
function forLines(state: EditorState, from: number, to: number, lo: number, hi: number, fn: (pos: number, first: boolean, last: boolean) => void): void {
	const first = state.doc.lineAt(from).number;
	const last = state.doc.lineAt(to).number;
	for (let n = first; n <= last; n++) {
		const line = state.doc.line(n);
		if (line.to < lo || line.from > hi) continue;
		fn(line.from, n === first, n === last);
	}
}

function codeLineClass(first: boolean, last: boolean): string {
	return `fn-code-line${first ? ' fn-code-first' : ''}${last ? ' fn-code-last' : ''}`;
}

function decorateHeading(b: Builder, node: SyntaxNode): void {
	const marks = node.getChildren('HeaderMark');
	const open = marks[0];
	if (!open) return;
	b.hide(open.from, open.to + (b.state.sliceDoc(open.to, open.to + 1) === ' ' ? 1 : 0));
	const close = marks[1];
	if (!close) return;
	const text = b.state.sliceDoc(open.to, close.from);
	b.hide(close.from - (text.length - text.trimEnd().length), close.to);
}

/** A quote gets a border; a callout - `> [!type] title` - its colour, icon and title. */
function decorateQuote(b: Builder, node: SyntaxNode, from: number, to: number): void {
	const { state } = b;
	const first = state.doc.lineAt(node.from);
	const match = CALLOUT.exec(first.text);
	if (!match) {
		forLines(state, node.from, node.to, from, to, (pos) => b.line(pos, 'fn-quote'));
		return;
	}
	const type = match[2] ?? 'note';
	const style = `--fn-callout-rgb: ${calloutStyle(type).colour}`;
	forLines(state, node.from, node.to, from, to, (pos, isFirst, isLast) =>
		b.line(pos, `fn-callout${isFirst ? ' fn-callout-first fn-callout-title' : ''}${isLast ? ' fn-callout-last' : ''}`, style),
	);
	if (isRevealed(state, first.from, first.to)) return;
	b.calloutTitles.add(first.number);
	const start = first.from + first.text.length - first.text.trimStart().length;
	const hasTitle = first.text.slice(match[0].length).trim() !== '';
	b.widget(start, first.from + match[0].length, new CalloutTitleWidget(type, !hasTitle));
}

/** A bullet's `-`, `*` or `+` as a dot, unless the cursor is at it. Ordered lists keep their numbers. */
function decorateListMark(b: Builder, mark: SyntaxNode): void {
	if (mark.nextSibling?.name === 'Task') return;
	if (mark.parent?.parent?.name !== 'BulletList') return;
	if (!isRevealed(b.state, mark.from, mark.to)) b.widget(mark.from, mark.to, new BulletWidget());
}

/** `- [ ]` as a checkbox, unless the cursor is in it; done tasks styled as the theme styles them. */
function decorateTask(b: Builder, task: SyntaxNode): void {
	const marker = task.getChild('TaskMarker');
	if (!marker) return;
	const checked = b.state.sliceDoc(marker.from + 1, marker.to - 1) !== ' ';
	if (checked) b.mark(marker.to + (b.state.sliceDoc(marker.to, marker.to + 1) === ' ' ? 1 : 0), task.to, 'fn-task-done');
	const listMark = task.prevSibling;
	const bullet = listMark?.name === 'ListMark' && task.parent?.parent?.name === 'BulletList';
	const start = bullet && listMark ? listMark.from : marker.from;
	if (isRevealed(b.state, start, marker.to)) return;
	b.widget(start, marker.to, new CheckboxWidget(checked, marker.from + 1 - start));
}

/** Code block lines on a background, fences hidden while the cursor is outside the block. */
function decorateFence(b: Builder, node: SyntaxNode, from: number, to: number): void {
	const { state } = b;
	const revealed = isRevealed(state, node.from, node.to);
	// Shown as Obsidian renders it, by blocks.ts.
	if (!revealed && isRenderedFence(state, node)) return;
	const marks = node.getChildren('CodeMark');
	const closing = marks.length > 1 ? marks[marks.length - 1] : undefined;
	const closingLine = closing ? state.doc.lineAt(closing.from).number : -1;
	forLines(state, node.from, node.to, from, to, (pos, first, last) => {
		// A hidden closing fence would leave a full empty line; it shrinks to a strip of padding.
		const shrink = !revealed && state.doc.lineAt(pos).number === closingLine;
		b.line(pos, codeLineClass(first, last) + (shrink ? ' fn-code-closing' : ''));
	});
	if (revealed) return;
	for (const mark of marks) b.hide(mark.from, mark.to);
	const info = node.getChild('CodeInfo');
	if (info) b.mark(info.from, info.to, 'fn-code-info');
}
