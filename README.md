# Float Note

[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-ffdd00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/koenwesselman)

Float the note you are working on in a small window that stays on top of everything on your Mac. It stays visible when you switch Spaces, when another app goes full screen, and when you move between displays, like Tot's overlay but for a note in your vault.

Use it to keep a checklist, meeting notes or a scratchpad in view while you work in another app, and to type straight into it.

**macOS only.** Float Note needs window behaviour that only macOS has. On Windows and Linux its commands show a notice and do nothing.

## Install

In Obsidian, open **Settings → Community plugins → Browse**, search for **Float Note**, then select **Install** and **Enable**.

To install by hand, download `main.js` and `manifest.json` from the [latest release](https://github.com/koenwesselman/float-note/releases/latest), put them in `<vault>/.obsidian/plugins/float-note/`, then reload Obsidian and enable **Float Note** under **Settings → Community plugins**.

## Use

Open a note and run **Float current note** from the command palette. The note opens in the floating panel. Float another note and it opens in a new tab beside the first. Drag the panel by its top strip, and resize it from any edge. It reopens where you left it.

None of the commands has a default hotkey. To summon the panel quickly, assign one under **Settings → Hotkeys**.

| Command | What it does |
| --- | --- |
| **Float current note** | Opens the active note in the panel, in a new tab when the panel is already open. A note already floating switches to its tab. |
| **Toggle float overlay** | Hides or shows the panel, saving first. With no panel open, floats the current note. |
| **Toggle float view** | Switches the panel's current tab between editing and View when the panel does not have focus. |
| **Toggle float source mode** | Switches the panel's current tab between Live Preview and Source. |
| **Close float overlay** | Saves and closes the panel, with all its tabs. |

## Tabs

Each floating note has a tab on the panel's top strip.

- Select a tab to switch to it, or use **Cmd+Shift+[** and **Cmd+Shift+]**, or **Ctrl+Tab** and **Ctrl+Shift+Tab**.
- Drag a tab to reorder it.
- **Cmd+W**, the tab's **×** or a middle-click close a tab, saving it first. Closing the last tab closes the panel.
- **Esc** closes the panel with all its tabs.

Each tab keeps its own undo history, cursor, scroll position, and mode. Tabs are not remembered once the panel closes.

Inside the panel, **Cmd+E** switches the current tab between editing and View.

## Live Preview, Source and View

The panel edits the way Obsidian does. Each tab opens in your **Default editing mode** from **Settings → Editor**: Live Preview or Source.

**Live Preview** shows the note rendered, with its Markdown visible only where the cursor is. Headings, bold, italic, highlights, code, links, lists, quotes, callouts, tables and horizontal rules show as they will look. Move the cursor into one and its Markdown appears so you can edit it. When the panel does not have focus, the whole note shows rendered.

- Select a checkbox to tick a task off. It is saved like any other edit.
- Select a table cell to edit its text in place. **Tab** and **Shift+Tab** move between cells, **Enter** and the arrow keys between rows. Moving the cursor into a table from above or below shows its Markdown instead.
- Math, images, embeds, Mermaid diagrams and code blocks that other plugins draw, such as Dataview queries, are rendered by Obsidian and shown in the panel. They can take a moment to appear.

**Source** shows the note's Markdown, with headings, bold, italic, code, links, quotes and frontmatter styled in your theme's colours.

In either mode, what you type is saved to the vault after a short pause. Changes made elsewhere, in the main editor, by another plugin or by sync, appear in the panel, unless the panel has unsaved edits of its own. Then the panel's version wins.

**View** shows the note as Obsidian renders it, with callouts, tables, images and your theme. It is read-only: checkboxes do nothing there.

In all three, **Cmd+click** a link to open it. A note opens in the panel, in a tab of its own, and a web link in your browser. A link to a note that does not exist yet, or to another kind of file such as a PDF, opens in Obsidian's main window.

## Settings

- **Opacity**: how see-through the panel is, from 0.5 to 1.
- **Debug log**: off by default. When on, panel and view events are appended to `debug.log` in the plugin folder, to help diagnose problems.

## Known limits

- **Quitting Obsidian (Cmd+Q) while typing in the panel can lose up to about a second of text.** Edits are saved after a short pause, and quitting cannot wait for a save.
- **If the same note is edited in the panel and somewhere else within that second, the panel's version wins.**
- **View is read-only**, and in Live Preview what Obsidian renders - math, images, embeds, diagrams, plugin code blocks - is a copy: select it to edit its Markdown. Content that other plugins draw slowly, such as Dataview or Tasks queries, may be missing from both, and an embedded note does not update until you close its tab and float it again.
- **Live Preview is the panel's own, not Obsidian's**, styled with Obsidian's CSS and your theme. It covers Obsidian's Markdown, but not every theme detail or plugin that changes how the editor looks, and links to notes that do not exist are marked only once the note is saved.
- **Obsidian's hotkeys only work while Obsidian is the frontmost app.** To bring the panel up from inside another app, switch to Obsidian first.
- **The panel does not reopen after Obsidian restarts.**
- **Tested on macOS 27 with Obsidian 1.14.4, installer 1.9.14 (Electron 37.6.0).** The panel depends on Electron, which comes with the Obsidian installer, not with Obsidian's automatic updates. If the panel misbehaves, check **Settings → General**: when it shows an installer version older than 1.9.14, download the current installer from [obsidian.md](https://obsidian.md/download).

## Files and privacy

Float Note makes no network requests and collects nothing. Images your note links from the web load in the panel, as they do in Obsidian.

It reads and writes only the notes you float, and its own files in its plugin folder, `.obsidian/plugins/float-note/`:

- `data.json`: its settings and where the panel was last left.
- `panel.html`: the panel's page, a static file holding the editor. The panel is a separate window and has to load its page from a file. It contains no note content.
- With **Debug log** on, `debug.log` and `last-view.html`, the last note rendered in View.

Nothing is written outside your vault, and uninstalling the plugin removes all of these files.

## Dependencies on Obsidian internals

Float Note relies on parts of Obsidian and Electron that are not public, stable plugin API, and any of them can change in an Obsidian update:

- **`require('electron').remote`.** Electron removed `remote` in v14. It works only because Obsidian provides `@electron/remote` in its place. Without it the plugin cannot create its window at all.
- **Electron's `type: 'panel'` window.** On macOS this is what lets the panel float over full-screen apps while Obsidian keeps its Dock icon. An ordinary window cannot do that.
- **`MarkdownRenderer.render`** is public API, but what View and Live Preview's rendered blocks show depends on what it produces. A few things are then patched in the copied output: callout icons, `app://` image paths, and the `contain: strict` Obsidian puts on `body`.
- **`vault.getConfig('livePreview')`**, for your default editing mode, and **`MarkdownPreviewRenderer.codeBlockPostProcessors`**, for which code blocks plugins draw. Without them the panel opens in Live Preview and renders a fixed list of common code block languages.
- **Obsidian's stylesheet and its editor's class names.** The panel's editor is styled with Obsidian's whole stylesheet - the app's, your theme's and your snippets' - and its headings and lists carry the classes Obsidian's editor uses (`.markdown-source-view`, `.HyperMD-header`, `.HyperMD-list-line`, `.cm-indent`, `.list-bullet` and others), so your theme styles them as it does in Obsidian. The panel's other colours are measured from hidden copies of Obsidian's editor, callout and tab markup (`.cm-strong`, `.cm-hmd-frontmatter`, `.callout`, `.workspace-tab-header`, `--callout-color` and others). All of it follows your theme, and changes with it, but only while those classes exist.

If an update breaks something, switch on **Debug log**, reproduce the problem and [open an issue](https://github.com/koenwesselman/float-note/issues) with the contents of `debug.log`. Check it first: it records panel, view and close events, and the note's file path.

## How it works

Since macOS 10.14, an ordinary window cannot float over another app's full-screen Space, and Obsidian's popout windows are ordinary windows whose options a plugin cannot change. Float Note therefore creates its own window, through the `@electron/remote` module Obsidian exposes as `require('electron').remote`. The window is of Electron's `type: 'panel'`, which is an `NSPanel` and the window type Tot uses, set to join every Space including full-screen ones, at the `floating` level.

Obsidian's editor cannot run outside Obsidian, so the panel has an editor of its own, CodeMirror, bundled into its page. To look like Obsidian's, it is styled with Obsidian's own stylesheet, copied from the main window when the panel opens and whenever the theme changes, and its lines carry the class names Obsidian's editor uses.

The panel lives in Electron's main process, outside Obsidian's workspace, so the plugin owns its lifecycle. It saves before closing, closes with Obsidian's main window and when the plugin unloads, and destroys any panel left behind by a crash the next time it loads. The page is sandboxed with no Node access. The plugin talks to it with `executeJavaScript` and polls it for edits, so there is no callback to leak across a reload.

## Building from source

```bash
npm install
npm run build
```

Copy `main.js` and `manifest.json` into `<vault>/.obsidian/plugins/float-note/`, then reload Obsidian. Run `npm run lint` and `npm test` before committing.

## Support

If Float Note is useful to you, you can [buy me a coffee](https://buymeacoffee.com/koenwesselman).

## Licence

[MIT](LICENSE).
