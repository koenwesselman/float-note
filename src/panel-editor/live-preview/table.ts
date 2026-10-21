import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { EditorView, WidgetType } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { el } from '../dom';

type Align = 'left' | 'center' | 'right' | null;

/** Marks and link parts that are not shown when inline Markdown is drawn. */
const HIDDEN = new Set(['EmphasisMark', 'CodeMark', 'LinkMark', 'StrikethroughMark', 'HighlightMark', 'WikiMark', 'URL', 'LinkTitle', 'LinkLabel', 'CommentMark', 'Comment']);
const ELEMENTS: Record<string, keyof HTMLElementTagNameMap> = {
	StrongEmphasis: 'strong',
	Emphasis: 'em',
	Strikethrough: 's',
	Highlight: 'mark',
	InlineCode: 'code',
};

/** Draw the inline Markdown of `node` between `from` and `to` as DOM, from the syntax tree. */
export function renderInline(state: EditorState, node: SyntaxNode, from: number, to: number, parent: HTMLElement): void {
	let pos = from;
	for (let child = node.firstChild; child; child = child.nextSibling) {
		if (child.to <= from || child.from >= to) continue;
		if (child.from > pos) parent.append(state.sliceDoc(pos, child.from));
		pos = Math.max(pos, child.to);
		if (HIDDEN.has(child.name)) continue;
		if (child.name === 'Escape') {
			parent.append(state.sliceDoc(child.from + 1, child.to));
		} else if (child.name === 'WikiLink' || child.name === 'Embed') {
			const shown = child.getChild('WikiAlias') ?? child.getChild('WikiTarget');
			const link = parent.appendChild(el('span', 'fn-link'));
			if (shown) link.textContent = state.sliceDoc(shown.from, shown.to);
		} else if (child.name === 'Link') {
			const link = parent.appendChild(el('span', 'fn-link'));
			renderInline(state, child, child.from, child.to, link);
		} else {
			const tag = ELEMENTS[child.name];
			renderInline(state, child, child.from, child.to, tag ? parent.appendChild(el(tag)) : parent);
		}
	}
	if (pos < to) parent.append(state.sliceDoc(pos, to));
}

/** Column alignment from the delimiter row, `:--`, `:-:` and `--:`. */
function alignments(row: string): Align[] {
	return row
		.trim()
		.replace(/^\||\|$/g, '')
		.split('|')
		.map((cell) => {
			const c = cell.trim();
			if (c.startsWith(':') && c.endsWith(':')) return 'center';
			if (c.endsWith(':')) return 'right';
			if (c.startsWith(':')) return 'left';
			return null;
		});
}

/**
 * A GFM table, drawn by the panel itself. Clicking it puts the cursor in
 * it, which shows the source for editing.
 */
export class TableWidget extends WidgetType {
	constructor(
		/** The table's source, for eq: identical source draws an identical table. */
		private readonly source: string,
		private readonly from: number,
	) {
		super();
	}

	eq(other: TableWidget): boolean {
		return other.source === this.source;
	}

	toDOM(view: EditorView): HTMLElement {
		const table = el('table', 'fn-table');
		const node = syntaxTree(view.state).resolveInner(this.from, 1);
		let tableNode: SyntaxNode | null = node;
		while (tableNode && tableNode.name !== 'Table') tableNode = tableNode.parent;
		if (!tableNode) {
			table.textContent = this.source;
			return table;
		}
		const delimiterLine = view.state.doc.lineAt(tableNode.from).number + 1;
		const align = delimiterLine <= view.state.doc.lines ? alignments(view.state.doc.line(delimiterLine).text) : [];
		let columns = 0;
		for (let row = tableNode.firstChild; row; row = row.nextSibling) {
			if (row.name !== 'TableHeader' && row.name !== 'TableRow') continue;
			const header = row.name === 'TableHeader';
			const tr = (header ? table.createTHead() : (table.tBodies[0] ?? table.createTBody())).insertRow();
			const cells = row.getChildren('TableCell');
			if (header) columns = cells.length;
			for (let i = 0; i < Math.max(columns, cells.length); i++) {
				const cell = tr.appendChild(el(header ? 'th' : 'td'));
				const a = align[i];
				if (a) cell.style.textAlign = a;
				const source = cells[i];
				if (source) renderInline(view.state, source, source.from, source.to, cell);
			}
		}
		return table;
	}

	ignoreEvent(): boolean {
		return false;
	}
}
