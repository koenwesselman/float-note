import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { yamlFrontmatter } from '@codemirror/lang-yaml';
import type { Extension } from '@codemirror/state';

/**
 * GFM base, for strikethrough, task lists and tables. markdown() adds its own
 * keymap, which continues lists on Enter. Wrapped so a YAML frontmatter block
 * is parsed as YAML: plain Markdown reads its closing `---` as a setext
 * underline and turns the block into a heading.
 */
export function markdownSyntax(): Extension {
	return yamlFrontmatter({ content: markdown({ base: markdownLanguage }) });
}
