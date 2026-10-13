import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { App, Component, MarkdownRenderer, TFile, setIcon } from 'obsidian';

/**
 * How long to let post-processors finish after MarkdownRenderer.render
 * resolves. Some draw asynchronously; anything slower than this - a Dataview
 * query, say - is missing from the view, which is the accepted cost of
 * copying Obsidian's output out of Obsidian.
 */
const SETTLE_MS = 100;

export interface ViewDocument {
	srcdoc: string;
	htmlBytes: number;
	cssBytes: number;
	imagesRewritten: number;
}

/**
 * The note as Obsidian renders it, as a complete HTML document for the
 * panel's View frame. Rendered here in the main window - the only place
 * Obsidian's renderer exists - into a detached element, then copied out with
 * Obsidian's stylesheets and the body classes and inline variables that carry
 * the theme. Read-only by construction: nothing in the frame talks back.
 */
export async function buildViewDocument(app: App, file: TFile, text: string, debug = false): Promise<ViewDocument> {
	// Attached, though hidden: some of what Obsidian draws - callout icons -
	// is only filled in once the element is in a document with styles applied.
	const host = document.body.createDiv();
	host.setCssStyles({ position: 'absolute', left: '-10000px', top: '0', width: '420px', visibility: 'hidden', pointerEvents: 'none' });
	const component = new Component();
	component.load();
	let html: string;
	let imagesRewritten = 0;
	try {
		await MarkdownRenderer.render(app, text, host, file.path, component);
		await sleep(SETTLE_MS);
		fillCalloutIcons(host);
		imagesRewritten = rewriteImages(host);
		html = host.innerHTML;
	} finally {
		component.unload();
		host.remove();
	}

	if (debug) dumpHtml(html);
	const css = await collectCss();
	const body = document.body;
	const srcdoc = `<!doctype html>
<html class="${escapeAttribute(document.documentElement.className)}"><head><meta charset="utf-8">
<style>${css}</style>
<style>
html, body { height: auto !important; min-height: 100%; overflow: auto !important; margin: 0; background: var(--background-primary); }
/* Obsidian gives body contain: strict - right for the app, where body is the
   window; here it sizes body to nothing and clips everything to that. */
body { contain: none !important; -webkit-app-region: no-drag; user-select: text; }
.markdown-preview-view { height: auto !important; overflow: visible !important; padding: 10px 14px !important; }
.markdown-preview-sizer { min-height: 0 !important; padding-bottom: 16px !important; max-width: none !important; }
input[type=checkbox] { pointer-events: none; }
a { cursor: default; }
</style></head>
<body class="${escapeAttribute(body.className)}" style="${escapeAttribute(body.getAttribute('style') ?? '')}">
<div class="markdown-preview-view markdown-rendered allow-fold-headings allow-fold-lists show-indentation-guide">
<div class="markdown-preview-sizer markdown-preview-section">${html}</div></div>
</body></html>`;
	return { srcdoc, htmlBytes: html.length, cssBytes: css.length, imagesRewritten };
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
			img.setAttribute('src', pathToFileURL(path).href);
			count++;
		} catch {
			// Left as it was: the alt text shows, as before.
		}
	}
	return count;
}

/** The last rendered HTML, for diagnosing what Obsidian produced. Debug log only. */
function dumpHtml(html: string): void {
	try {
		writeFileSync(join(tmpdir(), 'obsidian-float-note', 'last-view.html'), html, 'utf8');
	} catch {
		// Diagnostics only.
	}
}

/**
 * Every stylesheet in the main window as text: Obsidian's own, the theme and
 * enabled snippets. Relative url()s - fonts, mostly - are made absolute
 * against their sheet, because in the frame they would resolve against nothing.
 */
async function collectCss(): Promise<string> {
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

/** app:// images fetched once per session, as data URLs. */
const inlined = new Map<string, string | null>();

/**
 * Images Obsidian's stylesheet loads from app:// - the external-link arrows -
 * fetched here, where app:// resolves, and inlined as data URLs. Fonts are left
 * alone: the view does without them, and they are hundreds of kilobytes.
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

function escapeAttribute(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
