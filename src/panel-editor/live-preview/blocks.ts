import { syntaxTree } from '@codemirror/language';
import { EditorState, StateField, Transaction } from '@codemirror/state';
import { DecorationSet, EditorView } from '@codemirror/view';
import { Builder } from './builder';
import { isRenderedFence } from './fences';
import { renderedEffect, RenderedWidget } from './render';
import { isRevealed, revealField } from './reveal';
import { TableWidget } from './table';

/**
 * Blocks that span lines and are drawn as one widget: tables, Obsidian-
 * rendered code blocks, and `$$` math on lines of its own. CodeMirror takes
 * such replacements only from a state field, not a view plugin, so these are
 * found across the whole note rather than the visible part.
 */
export function buildBlocks(state: EditorState): DecorationSet {
	const b = new Builder(state);
	syntaxTree(state).iterate({
		enter(ref) {
			const name = ref.name;
			if (name === 'Table' || (name === 'FencedCode' && isRenderedFence(state, ref.node)) || (name === 'DisplayMath' && ownsLines(state, ref.from, ref.to))) {
				const from = state.doc.lineAt(ref.from).from;
				const to = state.doc.lineAt(ref.to).to;
				if (isRevealed(state, from, to)) return false;
				const source = state.sliceDoc(ref.from, ref.to);
				b.widget(from, to, name === 'Table' ? new TableWidget(source, ref.from) : new RenderedWidget(source, false), true);
				return false;
			}
			return true;
		},
	});
	return b.finish();
}

/** Whether from..to spans more than one line and has nothing else on its first and last line. */
function ownsLines(state: EditorState, from: number, to: number): boolean {
	const first = state.doc.lineAt(from);
	const last = state.doc.lineAt(to);
	return first.number !== last.number && state.sliceDoc(first.from, from).trim() === '' && state.sliceDoc(to, last.to).trim() === '';
}

function needsRebuild(tr: Transaction): boolean {
	return (
		tr.docChanged ||
		syntaxTree(tr.startState) !== syntaxTree(tr.state) ||
		tr.startState.field(revealField, false) !== tr.state.field(revealField, false) ||
		tr.effects.some((e) => e.is(renderedEffect))
	);
}

export const blocks = StateField.define<DecorationSet>({
	create: buildBlocks,
	update: (value, tr) => (needsRebuild(tr) ? buildBlocks(tr.state) : value),
	provide: (field) => EditorView.decorations.from(field),
});
