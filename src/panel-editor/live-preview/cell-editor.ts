import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { EditorSelection, EditorState, Extension, Facet, Prec, Transaction } from '@codemirror/state';
import { EditorView, ViewPlugin, ViewUpdate, drawSelection, keymap } from '@codemirror/view';
import { drawCell, tableAt, tableRows } from './table';

/**
 * Editing a table cell in place, as Obsidian's Live Preview does: a small
 * editor of its own in the cell, whose every change is written straight
 * into the note. Tab and Shift+Tab move along the cells, Enter and the up
 * and down arrows between rows; leaving the last cell, or clicking away,
 * ends the editing.
 */

/** What a cell's editor needs from the note's editor - its syntax, Live Preview, the tab it is in. Provided by index.ts. */
export const cellSetup = Facet.define<Extension, Extension>({ combine: (values) => values });

interface Editing {
	main: EditorView;
	table: HTMLElement;
	cell: HTMLElement;
	row: number;
	col: number;
	/** The cell's text in the note, kept up to date with the note's changes. */
	from: number;
	to: number;
	/** Null while the cell is being prepared - added to a short row - before its editor opens. */
	editor: EditorView | null;
}

const editing = new Map<HTMLElement, Editing>();

/**
 * Keep each open cell's place in the note as the note changes. A view
 * plugin rather than an update listener, because plugins update before the
 * DOM does - and so before keepWhileEditing compares the cell's text.
 */
export const cellTracking = ViewPlugin.define(() => ({
	update(update: ViewUpdate) {
		if (!update.docChanged) return;
		for (const e of editing.values()) {
			if (e.main !== update.view) continue;
			e.from = update.changes.mapPos(e.from, -1);
			e.to = update.changes.mapPos(e.to, 1);
		}
	},
}));

/** Clicking a cell edits it. */
export function watchTable(main: EditorView, table: HTMLElement): void {
	table.addEventListener('mousedown', (event) => {
		if (event.button !== 0) return;
		const cell = (event.target as Element | null)?.closest<HTMLElement>('td, th');
		if (!cell || !table.contains(cell)) return;
		// Inside the open editor, the click is its own.
		if (editing.get(table)?.cell === cell) return;
		event.preventDefault();
		openCell(main, table, Number(cell.dataset.row), Number(cell.dataset.col), { x: event.clientX, y: event.clientY });
	});
}

/**
 * Whether the table keeps its DOM through an update of the note: while a
 * cell is edited, unless the cell's text changed other than through its
 * editor - then the editing ends and the table is drawn again.
 */
export function keepWhileEditing(table: HTMLElement, main: EditorView): boolean {
	const e = editing.get(table);
	if (!e) return false;
	if (!e.editor || main.state.sliceDoc(e.from, e.to) === e.editor.state.doc.toString()) return true;
	stopEditing(table);
	return false;
}

/** End the editing in a table that is going away. */
export function stopEditing(table: HTMLElement): void {
	const e = editing.get(table);
	if (!e) return;
	editing.delete(table);
	e.editor?.destroy();
}

/** End the editing, and draw the cell's text again. */
function closeCell(table: HTMLElement): void {
	const e = editing.get(table);
	if (!e) return;
	stopEditing(table);
	drawCell(e.main.state, locate(e.main, table)?.[e.row]?.cells[e.col], e.cell);
}

function locate(main: EditorView, table: HTMLElement): ReturnType<typeof tableRows> | null {
	const node = tableAt(main.state, main.posAtDOM(table));
	return node ? tableRows(main.state, node) : null;
}

type Place = { x: number; y: number } | 'start' | 'end';

function openCell(main: EditorView, table: HTMLElement, row: number, col: number, place: Place): void {
	closeCell(table);
	const dom = table.querySelector<HTMLElement>(`[data-row="${row}"][data-col="${col}"]`);
	let rows = locate(main, table);
	const target = rows?.[row];
	if (!dom || !target) return;
	const e: Editing = { main, table, cell: dom, row, col, from: 0, to: 0, editor: null };
	editing.set(table, e);
	if (col >= target.cells.length) {
		// A short row: add the missing cells first, empty.
		const missing = col + 1 - target.cells.length;
		main.dispatch({ changes: { from: target.end, insert: (target.closed ? '' : ' |') + '  |'.repeat(missing) } });
		rows = locate(main, table);
	}
	const cell = rows?.[row]?.cells[col];
	if (!cell) {
		editing.delete(table);
		return;
	}
	e.from = cell.from;
	e.to = cell.to;
	dom.replaceChildren();
	e.editor = new EditorView({
		parent: dom,
		state: EditorState.create({
			doc: main.state.sliceDoc(cell.from, cell.to),
			extensions: [
				main.state.facet(cellSetup),
				history(),
				drawSelection(),
				EditorView.lineWrapping,
				EditorView.editorAttributes.of({ class: 'fn-cell-editor' }),
				cellTheme,
				keepCellSyntax,
				Prec.highest(keymap.of(navigation(e))),
				keymap.of([...historyKeymap, ...defaultKeymap]),
				EditorView.updateListener.of((update) => {
					if (update.docChanged) write(e);
				}),
				EditorView.domEventHandlers({
					blur: () => {
						if (editing.get(table) === e) closeCell(table);
					},
				}),
			],
		}),
	});
	const editor = e.editor;
	editor.focus();
	const pos = place === 'start' ? 0 : place === 'end' ? editor.state.doc.length : (editor.posAtCoords(place) ?? editor.state.doc.length);
	editor.dispatch({ selection: EditorSelection.cursor(pos) });
}

/** The cell's editor's text, into the note. */
function write(e: Editing): void {
	if (!e.editor) return;
	const text = e.editor.state.doc.toString();
	e.main.dispatch({ changes: { from: e.from, to: e.to, insert: text }, annotations: Transaction.userEvent.of('input') });
}

/**
 * Move to another cell, `rows` down and `cols` along, wrapping at the ends
 * of rows. Past the table's last cell the editing ends, with the note's
 * cursor after the table.
 */
function move(e: Editing, rows: number, cols: number, place: Place): boolean {
	const table = e.table as HTMLTableElement;
	const count = table.rows.length;
	const columns = table.rows[0]?.cells.length ?? 1;
	let row = e.row + rows;
	let col = e.col + cols;
	if (col >= columns) {
		row++;
		col = 0;
	} else if (col < 0) {
		row--;
		col = columns - 1;
	}
	if (row < 0) return true;
	if (row >= count) {
		leave(e);
		return true;
	}
	openCell(e.main, e.table, row, col, place);
	return true;
}

/** End the editing and put the note's cursor on the line after the table. */
function leave(e: Editing): void {
	const { main, table } = e;
	const node = tableAt(main.state, main.posAtDOM(table));
	closeCell(table);
	if (!node) return;
	const end = main.state.doc.lineAt(node.to).to;
	main.focus();
	main.dispatch({ selection: EditorSelection.cursor(Math.min(end + 1, main.state.doc.length)), scrollIntoView: true });
}

function navigation(e: Editing) {
	const at = (side: 'start' | 'end') => {
		const s = e.editor?.state.selection.main;
		if (!s?.empty) return false;
		return side === 'start' ? s.head === 0 : s.head === e.editor?.state.doc.length;
	};
	return [
		{ key: 'Tab', run: () => move(e, 0, 1, 'end') },
		{ key: 'Shift-Tab', run: () => move(e, 0, -1, 'end') },
		{ key: 'Enter', run: () => move(e, 1, 0, 'end') },
		{ key: 'ArrowUp', run: () => move(e, -1, 0, 'end') },
		{ key: 'ArrowDown', run: () => move(e, 1, 0, 'end') },
		{ key: 'ArrowLeft', run: () => at('start') && move(e, 0, -1, 'end') },
		{ key: 'ArrowRight', run: () => at('end') && move(e, 0, 1, 'start') },
	];
}

/** `|` in a cell's text, escaped so it does not split the cell; a `\|` already escaped is left. */
export function escapePipes(text: string, before: string): string {
	let out = '';
	let previous = before;
	for (const ch of text) {
		out += ch === '|' && previous !== '\\' ? '\\|' : ch;
		previous = ch;
	}
	return out;
}

/** What is typed or pasted into a cell stays one cell's text: line breaks become spaces, and `|` is escaped. */
const keepCellSyntax = EditorState.transactionFilter.of((tr) => {
	if (!tr.docChanged) return tr;
	let changed = false;
	const changes: { from: number; to: number; insert: string }[] = [];
	tr.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
		const text = inserted.toString();
		const clean = escapePipes(text.replace(/\r?\n/g, ' '), tr.startState.sliceDoc(from - 1, from));
		if (clean !== text) changed = true;
		changes.push({ from, to, insert: clean });
	});
	if (!changed) return tr;
	const set = tr.startState.changes(changes);
	return { changes: set, selection: tr.startState.selection.map(set, 1), scrollIntoView: tr.scrollIntoView };
});

/**
 * The cell's editor sits in the note's editor, whose styles - and
 * Obsidian's, once they arrive - reach it too: so its own outrank them,
 * leaving it as plain text in the cell.
 */
const cellTheme = EditorView.theme({
	'&': { backgroundColor: 'transparent', color: 'inherit', fontSize: 'inherit' },
	'&.cm-focused': { outline: 'none' },
	'&.fn-cell-editor.cm-editor .cm-scroller': { padding: '0', fontFamily: 'inherit', lineHeight: 'inherit', overflow: 'visible', scrollbarGutter: 'auto' },
	'&.fn-cell-editor.cm-editor .cm-content': { padding: '0', width: 'auto !important', flexBasis: 'auto !important', minHeight: '0' },
	'&.fn-cell-editor.cm-editor .cm-line': { padding: '0' },
});
