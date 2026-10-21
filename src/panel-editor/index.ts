/**
 * The page that runs inside the panel - a separate, sandboxed renderer with no
 * Node and no Obsidian. Bundled on its own into an IIFE by the
 * `virtual:panel-editor` esbuild plugin, so it carries its own CodeMirror:
 * Obsidian's copy lives in another process and cannot be reached from here.
 *
 * The plugin drives it through `window.floatNote` with executeJavaScript, and
 * learns about edits and close requests only by polling - nothing here calls
 * out, so there is no channel to set up and nothing to leak.
 */
import { Annotation, EditorState, RangeSetBuilder, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, drawSelection, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { yamlFrontmatter } from '@codemirror/lang-yaml';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { TabBar } from './tabs';

export interface Theme {
	background: string;
	text: string;
	muted: string;
	accent: string;
	link: string;
	bold: string;
	italic: string;
	quote: string;
	quoteStyle: string;
	/** h1 to h6, colour and size each. */
	headingColours: string[];
	headingSizes: string[];
	yamlKey: string;
	border: string;
	selection: string;
	codeBackground: string;
	font: string;
	monospace: string;
	size: string;
}

export interface OpenArgs {
	/** The plugin's id for the tab. */
	id: string;
	name: string;
	text: string;
	theme: Theme;
}

export type CloseSource = 'escape' | 'button' | 'mod-w';
export type Mode = 'edit' | 'view';

export interface TabText {
	id: string;
	text: string;
}

export interface ClosedTab {
	id: string;
	/** Edits the plugin has not seen yet, or null. */
	text: string | null;
}

export interface PollResult {
	/** Tabs whose text changed since the last poll. */
	texts: TabText[];
	/** Tabs the user closed since the last poll. The page has already removed them. */
	closed: ClosedTab[];
	/** Set when the user asked to close the panel, naming how. */
	close: CloseSource | null;
	/** True once after the active tab switched to View, or showed it with nothing rendered: the plugin should render. */
	viewRequested: boolean;
	/** The tab showing, and its mode. */
	active: string | null;
	mode: Mode;
	/** Measurements of the last View load, reported once. */
	viewDiagnostics: Record<string, unknown> | null;
}

/** One floating note. */
interface Tab {
	id: string;
	/** The editor state while the tab is in the background. While it shows, the view holds the live one. */
	state: EditorState;
	mode: Mode;
	/** Edits since the last poll. */
	unpolled: boolean;
	/** Where the editor was scrolled when the tab was last left. */
	scroll: ReturnType<EditorView['scrollSnapshot']> | null;
	/** The last View rendering, and how far down it was read. */
	srcdoc: string | null;
	viewScroll: number;
}

/** Marks a change that came from the vault, so it is not reported back as an edit. */
const external = Annotation.define<boolean>();

const tabs = new Map<string, Tab>();
let active: Tab | null = null;
let closed: ClosedTab[] = [];
let closeRequested: CloseSource | null = null;
let viewRequested = false;
let viewDiagnostics: Record<string, unknown> | null = null;

function requestClose(source: CloseSource): void {
	closeRequested = source;
}

/** Styled source: markup stays visible, as in Obsidian's Source mode. Colours and sizes come from Obsidian's theme. */
const headingTags = [t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6];
const highlight = HighlightStyle.define([
	...headingTags.map((tag, i) => ({
		tag,
		fontSize: `var(--fn-h${i + 1}-size)`,
		color: `var(--fn-h${i + 1}-colour)`,
		fontWeight: '700',
	})),
	{ tag: t.strong, fontWeight: '700', color: 'var(--fn-bold)' },
	{ tag: t.emphasis, fontStyle: 'italic', color: 'var(--fn-italic)' },
	{ tag: t.strikethrough, textDecoration: 'line-through' },
	{ tag: t.monospace, fontFamily: 'var(--fn-monospace)', backgroundColor: 'var(--fn-code-background)', borderRadius: '3px' },
	{ tag: [t.link, t.url], color: 'var(--fn-link)' },
	{ tag: [t.processingInstruction, t.contentSeparator, t.labelName, t.atom, t.meta], color: 'var(--fn-muted)' },
	{ tag: t.quote, color: 'var(--fn-quote)', fontStyle: 'var(--fn-quote-style)' },
	// Frontmatter keys, from the YAML parser.
	{ tag: t.definition(t.propertyName), color: 'var(--fn-yaml-key)' },
]);

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

const frontmatter = StateField.define<DecorationSet>({
	create: frontmatterDecorations,
	update: (value, tr) => (tr.docChanged ? frontmatterDecorations(tr.state) : value),
	provide: (field) => EditorView.decorations.from(field),
});

const theme = EditorView.theme({
	'&': { height: '100%', backgroundColor: 'var(--fn-background)', color: 'var(--fn-text)', fontSize: 'var(--fn-size)' },
	'&.cm-focused': { outline: 'none' },
	'.cm-scroller': { fontFamily: 'var(--fn-font)', lineHeight: '1.5', padding: '8px 0' },
	'.cm-content': { padding: '0 14px', caretColor: 'var(--fn-text)' },
	'.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fn-text)' },
	'.fn-frontmatter': { fontFamily: 'var(--fn-monospace)', fontSize: '0.85em' },
	'&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
		backgroundColor: 'var(--fn-selection)',
	},
});

function createState(text: string): EditorState {
	return EditorState.create({
		doc: text,
		extensions: [
			history(),
			drawSelection(),
			EditorView.lineWrapping,
			// GFM base, for strikethrough, task lists and tables. markdown() adds
			// its own keymap, which continues lists on Enter. Wrapped so a YAML
			// frontmatter block is parsed as YAML: plain Markdown reads its closing
			// `---` as a setext underline and turns the block into a heading.
			yamlFrontmatter({ content: markdown({ base: markdownLanguage }) }),
			frontmatter,
			syntaxHighlighting(highlight),
			theme,
			// Esc, Cmd+W, Cmd+E and tab switching are onKey's, in Edit and View alike.
			keymap.of([
				...historyKeymap,
				...defaultKeymap,
				indentWithTab,
			]),
			EditorView.updateListener.of((update) => {
				if (active && update.docChanged && !update.transactions.some((tr) => tr.annotation(external))) active.unpolled = true;
			}),
		],
	});
}

const view = new EditorView({ state: createState(''), parent: document.getElementById('fn-editor') ?? document.body });

function applyTheme(theme: Theme): void {
	const root = document.documentElement.style;
	const vars: Record<string, string> = {
		'--fn-background': theme.background,
		'--fn-text': theme.text,
		'--fn-muted': theme.muted,
		'--fn-accent': theme.accent,
		'--fn-link': theme.link,
		'--fn-bold': theme.bold,
		'--fn-italic': theme.italic,
		'--fn-quote': theme.quote,
		'--fn-quote-style': theme.quoteStyle,
		'--fn-yaml-key': theme.yamlKey,
		'--fn-border': theme.border,
		'--fn-selection': theme.selection,
		'--fn-code-background': theme.codeBackground,
		'--fn-font': theme.font,
		'--fn-monospace': theme.monospace,
		'--fn-size': theme.size,
	};
	theme.headingColours.forEach((colour, i) => (vars[`--fn-h${i + 1}-colour`] = colour));
	theme.headingSizes.forEach((size, i) => (vars[`--fn-h${i + 1}-size`] = size));
	for (const [name, value] of Object.entries(vars)) root.setProperty(name, value);
}

document.getElementById('fn-mode')?.addEventListener('click', () => toggleMode());

const bar = new TabBar(document.getElementById('fn-tabs') ?? document.body, {
	select: (id) => {
		const tab = tabs.get(id);
		if (tab) activate(tab);
	},
	close: (id) => closeTab(id, 'button'),
});

/**
 * View is Obsidian's own rendering, made by the plugin in the main window and
 * shown here in an iframe. An iframe because the view carries Obsidian's whole
 * stylesheet, which also styles `.cm-editor` - the same classes this page's
 * editor uses - so it must not share a document with it.
 */
const frame = document.getElementById('fn-view') as HTMLIFrameElement | null;
const editorEl = document.getElementById('fn-editor');

/** Which tab's rendering the frame holds. */
let frameTab: Tab | null = null;

function textOf(tab: Tab): string {
	return (tab === active ? view.state : tab.state).doc.toString();
}

/** Show a tab: its own editor state - undo history, cursor and scroll - and its own mode. */
function activate(tab: Tab): void {
	if (tab !== active) {
		if (active) {
			active.state = view.state;
			active.scroll = view.scrollSnapshot();
			if (active.mode === 'view' && frameTab === active) active.viewScroll = frame?.contentWindow?.scrollY ?? 0;
		}
		active = tab;
		view.setState(tab.state);
		if (tab.scroll) view.dispatch({ effects: tab.scroll });
		bar.setActive(tab.id);
	}
	showMode();
}

/** Move to the next tab along, or back with a negative step, wrapping round. */
function cycle(step: number): void {
	const order = bar.order();
	if (!active || order.length < 2) return;
	const i = order.indexOf(active.id);
	const next = tabs.get(order[(i + step + order.length) % order.length] ?? '');
	if (next) activate(next);
}

/** Close a tab. The last one closes the panel instead, through the plugin, so it saves first. */
function closeTab(id: string, source: CloseSource): void {
	const tab = tabs.get(id);
	if (!tab) return;
	if (tabs.size === 1) {
		requestClose(source);
		return;
	}
	closed.push({ id, text: tab.unpolled ? textOf(tab) : null });
	removeTab(tab);
}

/** Take a tab out. If it was showing, its right-hand neighbour shows, or else its left. */
function removeTab(tab: Tab): void {
	const order = bar.order();
	const i = order.indexOf(tab.id);
	tabs.delete(tab.id);
	bar.remove(tab.id);
	if (frameTab === tab) frameTab = null;
	if (tab !== active) {
		showMode();
		return;
	}
	active = null;
	const next = tabs.get(order[i + 1] ?? order[i - 1] ?? '');
	if (next) activate(next);
}

/** Put the active tab's mode on screen, and focus it. */
function showMode(): void {
	const mode = active?.mode ?? 'edit';
	const button = document.getElementById('fn-mode');
	if (button) {
		button.textContent = mode === 'edit' ? 'View' : 'Edit';
		button.title = mode === 'edit' ? 'Show as Obsidian renders it (Cmd+E)' : 'Back to editing (Cmd+E)';
	}
	if (editorEl) editorEl.style.display = mode === 'edit' ? '' : 'none';
	if (frame) frame.style.display = mode === 'view' ? '' : 'none';
	if (mode === 'edit') {
		view.focus();
		return;
	}
	if (active && frame && frameTab !== active) {
		// The frame holds another tab's rendering: put this tab's last one in, and ask for one if it has none.
		frameTab = active;
		frame.dataset.scroll = String(active.viewScroll);
		frame.srcdoc = active.srcdoc ?? '';
		if (active.srcdoc === null) viewRequested = true;
	}
	frame?.focus();
}

function toggleMode(): void {
	if (!active) return;
	active.mode = active.mode === 'edit' ? 'view' : 'edit';
	if (active.mode === 'view') viewRequested = true;
	showMode();
}

/**
 * The panel's own keys, in Edit and View alike, taken before the editor sees
 * them. Cmd only: Ctrl+E and the like are the editor's, and the panel is
 * macOS only.
 */
function onKey(event: KeyboardEvent): void {
	if (event.isComposing) return;
	const key = event.key.toLowerCase();
	const cmd = event.metaKey && !event.ctrlKey && !event.altKey;
	if (event.key === 'Escape') requestClose('escape');
	// Electron's menu may claim Cmd+W before the page sees it.
	else if (cmd && !event.shiftKey && key === 'w') closeTab(active?.id ?? '', 'mod-w');
	// Obsidian's own shortcut for switching between editing and reading.
	else if (cmd && !event.shiftKey && key === 'e') toggleMode();
	else if (cmd && event.shiftKey && (event.code === 'BracketLeft' || event.code === 'BracketRight')) cycle(event.code === 'BracketLeft' ? -1 : 1);
	else if (event.ctrlKey && !event.metaKey && event.key === 'Tab') cycle(event.shiftKey ? -1 : 1);
	else return;
	event.preventDefault();
	event.stopPropagation();
}
document.addEventListener('keydown', onKey, true);

/** The view is read-only: links do not navigate and checkboxes do not toggle. */
function wireFrame(): void {
	const doc = frame?.contentDocument;
	if (!doc) return;
	doc.addEventListener('keydown', onKey, true);
	doc.addEventListener(
		'click',
		(event) => {
			const target = event.target as Element | null;
			if (target?.closest('a, input')) event.preventDefault();
		},
		true,
	);
}
frame?.addEventListener('load', () => {
	wireFrame();
	const y = Number(frame.dataset.scroll ?? 0);
	frame.contentWindow?.scrollTo(0, y);
	viewDiagnostics = diagnose();
});

/** What the frame actually shows, for the debug log - the frame cannot be seen from the plugin. */
function diagnose(): Record<string, unknown> {
	const doc = frame?.contentDocument;
	if (!frame || !doc) return { frame: frame ? 'no document' : 'missing' };
	const win = frame.contentWindow;
	const preview = doc.querySelector('.markdown-preview-view');
	const first = doc.querySelector('.markdown-preview-sizer > *');
	const style = (el: Element | null) => {
		if (!el || !win) return null;
		const c = win.getComputedStyle(el);
		const r = el.getBoundingClientRect();
		return { display: c.display, visibility: c.visibility, opacity: c.opacity, color: c.color, background: c.backgroundColor, position: c.position, top: Math.round(r.top), height: Math.round(r.height), width: Math.round(r.width) };
	};
	return {
		frameSize: [frame.clientWidth, frame.clientHeight],
		frameDisplay: getComputedStyle(frame).display,
		srcdocLength: frame.srcdoc.length,
		textLength: doc.body?.innerText.length ?? null,
		scrollHeight: doc.documentElement.scrollHeight,
		html: style(doc.documentElement),
		body: style(doc.body),
		preview: style(preview),
		firstChild: first ? { tag: first.tagName, cls: first.className, ...style(first) } : null,
		images: Array.from(doc.images, (img) => ({ src: img.src.slice(0, 40), complete: img.complete, naturalWidth: img.naturalWidth })),
	};
}

const api = {
	/** A note in a new tab at the end, shown at once. Its own state, so undo history stays with its note. */
	open(args: OpenArgs): void {
		applyTheme(args.theme);
		closeRequested = null;
		const tab: Tab = { id: args.id, state: createState(args.text), mode: 'edit', unpolled: false, scroll: null, srcdoc: null, viewScroll: 0 };
		tabs.set(tab.id, tab);
		bar.add(tab.id, args.name);
		activate(tab);
	},

	/** Show a tab already open. */
	activate(id: string): void {
		const tab = tabs.get(id);
		if (!tab) return;
		closeRequested = null;
		activate(tab);
	},

	/** Take a tab out without reporting it: its note is gone. */
	remove(id: string): void {
		const tab = tabs.get(id);
		if (tab) removeTab(tab);
	},

	/** Edits since the last poll, closed tabs, whether the user asked to close, and whether View wants rendering. */
	poll(): PollResult {
		const texts: TabText[] = [];
		for (const tab of tabs.values()) {
			if (!tab.unpolled) continue;
			texts.push({ id: tab.id, text: textOf(tab) });
			tab.unpolled = false;
		}
		const result: PollResult = {
			texts,
			closed,
			close: closeRequested,
			viewRequested,
			active: active?.id ?? null,
			mode: active?.mode ?? 'edit',
			viewDiagnostics,
		};
		closed = [];
		viewRequested = false;
		viewDiagnostics = null;
		return result;
	},

	/** Keep a tab's rendering, and show it if the tab is in View, keeping the reader's scroll position across re-renders. */
	showView(id: string, srcdoc: string): void {
		const tab = tabs.get(id);
		if (!tab) return;
		tab.srcdoc = srcdoc;
		if (!frame || tab !== active || tab.mode !== 'view') return;
		frame.dataset.scroll = String(frameTab === tab ? (frame.contentWindow?.scrollY ?? 0) : tab.viewScroll);
		frameTab = tab;
		frame.srcdoc = srcdoc;
	},

	/**
	 * Take a change made outside the panel, unless the tab has edits the
	 * plugin has not seen yet - then the panel wins and the next save
	 * overwrites it. Only the changed span is replaced, so the cursor stays put.
	 */
	replace(id: string, text: string): boolean {
		const tab = tabs.get(id);
		if (!tab || tab.unpolled) return false;
		const current = textOf(tab);
		if (current === text) return true;
		let start = 0;
		const max = Math.min(current.length, text.length);
		while (start < max && current.charCodeAt(start) === text.charCodeAt(start)) start++;
		let endCurrent = current.length;
		let endText = text.length;
		while (endCurrent > start && endText > start && current.charCodeAt(endCurrent - 1) === text.charCodeAt(endText - 1)) {
			endCurrent--;
			endText--;
		}
		const spec = {
			changes: { from: start, to: endCurrent, insert: text.slice(start, endText) },
			annotations: external.of(true),
		};
		if (tab === active) {
			view.dispatch(spec);
		} else {
			// Rendered later, when the tab next shows.
			tab.state = tab.state.update(spec).state;
			tab.srcdoc = null;
			if (frameTab === tab) frameTab = null;
		}
		return true;
	},

	setName(id: string, name: string): void {
		bar.rename(id, name);
	},

	/** The palette's "Toggle float view", for when the panel does not have focus. */
	toggleMode,
};

(window as unknown as { floatNote: typeof api }).floatNote = api;
