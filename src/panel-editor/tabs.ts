/**
 * The panel's tab strip: one tab per floating note, in the order the user
 * drags them into. Only the DOM lives here - what a tab holds is index.ts's.
 */
import { drawClose } from './chrome';

export interface TabBarEvents {
	/** A tab was pressed. */
	select(id: string): void;
	/** A tab's × was clicked, or the tab middle-clicked. */
	close(id: string): void;
}

/** How far a press must move before it becomes a drag rather than a click. */
const DRAG_THRESHOLD_PX = 4;
/** How near the strip's edge a drag scrolls it, and by how much per move. */
const EDGE_PX = 24;
const EDGE_STEP_PX = 12;

export class TabBar {
	private readonly tabs = new Map<string, { el: HTMLElement; name: HTMLElement }>();

	constructor(
		private readonly strip: HTMLElement,
		private readonly events: TabBarEvents,
	) {
		// A mouse wheel scrolls a strip too wide for the panel sideways.
		strip.addEventListener(
			'wheel',
			(event) => {
				if (event.deltaX !== 0 || event.deltaY === 0) return;
				strip.scrollLeft += event.deltaY;
				event.preventDefault();
			},
			{ passive: false },
		);
	}

	/** A tab at the end, cloned from the page's template. */
	add(id: string, name: string): void {
		const template = document.getElementById('fn-tab-template') as HTMLTemplateElement | null;
		const el = template?.content.firstElementChild?.cloneNode(true) as HTMLElement | undefined;
		const label = el?.querySelector<HTMLElement>('.fn-tab-name');
		const close = el?.querySelector<HTMLElement>('.fn-tab-close');
		if (!el || !label || !close) return;
		el.dataset.id = id;
		drawClose(close);
		close.addEventListener('pointerdown', (event) => {
			event.stopPropagation();
			event.preventDefault();
		});
		close.addEventListener('click', (event) => {
			event.stopPropagation();
			this.events.close(id);
		});
		el.addEventListener('pointerdown', (event) => this.press(el, id, event));
		el.addEventListener('auxclick', (event) => {
			if (event.button !== 1) return;
			event.preventDefault();
			this.events.close(id);
		});
		this.strip.append(el);
		this.tabs.set(id, { el, name: label });
		this.rename(id, name);
	}

	remove(id: string): void {
		this.tabs.get(id)?.el.remove();
		this.tabs.delete(id);
	}

	rename(id: string, name: string): void {
		const tab = this.tabs.get(id);
		if (!tab) return;
		tab.name.textContent = name;
		tab.el.title = name;
	}

	setActive(id: string): void {
		for (const [tabId, { el }] of this.tabs) el.classList.toggle('is-active', tabId === id);
		this.tabs.get(id)?.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}

	/** Tab ids in the order shown. */
	order(): string[] {
		return Array.from(this.strip.children, (el) => (el as HTMLElement).dataset.id ?? '');
	}

	/**
	 * Select on press; past the threshold, drag. The dragged tab follows the
	 * pointer, kept within the row of tabs, and takes a neighbour's place once
	 * its middle crosses the neighbour's.
	 *
	 * Moving the tab in the DOM drops its pointer capture, so the capture is
	 * taken again after each move, and the drag is followed on the document:
	 * a release away from the tab - over the strip's window-drag area, say -
	 * still ends it.
	 */
	private press(el: HTMLElement, id: string, event: PointerEvent): void {
		if (event.button !== 0) return;
		// Keeps focus in the editor, which select() hands it to.
		event.preventDefault();
		this.events.select(id);
		const pointer = event.pointerId;
		const startX = event.clientX;
		const grab = startX - el.getBoundingClientRect().left;
		const doc = el.ownerDocument;
		let dragging = false;
		let shift = 0;
		el.setPointerCapture(pointer);

		const move = (e: PointerEvent) => {
			if (e.pointerId !== pointer) return;
			if (!dragging) {
				if (Math.abs(e.clientX - startX) < DRAG_THRESHOLD_PX) return;
				dragging = true;
				el.classList.add('is-dragging');
			}
			this.scrollNearEdge(e.clientX);
			if (this.reorder(el, e.clientX - grab + el.offsetWidth / 2)) recapture();
			// Where the tab sits in the strip now, without the shift already applied.
			const slot = el.getBoundingClientRect().left - shift;
			const { left, right } = this.extent(el, shift);
			const target = Math.min(Math.max(e.clientX - grab, left), right - el.offsetWidth);
			shift = target - slot;
			el.style.setProperty('--fn-shift', `${shift}px`);
		};
		const recapture = () => {
			try {
				el.setPointerCapture(pointer);
			} catch {
				// The pointer is already up; the document listeners end the drag.
			}
		};
		const end = (e: PointerEvent) => {
			if (e.pointerId !== pointer) return;
			doc.removeEventListener('pointermove', move, true);
			doc.removeEventListener('pointerup', end, true);
			doc.removeEventListener('pointercancel', end, true);
			el.classList.remove('is-dragging');
			el.style.removeProperty('--fn-shift');
		};
		doc.addEventListener('pointermove', move, true);
		doc.addEventListener('pointerup', end, true);
		doc.addEventListener('pointercancel', end, true);
	}

	/** The left of the first tab and the right of the last, as laid out - the dragged tab's own shift taken out. */
	private extent(dragged: HTMLElement, shift: number): { left: number; right: number } {
		let left = Infinity;
		let right = -Infinity;
		for (const child of Array.from(this.strip.children)) {
			const r = child.getBoundingClientRect();
			const offset = child === dragged ? shift : 0;
			left = Math.min(left, r.left - offset);
			right = Math.max(right, r.right - offset);
		}
		return { left, right };
	}

	/** Put the dragged tab before the first other tab whose middle is right of `centre`. True when it moved. */
	private reorder(el: HTMLElement, centre: number): boolean {
		const others = Array.from(this.strip.children).filter((other) => other !== el);
		const before =
			others.find((other) => {
				const r = other.getBoundingClientRect();
				return r.left + r.width / 2 > centre;
			}) ?? null;
		const inPlace = before ? el.nextElementSibling === before : el === this.strip.lastElementChild;
		if (inPlace) return false;
		this.strip.insertBefore(el, before);
		return true;
	}

	private scrollNearEdge(x: number): void {
		const r = this.strip.getBoundingClientRect();
		if (x < r.left + EDGE_PX) this.strip.scrollLeft -= EDGE_STEP_PX;
		else if (x > r.right - EDGE_PX) this.strip.scrollLeft += EDGE_STEP_PX;
	}
}
