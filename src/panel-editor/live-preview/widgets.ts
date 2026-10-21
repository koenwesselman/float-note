import { EditorView, WidgetType } from '@codemirror/view';
import { calloutStyle } from '../theme';
import { el } from '../dom';

export class BulletWidget extends WidgetType {
	eq(): boolean {
		return true;
	}

	toDOM(): HTMLElement {
		const bullet = el('span', 'fn-bullet');
		bullet.textContent = '•';
		return bullet;
	}
}

/**
 * A task's `- [ ]`, drawn as a checkbox. Clicking toggles the character
 * between the brackets - an ordinary edit, saved like typing - without moving
 * the cursor, so the box does not turn back into source under the pointer.
 */
export class CheckboxWidget extends WidgetType {
	/**
	 * @param checked Whether the task is done.
	 * @param offset From the start of the replaced range to the character between the brackets.
	 */
	constructor(
		private readonly checked: boolean,
		private readonly offset: number,
	) {
		super();
	}

	eq(other: CheckboxWidget): boolean {
		return other.checked === this.checked && other.offset === this.offset;
	}

	toDOM(view: EditorView): HTMLElement {
		const box = el('span', this.checked ? 'fn-checkbox fn-checked' : 'fn-checkbox');
		box.setAttribute('role', 'checkbox');
		box.setAttribute('aria-checked', String(this.checked));
		box.addEventListener('mousedown', (event) => {
			event.preventDefault();
			event.stopPropagation();
			if (event.button !== 0) return;
			const at = view.posAtDOM(box) + this.offset;
			const current = view.state.sliceDoc(at, at + 1);
			view.dispatch({ changes: { from: at, to: at + 1, insert: current === ' ' ? 'x' : ' ' } });
		});
		return box;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

export class RuleWidget extends WidgetType {
	eq(): boolean {
		return true;
	}

	toDOM(): HTMLElement {
		return el('span', 'fn-rule');
	}
}

/** A callout's `[!type]`: its icon, and its type as the title when the callout names none. */
export class CalloutTitleWidget extends WidgetType {
	constructor(
		private readonly type: string,
		private readonly showType: boolean,
	) {
		super();
	}

	eq(other: CalloutTitleWidget): boolean {
		return other.type === this.type && other.showType === this.showType;
	}

	toDOM(): HTMLElement {
		const title = el('span');
		const icon = title.appendChild(el('span', 'fn-callout-icon'));
		// An icon from Obsidian's own set, as SVG markup measured from the theme.
		const svg = calloutStyle(this.type).icon;
		if (svg) icon.append(new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement);
		if (this.showType) title.append(this.type.charAt(0).toUpperCase() + this.type.slice(1).toLowerCase());
		return title;
	}
}
