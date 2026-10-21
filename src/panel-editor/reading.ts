import { isExternal, requestOpen } from './live-preview/links';

/**
 * View is Obsidian's own rendering, made by the plugin in the main window and
 * shown here in an iframe. An iframe because the view carries Obsidian's whole
 * stylesheet, which also styles `.cm-editor` - the same classes this page's
 * editor uses - so it must not share a document with it.
 */
export const frame = document.getElementById('fn-view') as HTMLIFrameElement | null;

/** Show a rendered document, keeping the reader's scroll position across re-renders. */
export function showInFrame(srcdoc: string): void {
	if (!frame) return;
	frame.dataset.scroll = String(frame.contentWindow?.scrollY ?? 0);
	frame.srcdoc = srcdoc;
}

/**
 * The view does not edit: checkboxes do not toggle, and a plain click on a
 * link does nothing. Cmd+click opens the link in Obsidian.
 */
function wireFrame(onKey: (event: KeyboardEvent) => void): void {
	const doc = frame?.contentDocument;
	if (!doc) return;
	doc.addEventListener('keydown', onKey, true);
	doc.addEventListener(
		'click',
		(event) => {
			const target = event.target as Element | null;
			if (!target?.closest('a, input')) return;
			event.preventDefault();
			const anchor = target.closest('a');
			if (!anchor || !(event.metaKey || event.ctrlKey)) return;
			const internal = anchor.getAttribute('data-href');
			const href = internal ?? anchor.getAttribute('href') ?? '';
			if (href) requestOpen({ target: href, external: internal === null && isExternal(href) });
		},
		true,
	);
}

/** Wire each document the frame loads, restore its scroll position, and report what it shows. */
export function watchFrame(onKey: (event: KeyboardEvent) => void, report: (diagnostics: Record<string, unknown>) => void): void {
	frame?.addEventListener('load', () => {
		wireFrame(onKey);
		const y = Number(frame.dataset.scroll ?? 0);
		frame.contentWindow?.scrollTo(0, y);
		report(diagnose());
	});
}

/** What the frame actually shows, for the debug log - the frame cannot be seen from the plugin. */
function diagnose(): Record<string, unknown> {
	const doc = frame?.contentDocument;
	if (!frame || !doc) return { frame: frame ? 'no document' : 'missing' };
	const win = frame.contentWindow;
	const preview = doc.querySelector('.markdown-preview-view');
	const first = doc.querySelector('.markdown-preview-sizer > *');
	const style = (el: Element | null) => {
		if (!el || !win) return null;
		const c = win.getComputedStyle(el);
		const r = el.getBoundingClientRect();
		return { display: c.display, visibility: c.visibility, opacity: c.opacity, color: c.color, background: c.backgroundColor, position: c.position, top: Math.round(r.top), height: Math.round(r.height), width: Math.round(r.width) };
	};
	return {
		frameSize: [frame.clientWidth, frame.clientHeight],
		frameDisplay: getComputedStyle(frame).display,
		srcdocLength: frame.srcdoc.length,
		textLength: doc.body?.innerText.length ?? null,
		scrollHeight: doc.documentElement.scrollHeight,
		html: style(doc.documentElement),
		body: style(doc.body),
		preview: style(preview),
		firstChild: first ? { tag: first.tagName, cls: first.className, ...style(first) } : null,
		images: Array.from(doc.images, (img) => ({ src: img.src.slice(0, 40), complete: img.complete, naturalWidth: img.naturalWidth })),
	};
}
