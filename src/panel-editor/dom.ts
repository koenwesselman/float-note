/**
 * A new element for the panel page. The page runs in its own sandboxed
 * window, without Obsidian, so Obsidian's createEl and friends - which it
 * adds to its own window - do not exist here; this is the one place the
 * page creates elements itself.
 */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);
	if (cls) element.className = cls;
	return element;
}
