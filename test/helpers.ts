import { EditorSelection, EditorState } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import { buildDecorations } from '../src/panel-editor/live-preview';
import { buildBlocks } from '../src/panel-editor/live-preview/blocks';
import { unresolvedField } from '../src/panel-editor/live-preview/links';
import { revealField, setFocused } from '../src/panel-editor/live-preview/reveal';
import { markdownSyntax } from '../src/panel-editor/syntax';

/**
 * A state for `doc`, where `¦` marks the cursor. Without a cursor the editor
 * is unfocused, so nothing is revealed.
 */
export function state(doc: string, unresolved: string[] = []): EditorState {
	const cursor = doc.indexOf('¦');
	const text = cursor < 0 ? doc : doc.slice(0, cursor) + doc.slice(cursor + 1);
	const s = EditorState.create({
		doc: text,
		selection: EditorSelection.cursor(Math.max(cursor, 0)),
		extensions: [markdownSyntax(), revealField, unresolvedField.init(() => new Set(unresolved))],
	});
	return cursor < 0 ? s : s.update({ effects: setFocused.of(true) }).state;
}

/** Decorations as readable strings: `hide "**"`, `mark fn-link "text"`, `widget CheckboxWidget "- [ ]"`, `line fn-quote @1`. */
function describe(s: EditorState, set: DecorationSet): string[] {
	const out: string[] = [];
	set.between(0, s.doc.length, (from, to, deco) => {
		const spec = deco.spec as { class?: string; widget?: object; block?: boolean };
		const text = JSON.stringify(s.sliceDoc(from, to));
		if (spec.widget) out.push(`${spec.block ? 'block' : 'widget'} ${spec.widget.constructor.name} ${text}`);
		else if (from === to && spec.class) out.push(`line ${spec.class} @${s.doc.lineAt(from).number}`);
		else if (spec.class) out.push(`mark ${spec.class} ${text}`);
		else out.push(`hide ${text}`);
	});
	return out;
}

export function inline(doc: string, unresolved: string[] = []): string[] {
	const s = state(doc, unresolved);
	return describe(s, buildDecorations(s, [{ from: 0, to: s.doc.length }]));
}

export function blocks(doc: string): string[] {
	const s = state(doc);
	return describe(s, buildBlocks(s));
}
