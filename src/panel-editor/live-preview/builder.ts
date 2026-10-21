import type { EditorState, Range } from '@codemirror/state';
import { Decoration, DecorationSet, WidgetType } from '@codemirror/view';

const hidden = Decoration.replace({});

/** Collects Live Preview decorations in any order; each line gets at most one line decoration. */
export class Builder {
	private readonly ranges: Range<Decoration>[] = [];
	private readonly lines = new Set<number>();
	/** Lines whose callout title widget already covers the quote marker. */
	readonly calloutTitles = new Set<number>();

	constructor(readonly state: EditorState) {}

	hide(from: number, to: number): void {
		if (to > from) this.ranges.push(hidden.range(from, to));
	}

	mark(from: number, to: number, cls: string): void {
		if (to > from) this.ranges.push(Decoration.mark({ class: cls }).range(from, to));
	}

	widget(from: number, to: number, widget: WidgetType, block = false): void {
		this.ranges.push(Decoration.replace({ widget, block }).range(from, to));
	}

	/** A class, and optionally a style, on the line holding `pos`. The first call for a line wins. */
	line(pos: number, cls: string, style?: string): void {
		const line = this.state.doc.lineAt(pos);
		if (this.lines.has(line.number)) return;
		this.lines.add(line.number);
		const attributes: Record<string, string> = style ? { style } : {};
		this.ranges.push(Decoration.line({ class: cls, attributes }).range(line.from));
	}

	finish(): DecorationSet {
		return Decoration.set(this.ranges, true);
	}
}
