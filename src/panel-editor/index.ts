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
import { setRenderedLanguages } from './live-preview/fences';
import { linkClicks, setUnresolved, takeOpenRequest, unresolvedField } from './live-preview/links';
import type { LinkTarget, OpenRequest } from './live-preview/links';
import { noteId } from './live-preview/note';
import { clearRendered, notifyRendered, setStylesheet, storeRendered, takeRenderRequests } from './live-preview/render';
import type { Rendered, RenderRequest, Stylesheet } from './live-preview/render';
import { reveal, syncFocus } from './live-preview/reveal';
import { frame, watchFrame } from './reading';
import { markdownSyntax } from './syntax';
import { TabBar } from './tabs';
import { Theme, applyTheme, editorTheme, highlight } from './theme';

export type { CalloutStyle, Theme } from './theme';
export type { LinkTarget, OpenRequest, Rendered, RenderRequest, Stylesheet };

/** How a tab is edited: Obsidian's Source mode or Live Preview. */
export type EditingMode = 'source' | 'live';
export type Mode = EditingMode | 'view';

export interface OpenArgs {
	/** The plugin's id for the tab. */
	id: string;
	name: string;
	text: string;
	theme: Theme;
	/** Obsidian's default editing mode, which a new tab follows. */
	editingMode: EditingMode;
	/** Link paths in the note that resolve to nothing. */
	unresolved: string[];
	/** Code block languages Obsidian draws, for Live Preview to show rendered. */
	renderedLanguages: string[];
}

export type CloseSource = 'escape' | 'button' | 'mod-w';

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
	/** Blocks Live Preview wants Obsidian to render. */
	renderRequests: RenderRequest[];
	/** A link the user Cmd+clicked. */
	openLink: OpenRequest | null;
}

/** One floating note. */
interface Tab {
	id: string;
	/** The editor state while the tab is in the background. While it shows, the view holds the live one. */
	state: EditorState;
	mode: Mode;
	/** The editing mode View returns to. */
	editingMode: EditingMode;
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

/** Holds livePreview in Live Preview and nothing in Source. Part of each tab's own state. */
const preview = new Compartment();
const sourceMode: Extension = [];

const tabs = new Map<string, Tab>();
let active: Tab | null = null;
let closed: ClosedTab[] = [];
let closeRequested: CloseSource | null = null;
let viewRequested = false;
let viewDiagnostics: Record<string, unknown> | null = null;

function requestClose(source: CloseSource): void {
	closeRequested = source;
}

function createState(id: string, text: string, editing: EditingMode, unresolved: readonly string[] = []): EditorState {
	return EditorState.create({
		doc: text,
		extensions: [
			noteId.of(id),
			history(),
			drawSelection(),
			EditorView.lineWrapping,
			markdownSyntax(),
			frontmatter,
			syntaxHighlighting(highlight),
			editorTheme,
			reveal,
			unresolvedField.init(() => new Set(unresolved)),
			linkClicks,
			preview.of(editing === 'live' ? livePreview : sourceMode),
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

const view = new EditorView({ state: createState('', '', 'live'), parent: document.getElementById('fn-editor') ?? document.body });

document.getElementById('fn-mode')?.addEventListener('click', () => toggleMode());

const bar = new TabBar(document.getElementById('fn-tabs') ?? document.body, {
	select: (id) => {
		const tab = tabs.get(id);
		if (tab) activate(tab);
	},
	close: (id) => closeTab(id, 'button'),
});

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
		// Renderings that arrived while the tab was in the background.
		notifyRendered(view);
		syncFocus(view);
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
	clearRendered(tab.id);
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
	const mode = active?.mode ?? 'live';
	const button = document.getElementById('fn-mode');
	if (button) {
		button.textContent = mode === 'view' ? 'Edit' : 'View';
		button.title = mode === 'view' ? 'Back to editing (Cmd+E)' : 'Show as Obsidian renders it (Cmd+E)';
	}
	if (editorEl) editorEl.style.display = mode === 'view' ? 'none' : '';
	if (frame) frame.style.display = mode === 'view' ? '' : 'none';
	if (mode !== 'view') {
		setEditingMode(mode);
		view.focus();
		syncFocus(view);
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

/** Put the active tab's editor in Live Preview or Source. */
function setEditingMode(next: EditingMode): void {
	const wanted = next === 'live' ? livePreview : sourceMode;
	if (preview.get(view.state) !== wanted) view.dispatch({ effects: preview.reconfigure(wanted) });
}

/** Cmd+E: between editing, in whichever mode the tab was last in, and View. */
function toggleMode(): void {
	if (!active) return;
	active.mode = active.mode === 'view' ? active.editingMode : 'view';
	if (active.mode === 'view') viewRequested = true;
	showMode();
}

/** Between Live Preview and Source, as Obsidian's command of that name. From View, back to editing. */
function toggleSource(): void {
	if (!active) return;
	active.editingMode = active.editingMode === 'live' ? 'source' : 'live';
	active.mode = active.editingMode;
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

watchFrame(onKey, () => frameTab?.id ?? '', (diagnostics) => (viewDiagnostics = diagnostics));

const api = {
	/** A note in a new tab at the end, shown at once. Its own state, so undo history stays with its note. */
	open(args: OpenArgs): void {
		applyTheme(args.theme);
		setRenderedLanguages(args.renderedLanguages);
		closeRequested = null;
		const state = createState(args.id, args.text, args.editingMode, args.unresolved);
		const tab: Tab = { id: args.id, state, mode: args.editingMode, editingMode: args.editingMode, unpolled: false, scroll: null, srcdoc: null, viewScroll: 0 };
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
			mode: active?.mode ?? 'live',
			viewDiagnostics,
			renderRequests: takeRenderRequests(),
			openLink: takeOpenRequest(),
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

	/** Obsidian's renderings of blocks Live Preview asked for. */
	setRendered(results: Rendered[]): void {
		storeRendered(results);
		notifyRendered(view);
	},

	/** Obsidian's stylesheet, for those renderings. Sent before the first of them. */
	setStylesheet,

	/** Link paths in a tab's note that resolve to nothing, after Obsidian re-indexed it. */
	setUnresolved(id: string, list: string[]): void {
		const tab = tabs.get(id);
		if (!tab) return;
		const spec = { effects: setUnresolved.of(list) };
		if (tab === active) view.dispatch(spec);
		else tab.state = tab.state.update(spec).state;
	},

	setName(id: string, name: string): void {
		bar.rename(id, name);
	},

	/** The palette's "Toggle float view", for when the panel does not have focus. */
	toggleMode,

	/** The palette's "Toggle float source mode". */
	toggleSource,
};

(window as unknown as { floatNote: typeof api }).floatNote = api;
