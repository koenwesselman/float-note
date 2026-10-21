import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { yamlFrontmatter } from '@codemirror/lang-yaml';
import type { Extension } from '@codemirror/state';
import { Tag, tags as t } from '@lezer/highlight';
import type { DelimiterType, Element, InlineContext, MarkdownConfig } from '@lezer/markdown';

/** Highlighting for the Obsidian syntax below; styled in theme.ts. */
export const obsidianTags = {
	highlight: Tag.define(),
	hashtag: Tag.define(),
};

const HighlightDelimiter: DelimiterType = { resolve: 'Highlight', mark: 'HighlightMark' };

const space = /\s|^$/;
const tagName = /^#[\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*/u;

/** The character before `pos`, or '' at the start of the inline section. */
function before(cx: InlineContext, pos: number): string {
	return pos > cx.offset ? cx.slice(pos - 1, pos) : '';
}

/**
 * `[[target|alias]]`, or with `!` in front an embed. Children: WikiMark for
 * `[[`, `![[`, `|` and `]]`, WikiTarget, and WikiAlias when there is one.
 * Kept to one line, and without brackets inside, as Obsidian does.
 */
function wikiLink(cx: InlineContext, start: number, open: number, name: string): number {
	const rest = cx.slice(open, cx.end);
	const close = rest.search(/\]\]|[\n[\]]/);
	if (close < 1 || !rest.startsWith(']]', close)) return -1;
	const end = open + close;
	const pipe = rest.slice(0, close).indexOf('|');
	const children: Element[] = [cx.elt('WikiMark', start, open)];
	if (pipe < 0) {
		children.push(cx.elt('WikiTarget', open, end));
	} else {
		children.push(cx.elt('WikiTarget', open, open + pipe), cx.elt('WikiMark', open + pipe, open + pipe + 1));
		children.push(cx.elt('WikiAlias', open + pipe + 1, end));
	}
	children.push(cx.elt('WikiMark', end, end + 2));
	return cx.addElement(cx.elt(name, start, end + 2, children));
}

/** Text between `mark` and the next `mark`, as `name` with `markName` children; -1 without a closing mark. */
function enclosed(cx: InlineContext, pos: number, mark: string, name: string, markName: string, valid?: (inner: string, after: string) => boolean): number {
	const from = pos + mark.length;
	const close = cx.slice(from, cx.end).indexOf(mark);
	if (close < 1) return -1;
	const to = from + close;
	if (valid && !valid(cx.slice(from, to), cx.slice(to + mark.length, to + mark.length + 1))) return -1;
	return cx.addElement(cx.elt(name, pos, to + mark.length, [cx.elt(markName, pos, from), cx.elt(markName, to, to + mark.length)]));
}

/** Obsidian's additions to Markdown: wikilinks and embeds, ==highlights==, #tags, %%comments%% and $math$. */
const obsidianMarkdown: MarkdownConfig = {
	defineNodes: [
		{ name: 'WikiLink', style: t.link },
		{ name: 'Embed', style: t.link },
		{ name: 'WikiMark', style: t.processingInstruction },
		'WikiTarget',
		'WikiAlias',
		{ name: 'Highlight', style: { 'Highlight/...': obsidianTags.highlight } },
		{ name: 'HighlightMark', style: t.processingInstruction },
		{ name: 'Hashtag', style: obsidianTags.hashtag },
		{ name: 'Comment', style: t.comment },
		{ name: 'CommentMark', style: t.comment },
		{ name: 'InlineMath', style: t.special(t.string) },
		{ name: 'DisplayMath', style: t.special(t.string) },
		{ name: 'MathMark', style: t.processingInstruction },
	],
	parseInline: [
		{
			name: 'Embed',
			before: 'Image',
			parse: (cx, next, pos) => (next === 33 && cx.char(pos + 1) === 91 && cx.char(pos + 2) === 91 ? wikiLink(cx, pos, pos + 3, 'Embed') : -1),
		},
		{
			name: 'WikiLink',
			before: 'Link',
			parse: (cx, next, pos) => (next === 91 && cx.char(pos + 1) === 91 ? wikiLink(cx, pos, pos + 2, 'WikiLink') : -1),
		},
		{
			name: 'Highlight',
			parse(cx, next, pos) {
				if (next !== 61 || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1;
				const spaceBefore = space.test(before(cx, pos));
				const spaceAfter = space.test(cx.slice(pos + 2, pos + 3));
				return cx.addDelimiter(HighlightDelimiter, pos, pos + 2, !spaceAfter, !spaceBefore);
			},
		},
		{
			name: 'Hashtag',
			parse(cx, next, pos) {
				if (next !== 35 || !space.test(before(cx, pos))) return -1;
				const match = tagName.exec(cx.slice(pos, cx.end));
				return match ? cx.addElement(cx.elt('Hashtag', pos, pos + match[0].length)) : -1;
			},
		},
		{
			name: 'Comment',
			parse: (cx, next, pos) => (next === 37 && cx.char(pos + 1) === 37 ? enclosed(cx, pos, '%%', 'Comment', 'CommentMark') : -1),
		},
		{
			name: 'Math',
			parse(cx, next, pos) {
				if (next !== 36) return -1;
				if (cx.char(pos + 1) === 36) return enclosed(cx, pos, '$$', 'DisplayMath', 'MathMark');
				// Inline math as Obsidian reads it: no space inside either `$`, and no digit after
				// the closing one, so prices like "$5 and $6" stay text.
				return enclosed(cx, pos, '$', 'InlineMath', 'MathMark', (inner, after) => !/^\s|\s$|\n\s*\n/.test(inner) && !/\d/.test(after));
			},
		},
	],
};

/**
 * GFM base, for strikethrough, task lists and tables, plus Obsidian's own
 * syntax. markdown() adds its own keymap, which continues lists on Enter.
 * Wrapped so a YAML frontmatter block is parsed as YAML: plain Markdown reads
 * its closing `---` as a setext underline and turns the block into a heading.
 */
export function markdownSyntax(): Extension {
	return yamlFrontmatter({ content: markdown({ base: markdownLanguage, extensions: [obsidianMarkdown] }) });
}
