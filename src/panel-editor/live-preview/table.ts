import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { EditorView, WidgetType } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { el } from '../dom';
import { keepWhileEditing, stopEditing, watchTable } from './cell-editor';

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

/** One cell: its text, trimmed, or where text goes in an empty cell; and its node, which an empty cell has none of. */
export interface Cell {
	from: number;
	to: number;
	node: SyntaxNode | null;
}

export interface Row {
	header: boolean;
	cells: Cell[];
	/** Where the row ends, and whether with a `|`: for adding cells to a short row. */
	end: number;
	closed: boolean;
}

/** The table node starting on the line at `pos`. */
export function tableAt(state: EditorState, pos: number): SyntaxNode | null {
	let found: SyntaxNode | null = null;
	syntaxTree(state).iterate({
		from: pos,
		to: state.doc.lineAt(pos).to,
		enter(ref) {
			if (found) return false;
			if (ref.name === 'Table') found = ref.node;
			return undefined;
		},
	});
	return found;
}

/**
 * A table's rows and cells, from the `|` between them. The parser makes a
 * node only for a cell with text in it, so cells are counted from the
 * delimiters; leading and trailing pipes are optional, as in GFM.
 */
export function tableRows(state: EditorState, table: SyntaxNode): Row[] {
	const rows: Row[] = [];
	for (let row = table.firstChild; row; row = row.nextSibling) {
		if (row.name !== 'TableHeader' && row.name !== 'TableRow') continue;
		const pipes = row.getChildren('TableDelimiter');
		const nodes = row.getChildren('TableCell');
		const bounds = [row.from, ...pipes.flatMap((p) => [p.from, p.to]), row.to];
		const cells: Cell[] = [];
		for (let i = 0; i < bounds.length; i += 2) {
			const from = bounds[i] ?? row.from;
			const to = bounds[i + 1] ?? row.to;
			const first = i === 0;
			const last = i === bounds.length - 2;
			// Before a leading pipe, or after a trailing one: not a cell.
			if ((first && pipes[0]?.from === row.from) || (last && pipes[pipes.length - 1]?.to === row.to)) continue;
			const node = nodes.find((n) => n.from >= from && n.to <= to) ?? null;
			if (node) {
				cells.push({ from: node.from, to: node.to, node });
			} else {
				// Text typed into an empty cell goes after one space, so `|  |` becomes `| x |`.
				const at = Math.min(from + 1, to);
				cells.push({ from: at, to: at, node: null });
			}
		}
		const last = pipes[pipes.length - 1];
		rows.push({ header: row.name === 'TableHeader', cells, end: row.to, closed: last?.to === row.to });
	}
	return rows;
}

/**
 * A GFM table, drawn by the panel itself. Clicking a cell edits it in
 * place, as in Obsidian; the table's source shows only when the cursor
 * moves into the table from outside.
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
		const node = tableAt(view.state, this.from);
		if (!node) {
			table.textContent = this.source;
			return table;
		}
		const delimiterLine = view.state.doc.lineAt(node.from).number + 1;
		const align = delimiterLine <= view.state.doc.lines ? alignments(view.state.doc.line(delimiterLine).text) : [];
		const rows = tableRows(view.state, node);
		// As in GFM, the header row sets how many columns there are.
		const columns = rows[0]?.cells.length ?? 0;
		rows.forEach((row, r) => {
			const tr = (row.header ? table.createTHead() : (table.tBodies[0] ?? table.createTBody())).insertRow();
			for (let c = 0; c < columns; c++) {
				const cell = tr.appendChild(el(row.header ? 'th' : 'td'));
				cell.dataset.row = String(r);
				cell.dataset.col = String(c);
				const a = align[c];
				if (a) cell.style.textAlign = a;
				drawCell(view.state, row.cells[c], cell);
			}
		});
		watchTable(view, table);
		return table;
	}

	/** While a cell is being edited, the table stays as it is: redrawing it would take the cell's editor away. */
	updateDOM(dom: HTMLElement, view: EditorView): boolean {
		return keepWhileEditing(dom, view);
	}

	destroy(dom: HTMLElement): void {
		stopEditing(dom);
	}

	/** The table handles its own clicks: they edit cells. */
	ignoreEvent(): boolean {
		return true;
	}
}

/** A cell's text, drawn from the note. */
export function drawCell(state: EditorState, cell: Cell | undefined, dom: HTMLElement): void {
	dom.replaceChildren();
	if (cell?.node) renderInline(state, cell.node, cell.from, cell.to, dom);
}
