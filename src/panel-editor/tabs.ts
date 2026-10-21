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
	 * pointer and takes a neighbour's place once its middle crosses the
	 * neighbour's.
	 */
	private press(el: HTMLElement, id: string, event: PointerEvent): void {
		if (event.button !== 0) return;
		// Keeps focus in the editor, which select() hands it to.
		event.preventDefault();
		this.events.select(id);
		const startX = event.clientX;
		const grab = startX - el.getBoundingClientRect().left;
		let dragging = false;
		let shift = 0;
		el.setPointerCapture(event.pointerId);

		const move = (e: PointerEvent) => {
			if (!dragging) {
				if (Math.abs(e.clientX - startX) < DRAG_THRESHOLD_PX) return;
				dragging = true;
				el.classList.add('is-dragging');
			}
			this.scrollNearEdge(e.clientX);
			this.reorder(el, e.clientX - grab + el.offsetWidth / 2);
			// Where the tab sits in the strip now, without the shift already applied.
			const slot = el.getBoundingClientRect().left - shift;
			shift = e.clientX - grab - slot;
			el.style.setProperty('--fn-shift', `${shift}px`);
		};
		const end = () => {
			el.removeEventListener('pointermove', move);
			el.removeEventListener('pointerup', end);
			el.removeEventListener('pointercancel', end);
			el.classList.remove('is-dragging');
			el.style.removeProperty('--fn-shift');
		};
		el.addEventListener('pointermove', move);
		el.addEventListener('pointerup', end);
		el.addEventListener('pointercancel', end);
	}

	/** Put the dragged tab before the first other tab whose middle is right of `centre`. */
	private reorder(el: HTMLElement, centre: number): void {
		const others = Array.from(this.strip.children).filter((other) => other !== el);
		const before =
			others.find((other) => {
				const r = other.getBoundingClientRect();
				return r.left + r.width / 2 > centre;
			}) ?? null;
		const inPlace = before ? el.nextElementSibling === before : el === this.strip.lastElementChild;
		if (!inPlace) this.strip.insertBefore(el, before);
	}

	private scrollNearEdge(x: number): void {
		const r = this.strip.getBoundingClientRect();
		if (x < r.left + EDGE_PX) this.strip.scrollLeft -= EDGE_STEP_PX;
		else if (x > r.right - EDGE_PX) this.strip.scrollLeft += EDGE_STEP_PX;
	}
}
