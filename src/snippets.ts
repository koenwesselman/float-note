import type { App, TFile } from 'obsidian';
import type { FloatPanel, Log } from './panel';
import type { RenderRequest } from './panel-editor';
import { cssFingerprint, renderHtml, shadowStylesheet } from './render';

/**
 * Answer Live Preview's requests for blocks only Obsidian can draw - math,
 * Mermaid, embeds, images - by rendering each in the main window. Obsidian's
 * stylesheet goes first, and again whenever the main window's CSS changed.
 */
export async function answerRenderRequests(app: App, file: TFile, panel: FloatPanel, requests: RenderRequest[], log: Log): Promise<void> {
	const started = Date.now();
	const fingerprint = cssFingerprint();
	if (panel.stylesheetFingerprint !== fingerprint) {
		panel.stylesheetFingerprint = fingerprint;
		await panel.setStylesheet(await shadowStylesheet());
	}
	const results = await Promise.all(
		requests.map(async ({ key, markdown, inline }) => {
			try {
				return { key, html: (await renderHtml(app, file, markdown, inline)).html };
			} catch (e) {
				console.error('Float Note: could not render a block', e);
				return { key, html: null };
			}
		}),
	);
	await panel.setRendered(results);
	log('snippets-rendered', { count: results.length, failed: results.filter((r) => r.html === null).length, ms: Date.now() - started });
}
