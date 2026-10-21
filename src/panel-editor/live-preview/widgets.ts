import { EditorView, WidgetType } from '@codemirror/view';
import { calloutStyle } from '../theme';

export class BulletWidget extends WidgetType {
	eq(): boolean {
		return true;
	}

	toDOM(): HTMLElement {
		const el = document.createElement('span');
		el.className = 'fn-bullet';
		el.textContent = '•';
		return el;
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
		const el = document.createElement('span');
		el.className = this.checked ? 'fn-checkbox fn-checked' : 'fn-checkbox';
		el.setAttribute('role', 'checkbox');
		el.setAttribute('aria-checked', String(this.checked));
		el.addEventListener('mousedown', (event) => {
			event.preventDefault();
			event.stopPropagation();
			if (event.button !== 0) return;
			const at = view.posAtDOM(el) + this.offset;
			const current = view.state.sliceDoc(at, at + 1);
			view.dispatch({ changes: { from: at, to: at + 1, insert: current === ' ' ? 'x' : ' ' } });
		});
		return el;
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
		const el = document.createElement('span');
		el.className = 'fn-rule';
		return el;
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
		const el = document.createElement('span');
		const icon = el.appendChild(document.createElement('span'));
		icon.className = 'fn-callout-icon';
		// An icon from Obsidian's own set, as SVG markup measured from the theme.
		const svg = calloutStyle(this.type).icon;
		if (svg) icon.append(new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement);
		if (this.showType) el.append(this.type.charAt(0).toUpperCase() + this.type.slice(1).toLowerCase());
		return el;
	}
}
