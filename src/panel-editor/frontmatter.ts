import { EditorState, RangeSetBuilder, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView } from '@codemirror/view';

/**
 * Frontmatter lines in monospace, as Obsidian's Source mode shows them. Found
 * by text rather than the syntax tree: a leading `---` line and the next
 * `---`, within the first 200 lines.
 */
const frontmatterLine = Decoration.line({ class: 'fn-frontmatter' });

function frontmatterDecorations(state: EditorState): DecorationSet {
	const doc = state.doc;
	if (doc.lines < 2 || doc.line(1).text.trimEnd() !== '---') return Decoration.none;
	const last = Math.min(doc.lines, 200);
	for (let n = 2; n <= last; n++) {
		if (doc.line(n).text.trimEnd() !== '---') continue;
		const builder = new RangeSetBuilder<Decoration>();
		for (let i = 1; i <= n; i++) builder.add(doc.line(i).from, doc.line(i).from, frontmatterLine);
		return builder.finish();
	}
	return Decoration.none;
}

export const frontmatter = StateField.define<DecorationSet>({
	create: frontmatterDecorations,
	update: (value, tr) => (tr.docChanged ? frontmatterDecorations(tr.state) : value),
	provide: (field) => EditorView.decorations.from(field),
});
