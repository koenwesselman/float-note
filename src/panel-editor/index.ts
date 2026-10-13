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

export interface LoadArgs {
	name: string;
	text: string;
	theme: Theme;
}

export type CloseSource = 'escape' | 'button' | 'mod-w';
export type Mode = 'edit' | 'view';

export interface PollResult {
	text: string | null;
	/** Set when the user asked to close, naming how. */
	close: CloseSource | null;
	/** True once after the user switched to View: the plugin should render. */
	viewRequested: boolean;
	mode: Mode;
	/** Measurements of the last View load, reported once. */
	viewDiagnostics: Record<string, unknown> | null;
}

/** Marks a change that came from the vault, so it is not reported back as an edit. */
const external = Annotation.define<boolean>();

let unpolled = false;
let closeRequested: CloseSource | null = null;
let mode: Mode = 'edit';
let viewRequested = false;
let viewDiagnostics: Record<string, unknown> | null = null;

function requestClose(source: CloseSource): boolean {
	closeRequested = source;
	return true;
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
			keymap.of([
				{ key: 'Escape', run: () => requestClose('escape') },
				// Electron's menu may claim Cmd+W before the page sees it.
				{ key: 'Mod-w', run: () => requestClose('mod-w'), preventDefault: true },
				// Obsidian's own shortcut for switching between editing and reading.
				{ key: 'Mod-e', run: () => toggleMode(), preventDefault: true },
				...historyKeymap,
				...defaultKeymap,
				indentWithTab,
			]),
			EditorView.updateListener.of((update) => {
				if (update.docChanged && !update.transactions.some((tr) => tr.annotation(external))) unpolled = true;
			}),
		],
	});
}

const view = new EditorView({ state: createState(''), parent: document.getElementById('fn-editor') ?? document.body });

function setName(name: string): void {
	const el = document.getElementById('fn-name');
	if (el) el.textContent = name;
}

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

document.getElementById('fn-close')?.addEventListener('click', () => requestClose('button'));
document.getElementById('fn-mode')?.addEventListener('click', () => toggleMode());

/**
 * View is Obsidian's own rendering, made by the plugin in the main window and
 * shown here in an iframe. An iframe because the view carries Obsidian's whole
 * stylesheet, which also styles `.cm-editor` - the same classes this page's
 * editor uses - so it must not share a document with it.
 */
const frame = document.getElementById('fn-view') as HTMLIFrameElement | null;
const editorEl = document.getElementById('fn-editor');

function setMode(next: Mode): void {
	mode = next;
	const button = document.getElementById('fn-mode');
	if (button) {
		button.textContent = next === 'edit' ? 'View' : 'Edit';
		button.title = next === 'edit' ? 'Show as Obsidian renders it (Cmd+E)' : 'Back to editing (Cmd+E)';
	}
	if (editorEl) editorEl.style.display = next === 'edit' ? '' : 'none';
	if (frame) frame.style.display = next === 'view' ? '' : 'none';
	if (next === 'edit') view.focus();
}

function toggleMode(): boolean {
	if (mode === 'edit') {
		setMode('view');
		viewRequested = true;
		frame?.focus();
	} else {
		setMode('edit');
	}
	return true;
}

/** Esc, Cmd+W and Cmd+E when the editor does not have focus - in View, or in the view's frame. */
function onKey(event: KeyboardEvent): void {
	if (mode !== 'view') return;
	const mod = event.metaKey || event.ctrlKey;
	if (event.key === 'Escape') requestClose('escape');
	else if (mod && event.key.toLowerCase() === 'w') requestClose('mod-w');
	else if (mod && event.key.toLowerCase() === 'e') toggleMode();
	else return;
	event.preventDefault();
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
	/** A new note: fresh state, so undo history does not cross notes. */
	load(args: LoadArgs): void {
		applyTheme(args.theme);
		setName(args.name);
		view.setState(createState(args.text));
		unpolled = false;
		closeRequested = null;
		viewRequested = false;
		setMode('edit');
	},

	/** Edits since the last poll, whether the user asked to close, and whether View wants rendering. */
	poll(): PollResult {
		const result: PollResult = {
			text: unpolled ? view.state.doc.toString() : null,
			close: closeRequested,
			viewRequested,
			mode,
			viewDiagnostics,
		};
		unpolled = false;
		viewRequested = false;
		viewDiagnostics = null;
		return result;
	},

	/** Show a rendered document in View, keeping the reader's scroll position across re-renders. */
	showView(srcdoc: string): void {
		if (!frame || mode !== 'view') return;
		frame.dataset.scroll = String(frame.contentWindow?.scrollY ?? 0);
		frame.srcdoc = srcdoc;
	},

	/**
	 * Take a change made outside the panel, unless there are edits here the
	 * plugin has not seen yet - then the panel wins and the next save
	 * overwrites it. Only the changed span is replaced, so the cursor stays put.
	 */
	replace(text: string): boolean {
		if (unpolled) return false;
		const current = view.state.doc.toString();
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
		view.dispatch({
			changes: { from: start, to: endCurrent, insert: text.slice(start, endText) },
			annotations: external.of(true),
		});
		return true;
	},

	setName,

	/** The palette's "Toggle float view", for when the panel does not have focus. */
	toggleMode,
};

(window as unknown as { floatNote: typeof api }).floatNote = api;
