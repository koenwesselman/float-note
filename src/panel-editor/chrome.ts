import type { Mode } from './index';
import type { StripStyle } from './theme';

/**
 * The page around the editor: the top strip with its tabs and View/Edit
 * button, the editor and View's frame. Styled from Obsidian's tab bar,
 * measured by the plugin; the values in `:root` show only until the first
 * theme arrives.
 */
const CSS = `
:root { --fn-background: #1e1e1e; --fn-text: #dcddde; --fn-muted: #999; --fn-border: #333; --fn-font: system-ui, sans-serif; --fn-size: 16px;
	--fn-strip-background: #262626; --fn-strip-border: #333; --fn-strip-text: #999; --fn-strip-active-background: #1e1e1e; --fn-strip-active-text: #dcddde;
	--fn-strip-hover: rgba(127, 127, 127, 0.15); --fn-strip-radius: 4px; --fn-strip-font: system-ui, sans-serif; --fn-strip-font-size: 12px; --fn-strip-icon: #999;
	--fn-scrollbar-thumb: rgba(127, 127, 127, 0.3); --fn-scrollbar-active-thumb: rgba(127, 127, 127, 0.5); }
html, body { margin: 0; height: 100%; overflow: hidden; background: var(--fn-background); color: var(--fn-text); }
body { display: flex; flex-direction: column; font-family: var(--fn-font); }
.bar { -webkit-app-region: drag; flex: none; height: 26px; display: flex; align-items: center; gap: 4px; padding: 0 3px; font-family: var(--fn-strip-font); font-size: var(--fn-strip-font-size); color: var(--fn-strip-text); background: var(--fn-strip-background); border-bottom: 1px solid var(--fn-strip-border); user-select: none; }
#fn-tabs { flex: 0 1 auto; min-width: 0; display: flex; gap: 2px; overflow-x: auto; scrollbar-width: none; }
/* Always some strip left to drag the window by, however many tabs. */
.fn-drag { flex: 1 0 16px; align-self: stretch; }
.fn-tab { -webkit-app-region: no-drag; flex: 0 1 140px; min-width: 64px; height: 20px; box-sizing: border-box; display: flex; align-items: center; gap: 2px; padding: 0 2px 0 8px; border-radius: var(--fn-strip-radius); cursor: default; }
.fn-tab:hover { background: var(--fn-strip-hover); color: var(--fn-strip-active-text); }
.fn-tab.is-active, .fn-tab.is-dragging { background: var(--fn-strip-active-background); color: var(--fn-strip-active-text); }
.fn-tab.is-dragging { position: relative; z-index: 1; opacity: 0.85; transform: translateX(var(--fn-shift, 0)); }
.fn-tab-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* .bar first: Obsidian's own button rules, in its stylesheet on this page too, outrank a lone class. */
.bar .fn-tab-close, .bar #fn-mode { -webkit-app-region: no-drag; flex: none; display: flex; align-items: center; justify-content: center; border: 0; background: transparent; box-shadow: none; color: var(--fn-strip-icon); font: inherit; line-height: 1; padding: 0; cursor: pointer; }
.bar .fn-tab-close { font-size: 14px; width: 16px; height: 16px; border-radius: 3px; }
.bar #fn-mode { min-width: 22px; height: 20px; padding: 0 3px; border-radius: var(--fn-strip-radius); }
.bar .fn-tab-close:hover, .bar #fn-mode:hover { background: var(--fn-strip-hover); color: var(--fn-strip-active-text); }
.fn-tab-close svg { width: 12px; height: 12px; }
#fn-mode svg { width: 14px; height: 14px; }
#fn-editor { flex: 1; min-height: 0; }
#fn-view { flex: 1; min-height: 0; border: 0; width: 100%; background: var(--fn-background); }
/* Hidden copies of Obsidian's markup, measured and removed. */
.fn-probe { position: absolute; left: -10000px; top: 0; visibility: hidden; pointer-events: none; }
/* Scrollbars as Obsidian draws them. */
.cm-scroller::-webkit-scrollbar { width: 12px; height: 12px; background: transparent; }
.cm-scroller::-webkit-scrollbar-thumb { background-color: var(--fn-scrollbar-thumb); background-clip: padding-box; border: 3px solid transparent; border-radius: 20px; }
.cm-scroller::-webkit-scrollbar-thumb:active { background-color: var(--fn-scrollbar-active-thumb); }
`;

const sheet = new CSSStyleSheet();
sheet.replaceSync(CSS);
// Added to, not replaced, so sheets adopted elsewhere stay.
document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

let icons: StripStyle['icons'] = { close: '', reading: '', editing: '' };

/** Obsidian's icon as an element, or null when the theme sent none. */
function iconElement(svg: string): Element | null {
	if (!svg) return null;
	const el = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
	return el.nodeName === 'svg' ? el : null;
}

/** Put an icon in a button, or the given text when there is no icon. */
function fill(button: Element, svg: string, text: string): void {
	const el = iconElement(svg);
	if (el) button.replaceChildren(el);
	else button.textContent = text;
}

/** A tab's close button, drawn with Obsidian's × once the theme has arrived. */
export function drawClose(button: Element): void {
	fill(button, icons.close, '×');
}

/** The View/Edit button for the mode showing: Obsidian's reading and editing icons, as on its own view header. */
export function drawModeButton(mode: Mode): void {
	const button = document.getElementById('fn-mode');
	if (!button) return;
	const editing = mode !== 'view';
	fill(button, editing ? icons.reading : icons.editing, editing ? 'View' : 'Edit');
	button.title = editing ? 'Show as Obsidian renders it (Cmd+E)' : 'Back to editing (Cmd+E)';
	button.setAttribute('aria-label', editing ? 'Show as Obsidian renders it' : 'Back to editing');
}

/** New icons from the theme: redraw every button that shows one. */
export function setIcons(next: StripStyle['icons'], mode: Mode): void {
	if (next.close === icons.close && next.reading === icons.reading && next.editing === icons.editing) return;
	icons = next;
	for (const button of Array.from(document.querySelectorAll('.fn-tab-close'))) drawClose(button);
	drawModeButton(mode);
}
