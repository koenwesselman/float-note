import { Facet } from '@codemirror/state';

/**
 * The plugin's id for the tab an editor state belongs to. Renderings and
 * opened links carry it, so the plugin resolves them against the right note.
 */
export const noteId = Facet.define<string, string>({ combine: (values) => values[0] ?? '' });
