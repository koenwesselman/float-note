import { App, Component, MarkdownRenderer, TFile, setIcon } from 'obsidian';

/**
 * How long to let post-processors finish after MarkdownRenderer.render
 * resolves. Some draw asynchronously; anything slower than this - a Dataview
 * query, say - is missing from the output, which is the accepted cost of
 * copying Obsidian's output out of Obsidian.
 */
const SETTLE_MS = 100;

/**
 * Markdown as Obsidian renders it, as HTML to copy into the panel. Rendered
 * here in the main window - the only place Obsidian's renderer exists - into
 * a detached element. With `inline`, the paragraph Obsidian wraps around a
 * lone line is dropped, so the result fits inside a line of text.
 */
export async function renderHtml(app: App, file: TFile, text: string, inline = false): Promise<{ html: string; imagesRewritten: number }> {
	// Attached, though hidden: some of what Obsidian draws - callout icons -
	// is only filled in once the element is in a document with styles applied.
	const host = document.body.createDiv();
	host.setCssStyles({ position: 'absolute', left: '-10000px', top: '0', width: '420px', visibility: 'hidden', pointerEvents: 'none' });
	const component = new Component();
	component.load();
	try {
		await MarkdownRenderer.render(app, text, host, file.path, component);
		await sleep(SETTLE_MS);
		fillCalloutIcons(host);
		const imagesRewritten = rewriteImages(host);
		const only = host.children.length === 1 ? host.firstElementChild : null;
		const html = inline && only?.tagName === 'P' ? only.innerHTML : host.innerHTML;
		return { html, imagesRewritten };
	} finally {
		component.unload();
		host.remove();
	}
}

/** A file:// URL for an absolute macOS path, every segment escaped - `%`, `#` and `?` included. */
function fileUrl(path: string): string {
	return 'file://' + path.split('/').map(encodeURIComponent).join('/');
}

/**
 * Obsidian serves vault files at `app://<id>/<absolute path>`, a scheme only
 * its own windows resolve. The panel page is loaded from a file:// URL, so the
 * same file can be reached by its plain file URL: the path is already in the
 * app:// URL, and only the scheme changes.
 */
function rewriteImages(root: HTMLElement): number {
	let count = 0;
	for (const img of Array.from(root.querySelectorAll('img'))) {
		const src = img.getAttribute('src');
		if (!src?.startsWith('app://')) continue;
		try {
			const path = decodeURIComponent(new URL(src).pathname);
			img.setAttribute('src', fileUrl(path));
			count++;
		} catch {
			// Left as it was: the alt text shows, as before.
		}
	}
	return count;
}

/**
 * Callout icons left empty by the renderer, filled from the icon the theme
 * names in `--callout-icon` on the callout - the same lookup Obsidian makes.
 */
function fillCalloutIcons(root: HTMLElement): void {
	for (const icon of Array.from(root.querySelectorAll<HTMLElement>('.callout-icon'))) {
		const svg = icon.querySelector('svg');
		if (svg && svg.childElementCount > 0) continue;
		const callout = icon.closest('.callout');
		const name = callout ? getComputedStyle(callout).getPropertyValue('--callout-icon').trim() : '';
		if (name) setIcon(icon, name);
	}
}

/**
 * A cheap stand-in for the main window's CSS: it changes when a theme,
 * snippet or plugin stylesheet is added, removed or edited, so the panel's
 * copy is rebuilt only then.
 */
export function cssFingerprint(): string {
	let rules = 0;
	for (const sheet of Array.from(document.styleSheets)) {
		try {
			rules += sheet.cssRules.length;
		} catch {
			// A sheet whose rules cannot be read is skipped by collectCss too.
		}
	}
	// The body's inline style holds the accent colour, set without touching any sheet.
	return `${document.styleSheets.length}:${rules}:${document.body.className}:${document.body.getAttribute('style') ?? ''}`;
}

/**
 * Every stylesheet in the main window as text: Obsidian's own, the theme and
 * enabled snippets. Relative url()s - fonts, mostly - are made absolute
 * against their sheet, because in the panel they would resolve against nothing.
 */
export async function collectCss(): Promise<string> {
	const parts: string[] = [];
	for (const sheet of Array.from(document.styleSheets)) {
		let rules: CSSRuleList;
		try {
			rules = sheet.cssRules;
		} catch {
			continue;
		}
		let text = Array.from(rules, (rule) => rule.cssText).join('\n');
		if (sheet.href) text = absoluteUrls(text, sheet.href);
		parts.push(text);
	}
	const css = await inlineAppImages(parts.join('\n'));
	return css.replace(/<\/style/gi, '<\\/style');
}

/**
 * Obsidian's CSS for Live Preview's renderings, which sit in shadow roots in
 * the panel. Obsidian defines its variables on `body` and `.theme-dark` and
 * the like, selectors nothing in a shadow root matches; so every custom
 * property the stylesheets name is resolved here, on the main window's body,
 * and set on the class the renderings carry.
 */
export async function shadowStylesheet(): Promise<{ css: string; bodyClass: string }> {
	const css = await collectCss();
	const names = new Set(Array.from(css.matchAll(/(--[\w-]+)\s*:/g), (m) => m[1] ?? ''));
	const computed = getComputedStyle(document.body);
	const vars: string[] = [];
	for (const name of names) {
		const value = name ? computed.getPropertyValue(name).trim() : '';
		if (value) vars.push(`${name}: ${value};`);
	}
	return { css: `${css}\n.fn-obsidian { ${vars.join(' ')} }`, bodyClass: document.body.className };
}

/** app:// images fetched once per session, as data URLs. */
const inlined = new Map<string, string | null>();

/**
 * Images Obsidian's stylesheet loads from app:// - the external-link arrows -
 * fetched here, where app:// resolves, and inlined as data URLs. Fonts are left
 * alone: the panel does without them, and they are hundreds of kilobytes.
 */
async function inlineAppImages(css: string): Promise<string> {
	const urls = new Set(Array.from(css.matchAll(/url\((['"]?)(app:\/\/[^'")]+\.(?:svg|png))\1\)/gi), (m) => m[2] ?? ''));
	for (const url of urls) {
		if (!url || inlined.has(url)) continue;
		try {
			const response = await fetch(url);
			const blob = await response.blob();
			inlined.set(url, blob.size <= 65536 ? await toDataUrl(blob) : null);
		} catch {
			inlined.set(url, null);
		}
	}
	return css.replace(/url\((['"]?)(app:\/\/[^'")]+)\1\)/g, (match, quote: string, url: string) => {
		const data = inlined.get(url);
		return data ? `url(${quote}${data}${quote})` : match;
	});
}

function toDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
		reader.onerror = () => reject(reader.error ?? new Error('read failed'));
		reader.readAsDataURL(blob);
	});
}

function absoluteUrls(css: string, base: string): string {
	return css.replace(/url\((['"]?)([^'")]+)\1\)/g, (match, quote: string, url: string) => {
		if (/^(data:|[a-z][a-z0-9+.-]*:|#)/i.test(url)) return match;
		try {
			return `url(${quote}${new URL(url, base).href}${quote})`;
		} catch {
			return match;
		}
	});
}
