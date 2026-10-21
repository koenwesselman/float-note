import { App, TFile } from 'obsidian';
import { collectCss, renderHtml } from './render';

export interface ViewDocument {
	srcdoc: string;
	htmlBytes: number;
	cssBytes: number;
	imagesRewritten: number;
}

/**
 * The note as Obsidian renders it, as a complete HTML document for the
 * panel's View frame, copied out with Obsidian's stylesheets and the body
 * classes and inline variables that carry the theme. Read-only by
 * construction: nothing in the frame talks back.
 */
export async function buildViewDocument(app: App, file: TFile, text: string, dumpPath: string | null = null): Promise<ViewDocument> {
	const { html, imagesRewritten } = await renderHtml(app, file, text);
	if (dumpPath) dumpHtml(app, dumpPath, html);
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

/** The last rendered HTML, beside debug.log, for diagnosing what Obsidian produced. Debug log only. */
function dumpHtml(app: App, path: string, html: string): void {
	// Diagnostics only: a failed write is not worth reporting.
	app.vault.adapter.write(path, html).catch(() => undefined);
}

function escapeAttribute(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
