import { syntaxTree } from '@codemirror/language';
import type { EditorState, Extension } from '@codemirror/state';
import { DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { blocks } from './blocks';
import { Builder } from './builder';
import { decorateInline } from './inline';
import { decorateLines } from './lines';
import { unresolvedField } from './links';
import { renderedEffect } from './render';
import { revealField } from './reveal';

/** Inline and line decorations for the given ranges - the visible part of the note. */
export function buildDecorations(state: EditorState, ranges: readonly { from: number; to: number }[]): DecorationSet {
	const b = new Builder(state);
	for (const { from, to } of ranges) {
		syntaxTree(state).iterate({
			from,
			to,
			enter: (ref) => decorateLines(b, ref, from, to) && decorateInline(b, ref),
		});
	}
	return b.finish();
}

function needsRebuild(update: ViewUpdate): boolean {
	const { startState, state } = update;
	return (
		update.docChanged ||
		update.viewportChanged ||
		syntaxTree(startState) !== syntaxTree(state) ||
		startState.field(revealField, false) !== state.field(revealField, false) ||
		startState.field(unresolvedField, false) !== state.field(unresolvedField, false) ||
		update.transactions.some((tr) => tr.effects.some((e) => e.is(renderedEffect)))
	);
}

const decorations = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;

		constructor(view: EditorView) {
			this.decorations = buildDecorations(view.state, view.visibleRanges);
		}

		update(update: ViewUpdate) {
			if (needsRebuild(update)) this.decorations = buildDecorations(update.state, update.view.visibleRanges);
		}
	},
	{ decorations: (plugin) => plugin.decorations },
);

/**
 * Live Preview: the note shown rendered, with markup revealed only where the
 * cursor is. Swapped in and out of the editor through a compartment, so
 * switching to Source keeps the undo history and the cursor. What it reads -
 * the reveal state, unresolved links - lives outside the compartment, so it
 * survives the switch.
 *
 * A constant, so the compartment's current content can be compared with it.
 */
export const livePreview: Extension = [EditorView.editorAttributes.of({ class: 'fn-live-preview' }), decorations, blocks];
