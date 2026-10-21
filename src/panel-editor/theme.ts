import { HighlightStyle } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { obsidianTags } from './syntax';

export interface CalloutStyle {
	/** An `r, g, b` triple, as Obsidian's `--callout-color` holds it. */
	colour: string;
	/** The callout's icon as SVG markup, or '' for none. */
	icon: string;
}

/** Text and token styles, measured separately for Source and Live Preview: themes can style them differently. */
export interface TokenStyle {
	font: string;
	size: string;
	link: string;
	bold: string;
	italic: string;
	quote: string;
	quoteStyle: string;
	/** h1 to h6, colour, size and font each. */
	headingColours: string[];
	headingSizes: string[];
	headingFonts: string[];
}

/** The top strip, styled as Obsidian's tab bar. */
export interface StripStyle {
	background: string;
	border: string;
	text: string;
	activeBackground: string;
	activeText: string;
	hover: string;
	radius: string;
	font: string;
	fontSize: string;
	icon: string;
	/** Obsidian's icons as SVG markup, or '' where it has none. */
	icons: { close: string; reading: string; editing: string };
}

export interface Theme {
	background: string;
	text: string;
	muted: string;
	accent: string;
	source: TokenStyle;
	livePreview: TokenStyle;
	yamlKey: string;
	border: string;
	selection: string;
	caret: string;
	codeBackground: string;
	monospace: string;
	highlight: string;
	tagColour: string;
	tagBackground: string;
	unresolvedColour: string;
	unresolvedOpacity: string;
	listMarker: string;
	doneColour: string;
	doneDecoration: string;
	quoteBorder: string;
	quoteBorderWidth: string;
	rule: string;
	tableBorder: string;
	scrollbarThumb: string;
	scrollbarActiveThumb: string;
	/** By callout type, plus `default` for types the theme does not know. */
	callouts: Record<string, CalloutStyle>;
	strip: StripStyle;
}

let callouts: Record<string, CalloutStyle> = {};

/** How the current theme draws a callout type. */
export function calloutStyle(type: string): CalloutStyle {
	return callouts[type.toLowerCase()] ?? callouts.default ?? { colour: '8, 109, 221', icon: '' };
}

/** Styled source: markup stays visible, as in Obsidian's Source mode. Colours and sizes come from Obsidian's theme. */
const headingTags = [t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6];
export const highlight = HighlightStyle.define([
	...headingTags.map((tag, i) => ({
		tag,
		fontSize: `var(--fn-h${i + 1}-size)`,
		color: `var(--fn-h${i + 1}-colour)`,
		fontFamily: `var(--fn-h${i + 1}-font)`,
		fontWeight: '700',
	})),
	{ tag: t.strong, fontWeight: '700', color: 'var(--fn-bold)' },
	{ tag: t.emphasis, fontStyle: 'italic', color: 'var(--fn-italic)' },
	{ tag: t.strikethrough, textDecoration: 'line-through' },
	{ tag: t.monospace, fontFamily: 'var(--fn-monospace)', backgroundColor: 'var(--fn-code-background)', borderRadius: '3px' },
	{ tag: [t.link, t.url], color: 'var(--fn-link)' },
	{ tag: [t.processingInstruction, t.contentSeparator, t.labelName, t.atom, t.meta, t.comment], color: 'var(--fn-muted)' },
	{ tag: t.quote, color: 'var(--fn-quote)', fontStyle: 'var(--fn-quote-style)' },
	// Frontmatter keys, from the YAML parser.
	{ tag: t.definition(t.propertyName), color: 'var(--fn-yaml-key)' },
	{ tag: obsidianTags.highlight, backgroundColor: 'var(--fn-highlight)' },
	{ tag: obsidianTags.hashtag, color: 'var(--fn-tag-colour)', backgroundColor: 'var(--fn-tag-background)', borderRadius: '1em', padding: '0 0.35em' },
]);

export const editorTheme = EditorView.theme({
	'&': { height: '100%', backgroundColor: 'var(--fn-background)', color: 'var(--fn-text)', fontSize: 'var(--fn-size)' },
	'&.cm-focused': { outline: 'none' },
	'.cm-scroller': { fontFamily: 'var(--fn-font)', lineHeight: '1.5', padding: '8px 0' },
	'.cm-content': { padding: '0 14px', caretColor: 'var(--fn-caret)' },
	'.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fn-caret)' },
	'.fn-frontmatter': { fontFamily: 'var(--fn-monospace)', fontSize: '0.85em' },
	'&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
		backgroundColor: 'var(--fn-selection)',
	},

	// Live Preview. Only its decorations carry these classes.
	'.fn-link': { color: 'var(--fn-link)', textDecoration: 'underline', textUnderlineOffset: '2px' },
	'.fn-unresolved': { color: 'var(--fn-unresolved-colour)', opacity: 'var(--fn-unresolved-opacity)' },
	'.fn-quote': { borderLeft: 'var(--fn-quote-border-width) solid var(--fn-quote-border)', paddingLeft: '12px' },
	'.fn-bullet': { color: 'var(--fn-list-marker)' },
	'.fn-checkbox': {
		display: 'inline-block',
		position: 'relative',
		boxSizing: 'border-box',
		width: '0.95em',
		height: '0.95em',
		marginRight: '0.15em',
		verticalAlign: '-0.12em',
		border: '1px solid var(--fn-muted)',
		borderRadius: '3px',
		cursor: 'pointer',
	},
	'.fn-checkbox.fn-checked': { backgroundColor: 'var(--fn-accent)', borderColor: 'var(--fn-accent)' },
	'.fn-checkbox.fn-checked::after': {
		content: '""',
		position: 'absolute',
		left: '0.28em',
		top: '0.1em',
		width: '0.22em',
		height: '0.45em',
		border: 'solid var(--fn-background)',
		borderWidth: '0 2px 2px 0',
		transform: 'rotate(45deg)',
	},
	'.fn-task-done': { color: 'var(--fn-done-colour)', textDecoration: 'var(--fn-done-decoration)' },
	'.fn-rule': { display: 'inline-block', width: '100%', verticalAlign: 'middle', borderTop: '1px solid var(--fn-rule)' },
	'.fn-code-line': { fontFamily: 'var(--fn-monospace)', fontSize: '0.9em', backgroundColor: 'var(--fn-code-background)', padding: '0 10px' },
	'.fn-code-first': { borderTopLeftRadius: '4px', borderTopRightRadius: '4px' },
	'.fn-code-last': { borderBottomLeftRadius: '4px', borderBottomRightRadius: '4px' },
	'.fn-code-closing': { fontSize: '0.4em', lineHeight: '1' },
	'.fn-code-info': { color: 'var(--fn-muted)', fontSize: '0.8em' },
	'.fn-callout': { backgroundColor: 'rgba(var(--fn-callout-rgb), 0.1)', padding: '0 12px' },
	'.fn-callout-first': { borderTopLeftRadius: '4px', borderTopRightRadius: '4px', paddingTop: '4px' },
	'.fn-callout-last': { borderBottomLeftRadius: '4px', borderBottomRightRadius: '4px', paddingBottom: '4px' },
	'.fn-callout-title': { color: 'rgb(var(--fn-callout-rgb))', fontWeight: '600' },
	'.fn-callout-icon svg': { width: '1em', height: '1em', verticalAlign: '-0.15em', marginRight: '0.35em' },
	'.fn-table': { borderCollapse: 'collapse', margin: '4px 0', cursor: 'text' },
	'.fn-table th, .fn-table td': { border: '1px solid var(--fn-table-border)', padding: '2px 8px' },
	'.fn-table th': { fontWeight: '700' },
	'.fn-rendered-block': { display: 'block', padding: '2px 0', cursor: 'text' },
	'.fn-rendered-inline': { display: 'inline-block', maxWidth: '100%', verticalAlign: 'bottom' },
	'.fn-rendered-pending, .fn-rendered-failed': { color: 'var(--fn-muted)', fontFamily: 'var(--fn-monospace)', fontSize: '0.9em', whiteSpace: 'pre-wrap' },
});

/** A mode's text and token styles as the variables the styles above read. */
function tokenVars(t: TokenStyle): Record<string, string> {
	const vars: Record<string, string> = {
		'--fn-font': t.font,
		'--fn-size': t.size,
		'--fn-link': t.link,
		'--fn-bold': t.bold,
		'--fn-italic': t.italic,
		'--fn-quote': t.quote,
		'--fn-quote-style': t.quoteStyle,
	};
	t.headingColours.forEach((colour, i) => (vars[`--fn-h${i + 1}-colour`] = colour));
	t.headingSizes.forEach((size, i) => (vars[`--fn-h${i + 1}-size`] = size));
	t.headingFonts.forEach((font, i) => (vars[`--fn-h${i + 1}-font`] = font));
	return vars;
}

/** Live Preview's own token styles, as overrides on its editor. A stylesheet, so they follow the class wherever it is. */
let livePreviewSheet: CSSStyleSheet | null = null;

/**
 * Obsidian's theme as CSS variables on the page, for the styles above and
 * the page's own. Source's token styles go on the root; Live Preview's
 * override them on its editor. Called again whenever the theme changes.
 */
export function applyTheme(theme: Theme): void {
	const root = document.documentElement.style;
	const vars: Record<string, string> = {
		'--fn-background': theme.background,
		'--fn-text': theme.text,
		'--fn-muted': theme.muted,
		'--fn-accent': theme.accent,
		'--fn-yaml-key': theme.yamlKey,
		'--fn-border': theme.border,
		'--fn-selection': theme.selection,
		'--fn-caret': theme.caret,
		'--fn-code-background': theme.codeBackground,
		'--fn-monospace': theme.monospace,
		'--fn-highlight': theme.highlight,
		'--fn-tag-colour': theme.tagColour,
		'--fn-tag-background': theme.tagBackground,
		'--fn-unresolved-colour': theme.unresolvedColour,
		'--fn-unresolved-opacity': theme.unresolvedOpacity,
		'--fn-list-marker': theme.listMarker,
		'--fn-done-colour': theme.doneColour,
		'--fn-done-decoration': theme.doneDecoration,
		'--fn-quote-border': theme.quoteBorder,
		'--fn-quote-border-width': theme.quoteBorderWidth,
		'--fn-rule': theme.rule,
		'--fn-table-border': theme.tableBorder,
		'--fn-scrollbar-thumb': theme.scrollbarThumb,
		'--fn-scrollbar-active-thumb': theme.scrollbarActiveThumb,
		'--fn-strip-background': theme.strip.background,
		'--fn-strip-border': theme.strip.border,
		'--fn-strip-text': theme.strip.text,
		'--fn-strip-active-background': theme.strip.activeBackground,
		'--fn-strip-active-text': theme.strip.activeText,
		'--fn-strip-hover': theme.strip.hover,
		'--fn-strip-radius': theme.strip.radius,
		'--fn-strip-font': theme.strip.font,
		'--fn-strip-font-size': theme.strip.fontSize,
		'--fn-strip-icon': theme.strip.icon,
		...tokenVars(theme.source),
	};
	for (const [name, value] of Object.entries(vars)) root.setProperty(name, value);
	if (!livePreviewSheet) {
		livePreviewSheet = new CSSStyleSheet();
		document.adoptedStyleSheets = [...document.adoptedStyleSheets, livePreviewSheet];
	}
	const overrides = Object.entries(tokenVars(theme.livePreview)).map(([name, value]) => `${name}: ${value};`);
	livePreviewSheet.replaceSync(`.cm-editor.fn-live-preview { ${overrides.join(' ')} }`);
	callouts = theme.callouts;
}
