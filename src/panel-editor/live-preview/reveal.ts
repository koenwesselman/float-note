import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';

/**
 * Where Live Preview shows markup: around the selection, and only while the
 * editor has focus - a panel nobody is typing in shows the note fully
 * rendered. During a mouse drag the revealed places stay where they were, so
 * text does not shift under the pointer; they catch up on mouse-up.
 */
interface Reveal {
	focused: boolean;
	dragging: boolean;
	ranges: readonly { from: number; to: number }[];
}

export const setFocused = StateEffect.define<boolean>();
const setDragging = StateEffect.define<boolean>();

function selectionRanges(state: EditorState): Reveal['ranges'] {
	return state.selection.ranges.map((r) => ({ from: r.from, to: r.to }));
}

export const revealField = StateField.define<Reveal>({
	create: (state) => ({ focused: false, dragging: false, ranges: selectionRanges(state) }),
	update(value, tr) {
		let { focused, dragging, ranges } = value;
		for (const effect of tr.effects) {
			if (effect.is(setFocused)) focused = effect.value;
			if (effect.is(setDragging)) dragging = effect.value;
		}
		if (!dragging && (tr.selection || tr.docChanged || value.dragging)) {
			ranges = selectionRanges(tr.state);
		} else if (tr.docChanged) {
			ranges = ranges.map((r) => ({ from: tr.changes.mapPos(r.from), to: tr.changes.mapPos(r.to) }));
		}
		if (focused === value.focused && dragging === value.dragging && sameRanges(ranges, value.ranges)) return value;
		return { focused, dragging, ranges };
	},
});

function sameRanges(a: Reveal['ranges'], b: Reveal['ranges']): boolean {
	return a.length === b.length && a.every((r, i) => r.from === b[i]?.from && r.to === b[i]?.to);
}

/** Whether markup between `from` and `to` shows. A cursor at either edge counts as touching it. */
export function isRevealed(state: EditorState, from: number, to: number): boolean {
	const reveal = state.field(revealField, false);
	if (!reveal?.focused) return false;
	return reveal.ranges.some((r) => r.from <= to && r.to >= from);
}

/** After setState, which starts the field unfocused even when the editor has focus. */
export function syncFocus(view: EditorView): void {
	if (view.state.field(revealField).focused !== view.hasFocus) view.dispatch({ effects: setFocused.of(view.hasFocus) });
}

/** Feeds focus and mouse drags into revealField. */
const tracker = ViewPlugin.fromClass(
	class {
		private readonly onMouseUp = () => {
			if (this.view.state.field(revealField).dragging) this.view.dispatch({ effects: setDragging.of(false) });
		};

		constructor(private readonly view: EditorView) {
			view.dom.ownerDocument.addEventListener('mouseup', this.onMouseUp, true);
		}

		destroy() {
			this.view.dom.ownerDocument.removeEventListener('mouseup', this.onMouseUp, true);
		}
	},
	{
		eventHandlers: {
			mousedown(event, view) {
				if (event.button === 0) view.dispatch({ effects: setDragging.of(true) });
				return false;
			},
		},
	},
);

export const reveal = [revealField, tracker, EditorView.focusChangeEffect.of((_state, focusing) => setFocused.of(focusing))];
