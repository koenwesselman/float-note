import { describe, expect, it } from 'vitest';
import { escapePipes } from '../src/panel-editor/live-preview/cell-editor';
import { linkAt } from '../src/panel-editor/live-preview/links';
import { tableAt, tableRows } from '../src/panel-editor/live-preview/table';
import { blocks, inline, state } from './helpers';

describe('inline markup', () => {
	it('hides emphasis markers away from the cursor', () => {
		expect(inline('a **bold** and *it* ~~x~~ ==hi== `c`')).toEqual(['hide "**"', 'hide "**"', 'hide "*"', 'hide "*"', 'hide "~~"', 'hide "~~"', 'hide "=="', 'hide "=="', 'hide "`"', 'hide "`"']);
	});

	it('reveals an element the cursor touches, at either edge', () => {
		expect(inline('a **bo¦ld** *it*')).toEqual(['hide "*"', 'hide "*"']);
		expect(inline('a **bold**¦ *it*')).toEqual(['hide "*"', 'hide "*"']);
		expect(inline('a ¦**bold** *it*')).toEqual(['hide "*"', 'hide "*"']);
	});

	it('shows everything rendered while the editor is unfocused', () => {
		expect(inline('**bold**')).toEqual(['hide "**"', 'hide "**"']);
	});

	it('shows a Markdown link as its text', () => {
		expect(inline('see [the docs](https://example.com "title") now')).toEqual(['hide "["', 'mark fn-link "the docs"', 'hide "](https://example.com \\"title\\")"']);
	});

	it('leaves bracketed text that is not a link alone', () => {
		expect(inline('a [note] here')).toEqual([]);
	});

	it('shows a wikilink as its alias or target, dimmed when unresolved', () => {
		expect(inline('[[Note#Part|shown]]')).toEqual(['hide "[[Note#Part|"', 'mark fn-link "shown"', 'hide "]]"']);
		expect(inline('[[Missing]]', ['Missing'])).toEqual(['hide "[["', 'mark fn-link fn-unresolved "Missing"', 'hide "]]"']);
		expect(inline('[[Mis¦sing]]')).toEqual(['mark fn-link "Missing"']);
	});

	it('marks bare URLs as links', () => {
		expect(inline('go to https://example.com today')).toEqual(['mark fn-link "https://example.com"']);
	});

	it('hides the backslash of an escape', () => {
		expect(inline('a \\*b')).toEqual(['hide "\\\\"']);
	});

	it('renders embeds, images and math through Obsidian', () => {
		expect(inline('![[pic.png|200]] and $x^2$')).toEqual(['widget RenderedWidget "![[pic.png|200]]"', 'widget RenderedWidget "$x^2$"']);
		expect(inline('![alt](img.png)')).toEqual(['widget RenderedWidget "![alt](img.png)"']);
	});

	it('does not read prices as math', () => {
		expect(inline('costs $5 and $6')).toEqual([]);
	});

	it('leaves tags and comments as text', () => {
		expect(inline('#tag and %%note%%')).toEqual([]);
	});
});

describe('lines', () => {
	it('hides heading markers unless the cursor is on the line', () => {
		expect(inline('## Title ##\ntext')).toEqual(['hide "## "', 'hide " ##"']);
		expect(inline('## Ti¦tle\ntext')).toEqual([]);
	});

	it('draws bullets, and leaves ordered numbers', () => {
		expect(inline('- one\n1. two')).toEqual(['widget BulletWidget "-"']);
		expect(inline('-¦ one')).toEqual([]);
	});

	it('draws tasks as checkboxes and styles done ones', () => {
		expect(inline('- [ ] todo\n- [x] done')).toEqual(['widget CheckboxWidget "- [ ]"', 'widget CheckboxWidget "- [x]"', 'mark fn-task-done "done"']);
		expect(inline('1. [ ] todo')).toEqual(['widget CheckboxWidget "[ ]"']);
	});

	it('keeps a checkbox while typing in the task text', () => {
		expect(inline('- [ ] to¦do')).toEqual(['widget CheckboxWidget "- [ ]"']);
	});

	it('gives quotes a border and hides their markers', () => {
		expect(inline('> one\n> two')).toEqual(['line fn-quote @1', 'hide "> "', 'line fn-quote @2', 'hide "> "']);
	});

	it('draws callouts with their colour, icon and title', () => {
		expect(inline('> [!tip] Title\n> body')).toEqual([
			'line fn-callout fn-callout-first fn-callout-title @1',
			'widget CalloutTitleWidget "> [!tip] "',
			'line fn-callout fn-callout-last @2',
			'hide "> "',
		]);
	});

	it('draws a rule, unless the cursor is on it', () => {
		expect(inline('a\n\n---\n')).toEqual(['widget RuleWidget "---"']);
		expect(inline('a\n\n--¦-\n')).toEqual([]);
	});

	it('puts code on a background and hides its fences outside it', () => {
		expect(inline('```js\nx\n```')).toEqual([
			'line fn-code-line fn-code-first @1',
			'hide "```"',
			'mark fn-code-info "js"',
			'line fn-code-line @2',
			'line fn-code-line fn-code-last fn-code-closing @3',
			'hide "```"',
		]);
		expect(inline('```js\n¦x\n```')).toEqual(['line fn-code-line fn-code-first @1', 'line fn-code-line @2', 'line fn-code-line fn-code-last @3']);
	});
});

describe('blocks', () => {
	it('draws tables, unless the cursor is in one', () => {
		expect(blocks('| a | b |\n| - | - |\n| 1 | 2 |\n\nafter')).toEqual(['block TableWidget "| a | b |\\n| - | - |\\n| 1 | 2 |"']);
		expect(blocks('| a | b |\n| - | - |\n| 1 ¦| 2 |\n\nafter')).toEqual([]);
	});

	it('renders Mermaid and display math through Obsidian', () => {
		expect(blocks('```mermaid\ngraph TD\n```')).toEqual(['block RenderedWidget "```mermaid\\ngraph TD\\n```"']);
		expect(blocks('$$\nx^2\n$$')).toEqual(['block RenderedWidget "$$\\nx^2\\n$$"']);
		expect(blocks('```js\nx\n```')).toEqual([]);
	});

	it('leaves rendered code blocks to the block field', () => {
		expect(inline('```mermaid\ngraph TD\n```')).toEqual([]);
	});
});

describe('linkAt', () => {
	const at = (doc: string) => {
		const s = state(doc.replace('^', ''));
		return linkAt(s, doc.indexOf('^'));
	};

	it('finds wikilink targets, without the alias', () => {
		expect(at('see [[No^te#H|alias]]')).toEqual({ target: 'Note#H', external: false });
		expect(at('![[pi^c.png]]')).toEqual({ target: 'pic.png', external: false });
	});

	it('tells URLs from vault paths', () => {
		expect(at('[x](https://ex^ample.com)')).toEqual({ target: 'https://example.com', external: true });
		expect(at('[te^xt](My%20Note.md)')).toEqual({ target: 'My Note.md', external: false });
		expect(at('visit https://exa^mple.com')).toEqual({ target: 'https://example.com', external: true });
	});

	it('finds nothing outside links', () => {
		expect(at('plain ^text')).toBeNull();
	});
});

describe('tables', () => {
	const rows = (doc: string) => {
		const s = state(doc);
		const node = tableAt(s, 0);
		return node ? tableRows(s, node).map((r) => r.cells.map((c) => s.sliceDoc(c.from, c.to))) : null;
	};

	it('counts empty cells, which have no node of their own', () => {
		expect(rows('|  | Copilot | Claude |\n| --- | --- | --- |\n| Cost |  | Teams |')).toEqual([
			['', 'Copilot', 'Claude'],
			['Cost', '', 'Teams'],
		]);
	});

	it('reads rows without leading or trailing pipes, and keeps escaped pipes in their cell', () => {
		expect(rows('a | b\n--- | ---\nx \\| y | z')).toEqual([
			['a', 'b'],
			['x \\| y', 'z'],
		]);
	});

	it('puts text typed into an empty cell after one space', () => {
		const s = state('| a |  |\n| - | - |');
		const node = tableAt(s, 0);
		const empty = node ? tableRows(s, node)[0]?.cells[1] : undefined;
		expect(empty && [empty.from, empty.to]).toEqual([6, 6]);
	});

	it('escapes pipes typed into a cell, but not ones already escaped', () => {
		expect(escapePipes('a|b', '')).toBe('a\\|b');
		expect(escapePipes('|', '\\')).toBe('|');
		expect(escapePipes('a\\|b', '')).toBe('a\\|b');
	});
});
