import { el } from './dom';

/**
 * Obsidian's own stylesheet - the app's, the theme's and snippets' - applied
 * to the panel page, so the editor is styled by the same rules as
 * Obsidian's. The editor carries Obsidian's wrapper classes, and Live
 * Preview's decorations Obsidian's line and token classes, for those rules
 * to match. The page's own sheets come after it, so the strip and the
 * editor's frame keep their own styling.
 */
const MARKERS: Record<string, string> = { ul: '-', 'ol-2': '1.', 'ol-3': '10.', 'ol-4': '100.' };

/** Classes on the editor's parent, as on Obsidian's editor; is-live-preview only in Live Preview. */
const WRAPPER = ['markdown-source-view', 'mod-cm6', 'cm-s-obsidian'];

/** Body classes of Obsidian's window that would be wrong in the panel's. */
const SKIPPED_BODY_CLASSES = new Set(['is-translucent']);

export function applyObsidianCss(sheet: CSSStyleSheet, bodyClass: string, bodyStyle: string): void {
	const others = document.adoptedStyleSheets.filter((s) => s !== sheet);
	document.adoptedStyleSheets = [sheet, ...others];
	document.body.className = bodyClass
		.split(/\s+/)
		.filter((cls) => cls && !SKIPPED_BODY_CLASSES.has(cls))
		.join(' ');
	document.body.setAttribute('style', bodyStyle);
	measureMarkers();
}

export function setWrapper(editor: HTMLElement, livePreview: boolean): void {
	editor.classList.add(...WRAPPER);
	editor.classList.toggle('is-live-preview', livePreview);
}

/**
 * How wide each kind of list marker is, with its space, as the theme draws
 * it: the hanging indent that lines a wrapped list item up with its text.
 * Obsidian measures this per line; here it is measured once per theme, on a
 * hidden copy of a list line, and kept as variables the line styles read.
 */
function measureMarkers(): void {
	const host = el('div', `${WRAPPER.join(' ')} is-live-preview fn-probe`);
	const content = host.appendChild(el('div', 'cm-editor')).appendChild(el('div', 'cm-content'));
	const spans: [string, HTMLElement][] = Object.entries(MARKERS).map(([kind, text]) => {
		const line = content.appendChild(el('div', 'cm-line HyperMD-list-line HyperMD-list-line-1'));
		return [kind, line.appendChild(listMarker(kind === 'ul' ? 'ul' : 'ol', text, 1))];
	});
	document.body.append(host);
	try {
		for (const [kind, span] of spans) document.documentElement.style.setProperty(`--fn-marker-${kind}`, `${span.getBoundingClientRect().width}px`);
	} finally {
		host.remove();
	}
}

/** A list marker as Obsidian's Live Preview draws it: a bullet Obsidian's CSS turns into a dot, or a number. */
export function listMarker(kind: 'ul' | 'ol', text: string, level: number): HTMLElement {
	const marker = el('span', `cm-formatting cm-formatting-list cm-formatting-list-${kind} cm-list-${level}`);
	if (kind === 'ul') {
		marker.appendChild(el('span', 'list-bullet')).textContent = text;
		marker.append(' ');
	} else {
		marker.textContent = `${text} `;
	}
	return marker;
}

/** Which measured marker width a marker uses. */
export function markerKind(kind: 'ul' | 'ol', text: string): string {
	return kind === 'ul' ? 'ul' : `ol-${Math.min(Math.max(text.length, 2), 4)}`;
}
