import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/**
 * Live Preview: the note shown rendered, with markup revealed only where the
 * cursor is. Swapped in and out of the editor through a compartment, so
 * switching to Source keeps the undo history and the cursor.
 *
 * A constant, so the compartment's current content can be compared with it.
 */
export const livePreview: Extension = [EditorView.editorAttributes.of({ class: 'fn-live-preview' })];
