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
import { Annotation, Compartment, EditorState, Extension } from '@codemirror/state';
import { EditorView, drawSelection, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting } from '@codemirror/language';
import { frontmatter } from './frontmatter';
import { livePreview } from './live-preview';
import { markdownSyntax } from './syntax';
import { Theme, applyTheme, editorTheme, highlight } from './theme';

export type { Theme } from './theme';

/** How the note is edited: Obsidian's Source mode or Live Preview. */
export type EditingMode = 'source' | 'live';
export type Mode = EditingMode | 'view';

export interface LoadArgs {
	name: string;
	text: string;
	theme: Theme;
	/** Obsidian's default editing mode, which the panel follows. */
	editingMode: EditingMode;
}

export type CloseSource = 'escape' | 'button' | 'mod-w';

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

/** Holds livePreview in Live Preview and nothing in Source. */
const preview = new Compartment();
const sourceMode: Extension = [];

let unpolled = false;
let closeRequested: CloseSource | null = null;
let mode: Mode = 'live';
/** The editing mode View returns to. */
let editingMode: EditingMode = 'live';
let viewRequested = false;
let viewDiagnostics: Record<string, unknown> | null = null;

function requestClose(source: CloseSource): boolean {
	closeRequested = source;
	return true;
}

function createState(text: string, editing: EditingMode): EditorState {
	return EditorState.create({
		doc: text,
		extensions: [
			history(),
			drawSelection(),
			EditorView.lineWrapping,
			markdownSyntax(),
			frontmatter,
			syntaxHighlighting(highlight),
			editorTheme,
			preview.of(editing === 'live' ? livePreview : sourceMode),
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

const view = new EditorView({ state: createState('', editingMode), parent: document.getElementById('fn-editor') ?? document.body });

function setName(name: string): void {
	const el = document.getElementById('fn-name');
	if (el) el.textContent = name;
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
	if (next !== 'view') setEditingMode(next);
	const button = document.getElementById('fn-mode');
	if (button) {
		button.textContent = next === 'view' ? 'Edit' : 'View';
		button.title = next === 'view' ? 'Back to editing (Cmd+E)' : 'Show as Obsidian renders it (Cmd+E)';
	}
	if (editorEl) editorEl.style.display = next === 'view' ? 'none' : '';
	if (frame) frame.style.display = next === 'view' ? '' : 'none';
	if (next !== 'view') view.focus();
}

function setEditingMode(next: EditingMode): void {
	editingMode = next;
	const wanted = next === 'live' ? livePreview : sourceMode;
	if (preview.get(view.state) !== wanted) view.dispatch({ effects: preview.reconfigure(wanted) });
}

/** Cmd+E: between editing, in whichever mode it was last in, and View. */
function toggleMode(): boolean {
	if (mode === 'view') {
		setMode(editingMode);
	} else {
		setMode('view');
		viewRequested = true;
		frame?.focus();
	}
	return true;
}

/** Between Live Preview and Source, as Obsidian's command of that name. From View, back to editing. */
function toggleSource(): boolean {
	setMode(editingMode === 'live' ? 'source' : 'live');
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
		view.setState(createState(args.text, args.editingMode));
		unpolled = false;
		closeRequested = null;
		viewRequested = false;
		setMode(args.editingMode);
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

	/** The palette's "Toggle float source mode". */
	toggleSource,
};

(window as unknown as { floatNote: typeof api }).floatNote = api;
