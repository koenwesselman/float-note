import { getIcon } from 'obsidian';
import type { CalloutStyle, StripStyle, Theme, TokenStyle } from './panel-editor';

/**
 * Obsidian's current theme, read from the main window: when a panel or tab
 * opens, and again whenever Obsidian reports a CSS change.
 *
 * Token colours are measured rather than read from variables: themes style
 * CodeMirror's own classes directly (Things sets `span.cm-strong` to its own
 * `--strong-color` and never touches Obsidian's `--bold-color`), so the only
 * theme-agnostic answer is what the theme actually renders. Hidden copies of
 * Obsidian's editor and tab markup are put in the main window, measured, and
 * removed.
 */
export function readTheme(): Theme {
	const style = getComputedStyle(document.body);
	const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
	const source = measureTokens(SOURCE_VIEW);
	return {
		background: v('--background-primary', '#1e1e1e'),
		text: v('--text-normal', '#dcddde'),
		muted: v('--text-muted', '#999999'),
		accent: v('--text-accent', '#8a5cf5'),
		source: tokenStyle(source, v),
		livePreview: tokenStyle(measureTokens(`${SOURCE_VIEW} is-live-preview`), v),
		yamlKey: source.frontmatterKey?.color ?? v('--text-muted', '#999999'),
		border: v('--background-modifier-border', '#333333'),
		selection: v('--text-selection', 'rgba(138, 92, 245, 0.25)'),
		caret: source.content?.caretColor ?? v('--caret-color', v('--text-normal', '#dcddde')),
		codeBackground: v('--code-background', 'rgba(127, 127, 127, 0.15)'),
		monospace: v('--font-monospace', 'ui-monospace, Menlo, monospace'),
		highlight: v('--text-highlight-bg', 'rgba(255, 208, 0, 0.4)'),
		tagColour: v('--tag-color', v('--text-accent', '#8a5cf5')),
		tagBackground: v('--tag-background', 'rgba(138, 92, 245, 0.1)'),
		unresolvedColour: v('--link-unresolved-color', v('--text-accent', '#8a5cf5')),
		unresolvedOpacity: v('--link-unresolved-opacity', '0.7'),
		doneColour: v('--checklist-done-color', v('--text-muted', '#999999')),
		doneDecoration: v('--checklist-done-decoration', 'line-through'),
		quoteBorder: v('--blockquote-border-color', v('--interactive-accent', '#8a5cf5')),
		quoteBorderWidth: v('--blockquote-border-thickness', '2px'),
		rule: v('--hr-color', v('--background-modifier-border', '#333333')),
		tableBorder: v('--table-border-color', v('--background-modifier-border', '#333333')),
		scrollbarThumb: v('--scrollbar-thumb-bg', 'rgba(127, 127, 127, 0.3)'),
		scrollbarActiveThumb: v('--scrollbar-active-thumb-bg', 'rgba(127, 127, 127, 0.5)'),
		callouts: measureCallouts(),
		strip: measureStrip(v),
	};
}

type Vars = (name: string, fallback: string) => string;

const SOURCE_VIEW = 'markdown-source-view mod-cm6 cm-s-obsidian';
const DEFAULT_HEADING_SIZES = ['1.6em', '1.4em', '1.2em', '1.1em', '1em', '1em'];

/** Text and token styles from one measurement, with Obsidian's variables where a probe found nothing. */
function tokenStyle(probe: Record<string, Measured | undefined>, v: Vars): TokenStyle {
	const headings = [1, 2, 3, 4, 5, 6].map((n) => probe[`h${n}`]);
	return {
		font: probe.text?.fontFamily || v('--font-text', 'system-ui, sans-serif'),
		size: probe.text?.fontSize || v('--font-text-size', '16px'),
		link: probe.link?.color ?? v('--link-color', v('--text-accent', '#8a5cf5')),
		bold: probe.strong?.color ?? 'inherit',
		italic: probe.em?.color ?? 'inherit',
		quote: probe.quote?.color ?? v('--text-muted', '#999999'),
		quoteStyle: probe.quote?.fontStyle ?? 'normal',
		headingColours: headings.map((h) => h?.color ?? 'inherit'),
		headingSizes: headings.map((h, i) => h?.fontSize ?? DEFAULT_HEADING_SIZES[i] ?? '1em'),
		headingFonts: headings.map((h) => h?.fontFamily ?? 'inherit'),
	};
}

interface Measured {
	color: string;
	fontStyle: string;
	fontSize: string;
	fontFamily: string;
	caretColor: string;
}

/** Line and token classes as Obsidian's CodeMirror 6 editor emits them. `text` is a plain line; `content` the editor content itself. */
const PROBES: Record<string, { line?: string; token: string }> = {
	text: { token: '' },
	strong: { token: 'cm-strong' },
	em: { token: 'cm-em' },
	link: { token: 'cm-link' },
	quote: { line: 'HyperMD-quote HyperMD-quote-1', token: 'cm-quote cm-quote-1' },
	frontmatterKey: { line: 'cm-hmd-frontmatter', token: 'cm-hmd-frontmatter cm-atom' },
	...Object.fromEntries(
		[1, 2, 3, 4, 5, 6].map((n) => [`h${n}`, { line: `HyperMD-header HyperMD-header-${n}`, token: `cm-header cm-header-${n}` }]),
	),
};

function measured(el: Element): Measured {
	const c = getComputedStyle(el);
	return { color: c.color, fontStyle: c.fontStyle, fontSize: c.fontSize, fontFamily: c.fontFamily, caretColor: c.caretColor };
}

/** The probes, measured inside an editor with the given classes - Source's, or Live Preview's. */
function measureTokens(view: string): Record<string, Measured | undefined> {
	const results: Record<string, Measured | undefined> = {};
	const host = document.body.createDiv({ cls: view });
	host.setCssStyles({ position: 'absolute', left: '-10000px', top: '0', visibility: 'hidden', pointerEvents: 'none' });
	try {
		const content = host.createDiv({ cls: 'cm-editor' }).createDiv({ cls: 'cm-scroller' }).createDiv({ cls: 'cm-content' });
		const spans: Record<string, HTMLElement> = {};
		for (const [name, probe] of Object.entries(PROBES)) {
			const line = content.createDiv({ cls: `cm-line ${probe.line ?? ''}`.trim() });
			spans[name] = probe.token ? line.createSpan({ cls: probe.token, text: 'x' }) : line.createSpan({ text: 'x' });
		}
		for (const [name, span] of Object.entries(spans)) results[name] = measured(span);
		results.content = measured(content);
	} catch (e) {
		console.error('Float Note: could not measure the theme', e);
	} finally {
		host.remove();
	}
	return results;
}

function isTransparent(colour: string): boolean {
	return colour === '' || colour === 'transparent' || /^rgba\(.*,\s*0\)$/.test(colour);
}

/** SVG markup for one of Obsidian's icons, or '' when it has none by that name. */
function icon(...names: string[]): string {
	for (const name of names) {
		const svg = getIcon(name);
		if (svg) return svg.outerHTML;
	}
	return '';
}

/**
 * The panel's top strip styled as Obsidian's tab bar: measured on a hidden
 * copy of Obsidian's tab header markup, for the same reason as the editor's
 * tokens - themes style these classes directly.
 */
function measureStrip(v: Vars): StripStyle {
	const fallback: StripStyle = {
		background: v('--tab-container-background', v('--background-secondary', '#262626')),
		border: v('--tab-outline-color', v('--background-modifier-border', '#333333')),
		text: v('--tab-text-color', v('--text-muted', '#999999')),
		activeBackground: v('--tab-background-active', v('--background-primary', '#1e1e1e')),
		activeText: v('--tab-text-color-focused-active', v('--text-normal', '#dcddde')),
		hover: v('--background-modifier-hover', 'rgba(127, 127, 127, 0.15)'),
		radius: v('--tab-radius', '4px'),
		font: v('--font-interface', 'system-ui, sans-serif'),
		fontSize: v('--font-ui-smaller', '12px'),
		icon: v('--icon-color', v('--text-muted', '#999999')),
		icons: { close: icon('x', 'lucide-x'), reading: icon('book-open', 'lucide-book-open'), editing: icon('pencil', 'edit-3', 'lucide-edit-3') },
	};
	const host = document.body.createDiv({ cls: 'workspace' });
	host.setCssStyles({ position: 'absolute', left: '-10000px', top: '0', width: '600px', visibility: 'hidden', pointerEvents: 'none' });
	try {
		const tabs = host.createDiv({ cls: 'workspace-split mod-vertical mod-root' }).createDiv({ cls: 'workspace-tabs mod-top mod-active' });
		const container = tabs.createDiv({ cls: 'workspace-tab-header-container' });
		const inner = container.createDiv({ cls: 'workspace-tab-header-container-inner' });
		const tab = (active: boolean) => {
			const header = inner.createDiv({ cls: active ? 'workspace-tab-header tappable is-active mod-active' : 'workspace-tab-header tappable' });
			const body = header.createDiv({ cls: 'workspace-tab-header-inner' });
			const title = body.createDiv({ cls: 'workspace-tab-header-inner-title', text: 'x' });
			const close = body.createDiv({ cls: 'workspace-tab-header-inner-close-button' });
			return { header, body, title, close };
		};
		const active = tab(true);
		const idle = tab(false);
		const css = (el: Element) => getComputedStyle(el);
		const solid = (...colours: string[]) => colours.find((c) => !isTransparent(c));
		const box = css(container);
		return {
			...fallback,
			background: solid(box.backgroundColor) ?? fallback.background,
			border: box.borderBottomWidth !== '0px' && !isTransparent(box.borderBottomColor) ? box.borderBottomColor : fallback.border,
			text: css(idle.title).color || fallback.text,
			activeBackground: solid(css(active.header).backgroundColor, css(active.body).backgroundColor) ?? fallback.activeBackground,
			activeText: css(active.title).color || fallback.activeText,
			radius: css(active.header).borderTopLeftRadius || fallback.radius,
			font: css(active.title).fontFamily || fallback.font,
			fontSize: css(active.title).fontSize || fallback.fontSize,
			icon: css(idle.close).color || fallback.icon,
		};
	} catch (e) {
		console.error('Float Note: could not measure the tab bar', e);
		return fallback;
	} finally {
		host.remove();
	}
}

/** Obsidian's callout types and their aliases. */
const CALLOUT_TYPES = [
	'note', 'abstract', 'summary', 'tldr', 'info', 'todo', 'tip', 'hint', 'important', 'success', 'check', 'done',
	'question', 'help', 'faq', 'warning', 'caution', 'attention', 'failure', 'fail', 'missing', 'danger', 'error',
	'bug', 'example', 'quote', 'cite',
];

/**
 * Each callout type's colour and icon, as the theme sets them: Obsidian's
 * stylesheet gives `.callout[data-callout=…]` a `--callout-color` and a
 * `--callout-icon`, measured here on hidden callouts. `default` is what a
 * type the theme does not know gets.
 */
function measureCallouts(): Record<string, CalloutStyle> {
	const results: Record<string, CalloutStyle> = {};
	const host = document.body.createDiv({ cls: 'markdown-rendered' });
	host.setCssStyles({ position: 'absolute', left: '-10000px', top: '0', visibility: 'hidden', pointerEvents: 'none' });
	try {
		for (const type of [...CALLOUT_TYPES, 'default']) {
			const callout = host.createDiv({ cls: 'callout', attr: { 'data-callout': type === 'default' ? 'float-note-unknown' : type } });
			const computed = getComputedStyle(callout);
			const icon = computed.getPropertyValue('--callout-icon').trim();
			results[type] = {
				colour: computed.getPropertyValue('--callout-color').trim() || '8, 109, 221',
				icon: (icon && getIcon(icon.replace(/^lucide-/, ''))?.outerHTML) || (icon && getIcon(icon)?.outerHTML) || '',
			};
		}
	} catch (e) {
		console.error('Float Note: could not measure callouts', e);
	} finally {
		host.remove();
	}
	return results;
}
