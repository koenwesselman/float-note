import { HighlightStyle } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
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

/** Styled source: markup stays visible, as in Obsidian's Source mode. Colours and sizes come from Obsidian's theme. */
const headingTags = [t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6];
export const highlight = HighlightStyle.define([
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

export const editorTheme = EditorView.theme({
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

/** Obsidian's theme as CSS variables on the page, for the styles above and the page's own. */
export function applyTheme(theme: Theme): void {
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
