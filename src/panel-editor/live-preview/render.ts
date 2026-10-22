import { EditorState, StateEffect } from '@codemirror/state';
import { EditorView, WidgetType } from '@codemirror/view';
import { isExternal, requestOpen } from './links';
import { noteId } from './note';
import { el } from '../dom';

/**
 * What the panel cannot draw itself - math, Mermaid, embeds, images,
 * plugin code blocks - Obsidian renders in the main window. A widget that
 * has no rendering yet shows its source and asks for one; the plugin
 * collects the request on its next poll and answers with setRendered.
 * Renderings are kept per tab and source, so typing elsewhere asks for nothing.
 */
export interface RenderRequest {
	key: string;
	/** The tab asking, whose note embeds and relative paths resolve against. */
	tab: string;
	markdown: string;
	/** Inline content: the plugin unwraps the paragraph Obsidian puts around it. */
	inline: boolean;
}

export interface Rendered {
	key: string;
	/** Obsidian's HTML, or null when it could not render. */
	html: string | null;
}

/** Dispatched when renderings arrive, so widgets waiting on them are redrawn. */
export const renderedEffect = StateEffect.define<null>();

const cache = new Map<string, string | null>();
const requested = new Set<string>();
let queue: RenderRequest[] = [];

export function takeRenderRequests(): RenderRequest[] {
	const taken = queue;
	queue = [];
	return taken;
}

export function storeRendered(results: readonly Rendered[]): void {
	for (const { key, html } of results) {
		cache.set(key, html);
		requested.delete(key);
	}
}

/** A closed tab's renderings, which nothing will show again. */
export function clearRendered(tab: string): void {
	const prefix = `${tab}\n`;
	for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key);
	for (const key of [...requested]) if (key.startsWith(prefix)) requested.delete(key);
	queue = queue.filter((r) => r.tab !== tab);
}

/**
 * Obsidian's stylesheet, adopted by every rendering's shadow root. A shadow
 * root because Obsidian's CSS also styles `.cm-*`, the classes of this page's
 * own editor; one shared sheet, so a hundred renderings cost one parse.
 */
let sheets: { obsidian: CSSStyleSheet; overrides: CSSStyleSheet } | null = null;

function adoptable(): { obsidian: CSSStyleSheet; overrides: CSSStyleSheet } {
	if (sheets) return sheets;
	const overrides = new CSSStyleSheet();
	overrides.replaceSync(OVERRIDES);
	sheets = { obsidian: new CSSStyleSheet(), overrides };
	return sheets;
}

const OVERRIDES = `
.fn-obsidian { background: transparent !important; color: var(--text-normal); font-family: var(--font-text); font-size: var(--font-text-size); padding: 0 !important; height: auto !important; overflow: visible !important; }
.fn-obsidian > :first-child { margin-top: 0; }
.fn-obsidian > :last-child { margin-bottom: 0; }
.fn-obsidian.fn-inline, .fn-obsidian.fn-inline > p { display: inline; margin: 0; }
.fn-obsidian img { max-width: 100%; }
.fn-obsidian input { pointer-events: none; }
`;
let bodyClass = '';

export interface Stylesheet {
	css: string;
	/** The main window's body classes - theme-dark and the like - which Obsidian's selectors expect. */
	bodyClass: string;
}

export function setStylesheet(sheet: Stylesheet): void {
	adoptable().obsidian.replaceSync(sheet.css);
	bodyClass = sheet.bodyClass;
}

/** Cmd+click on a link in a rendering opens it; a plain click on one does nothing, as it would navigate the panel. */
function wireLinks(root: HTMLElement, tab: string): void {
	root.addEventListener(
		'mousedown',
		(event) => {
			const anchor = (event.target as Element | null)?.closest('a');
			if (!anchor || !(event.metaKey || event.ctrlKey)) return;
			const href = anchor.getAttribute('data-href') ?? anchor.getAttribute('href') ?? '';
			if (href) requestOpen({ target: href, external: !anchor.hasAttribute('data-href') && isExternal(href) }, tab);
			event.preventDefault();
			event.stopPropagation();
		},
		true,
	);
	root.addEventListener('click', (event) => {
		if ((event.target as Element | null)?.closest('a')) event.preventDefault();
	});
}

export class RenderedWidget extends WidgetType {
	private readonly tab: string;
	private readonly key: string;
	private readonly html: string | null | undefined;

	constructor(
		state: EditorState,
		private readonly source: string,
		private readonly inline: boolean,
	) {
		super();
		this.tab = state.facet(noteId);
		this.key = `${this.tab}\n${inline ? 'i' : 'b'}:${source}`;
		this.html = cache.get(this.key);
	}

	eq(other: RenderedWidget): boolean {
		return other.key === this.key && other.html === this.html;
	}

	toDOM(): HTMLElement {
		const host = el(this.inline ? 'span' : 'div', this.inline ? 'fn-rendered fn-rendered-inline' : 'fn-rendered fn-rendered-block');
		if (this.html === undefined || this.html === null) {
			host.classList.add(this.html === null ? 'fn-rendered-failed' : 'fn-rendered-pending');
			host.textContent = this.source;
			if (this.html === undefined) this.request();
			return host;
		}
		const shadow = host.attachShadow({ mode: 'open' });
		const { obsidian, overrides } = adoptable();
		shadow.adoptedStyleSheets = [obsidian, overrides];
		const content = el(this.inline ? 'span' : 'div', `fn-obsidian markdown-preview-view markdown-rendered ${this.inline ? 'fn-inline' : ''} ${bodyClass}`);
		// Obsidian's own renderer output, made in the main window from this note.
		content.append(...Array.from(new DOMParser().parseFromString(this.html, 'text/html').body.childNodes));
		wireLinks(content, this.tab);
		shadow.append(content);
		return host;
	}

	private request(): void {
		if (requested.has(this.key)) return;
		requested.add(this.key);
		queue.push({ key: this.key, tab: this.tab, markdown: this.source, inline: this.inline });
	}

	/** Clicks reach the editor, which puts the cursor beside the widget and so reveals its source. */
	ignoreEvent(): boolean {
		return false;
	}
}

/** Redraw widgets after renderings arrive. */
export function notifyRendered(view: EditorView): void {
	view.dispatch({ effects: renderedEffect.of(null) });
}
