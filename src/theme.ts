import { getIcon } from 'obsidian';
import type { CalloutStyle, Theme } from './panel-editor';

/**
 * Obsidian's current theme, read from the main window at the moment of opening.
 *
 * Token colours are measured rather than read from variables: themes style
 * CodeMirror's own classes directly (Things sets `span.cm-strong` to its own
 * `--strong-color` and never touches Obsidian's `--bold-color`), so the only
 * theme-agnostic answer is what the theme actually renders. A hidden copy of
 * Obsidian's source-editor markup is put in the main window, measured, and
 * removed.
 */
export function readTheme(): Theme {
	const style = getComputedStyle(document.body);
	const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
	const probe = measureTokens();
	return {
		background: v('--background-primary', '#1e1e1e'),
		text: v('--text-normal', '#dcddde'),
		muted: v('--text-muted', '#999999'),
		accent: v('--text-accent', '#8a5cf5'),
		link: probe.link?.color ?? v('--link-color', v('--text-accent', '#8a5cf5')),
		bold: probe.strong?.color ?? 'inherit',
		italic: probe.em?.color ?? 'inherit',
		quote: probe.quote?.color ?? v('--text-muted', '#999999'),
		quoteStyle: probe.quote?.fontStyle ?? 'normal',
		headingColours: [1, 2, 3, 4, 5, 6].map((n) => probe[`h${n}`]?.color ?? 'inherit'),
		headingSizes: [1, 2, 3, 4, 5, 6].map((n, i) => probe[`h${n}`]?.fontSize ?? ['1.6em', '1.4em', '1.2em', '1.1em', '1em', '1em'][i] ?? '1em'),
		yamlKey: probe.frontmatterKey?.color ?? v('--text-muted', '#999999'),
		border: v('--background-modifier-border', '#333333'),
		selection: v('--text-selection', 'rgba(138, 92, 245, 0.25)'),
		codeBackground: v('--code-background', 'rgba(127, 127, 127, 0.15)'),
		font: v('--font-text', style.fontFamily || 'system-ui, sans-serif'),
		monospace: v('--font-monospace', 'ui-monospace, Menlo, monospace'),
		size: v('--font-text-size', '16px'),
		highlight: v('--text-highlight-bg', 'rgba(255, 208, 0, 0.4)'),
		tagColour: v('--tag-color', v('--text-accent', '#8a5cf5')),
		tagBackground: v('--tag-background', 'rgba(138, 92, 245, 0.1)'),
		unresolvedColour: v('--link-unresolved-color', v('--text-accent', '#8a5cf5')),
		unresolvedOpacity: v('--link-unresolved-opacity', '0.7'),
		listMarker: v('--list-marker-color', v('--text-faint', '#666666')),
		doneColour: v('--checklist-done-color', v('--text-muted', '#999999')),
		doneDecoration: v('--checklist-done-decoration', 'line-through'),
		quoteBorder: v('--blockquote-border-color', v('--interactive-accent', '#8a5cf5')),
		quoteBorderWidth: v('--blockquote-border-thickness', '2px'),
		rule: v('--hr-color', v('--background-modifier-border', '#333333')),
		tableBorder: v('--table-border-color', v('--background-modifier-border', '#333333')),
		callouts: measureCallouts(),
	};
}

interface Measured {
	color: string;
	fontStyle: string;
	fontSize: string;
}

/** Line and token classes as Obsidian's CodeMirror 6 source view emits them. */
const PROBES: Record<string, { line?: string; token: string }> = {
	strong: { token: 'cm-strong' },
	em: { token: 'cm-em' },
	link: { token: 'cm-link' },
	quote: { line: 'HyperMD-quote HyperMD-quote-1', token: 'cm-quote cm-quote-1' },
	frontmatterKey: { line: 'cm-hmd-frontmatter', token: 'cm-hmd-frontmatter cm-atom' },
	...Object.fromEntries(
		[1, 2, 3, 4, 5, 6].map((n) => [`h${n}`, { line: `HyperMD-header HyperMD-header-${n}`, token: `cm-header cm-header-${n}` }]),
	),
};

function measureTokens(): Record<string, Measured | undefined> {
	const results: Record<string, Measured | undefined> = {};
	const host = document.body.createDiv({ cls: 'markdown-source-view mod-cm6 cm-s-obsidian' });
	host.setCssStyles({ position: 'absolute', left: '-10000px', top: '0', visibility: 'hidden', pointerEvents: 'none' });
	try {
		const content = host.createDiv({ cls: 'cm-editor' }).createDiv({ cls: 'cm-scroller' }).createDiv({ cls: 'cm-content' });
		const spans: Record<string, HTMLElement> = {};
		for (const [name, probe] of Object.entries(PROBES)) {
			spans[name] = content.createDiv({ cls: `cm-line ${probe.line ?? ''}`.trim() }).createSpan({ cls: probe.token, text: 'x' });
		}
		for (const [name, span] of Object.entries(spans)) {
			const computed = getComputedStyle(span);
			results[name] = { color: computed.color, fontStyle: computed.fontStyle, fontSize: computed.fontSize };
		}
	} catch (e) {
		console.error('Float Note: could not measure the theme', e);
	} finally {
		host.remove();
	}
	return results;
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
