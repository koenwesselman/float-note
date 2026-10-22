import { syntaxTree } from '@codemirror/language';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { noteId } from './note';

/** A link the user asked to open: a note or file Obsidian resolves, or a URL. */
export interface LinkTarget {
	target: string;
	external: boolean;
}

/** A link to open, and the tab it was clicked in, whose note relative links resolve against. */
export interface OpenRequest extends LinkTarget {
	tab: string;
}

/** Link paths in the note that resolve to nothing, as Obsidian's metadata cache lists them. */
export const setUnresolved = StateEffect.define<readonly string[]>();

export const unresolvedField = StateField.define<ReadonlySet<string>>({
	create: () => new Set(),
	update(value, tr) {
		for (const effect of tr.effects) if (effect.is(setUnresolved)) value = new Set(effect.value);
		return value;
	},
});

/** A wikilink target without its `#heading` or `#^block`, as the metadata cache keys it. */
export function linkPath(target: string): string {
	return target.split('#')[0]?.trim() ?? '';
}

export function isUnresolved(state: EditorState, target: string): boolean {
	const path = linkPath(target);
	return path !== '' && state.field(unresolvedField, false)?.has(path) === true;
}

let pending: OpenRequest | null = null;

/** Queue a link to open; the plugin collects it on its next poll. */
export function requestOpen(link: LinkTarget, tab: string): void {
	pending = { ...link, tab };
}

export function takeOpenRequest(): OpenRequest | null {
	const link = pending;
	pending = null;
	return link;
}

/** Whether an href is a URL to hand to the system, rather than a path in the vault. */
export function isExternal(href: string): boolean {
	return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

function fromDestination(url: string): LinkTarget {
	const raw = url.replace(/^<|>$/g, '');
	if (isExternal(raw)) return { target: raw, external: true };
	let target = raw;
	try {
		target = decodeURI(raw);
	} catch {
		// Left as written.
	}
	return { target, external: false };
}

const LINKS = new Set(['WikiLink', 'Embed', 'Link', 'Image', 'Autolink', 'URL']);

function linkNode(state: EditorState, pos: number): SyntaxNode | null {
	const tree = syntaxTree(state);
	for (const side of [1, -1] as const) {
		for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
			if (LINKS.has(node.name)) return node;
		}
	}
	return null;
}

/** The link at a document position, if any. */
export function linkAt(state: EditorState, pos: number): LinkTarget | null {
	const node = linkNode(state, pos);
	if (!node) return null;
	const text = (n: SyntaxNode) => state.sliceDoc(n.from, n.to);
	switch (node.name) {
		case 'WikiLink':
		case 'Embed': {
			const target = node.getChild('WikiTarget');
			return target ? { target: text(target).trim(), external: false } : null;
		}
		case 'Link':
		case 'Image': {
			const url = node.getChild('URL');
			return url ? fromDestination(text(url)) : null;
		}
		case 'Autolink': {
			const url = node.getChild('URL');
			return url ? { target: text(url), external: true } : null;
		}
		default:
			// A bare URL; inside a Link it was caught above.
			return { target: text(node), external: true };
	}
}

/** Cmd+click opens a link, in Source and Live Preview alike. A plain click edits it. */
export const linkClicks = EditorView.domEventHandlers({
	mousedown(event, view) {
		if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return false;
		const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
		const link = pos === null ? null : linkAt(view.state, pos);
		if (!link) return false;
		requestOpen(link, view.state.facet(noteId));
		event.preventDefault();
		return true;
	},
});
