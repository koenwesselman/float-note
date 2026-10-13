# Float Note

A desktop-only Obsidian plugin for macOS that floats the current note in a small window which stays on top and stays visible when you switch Spaces, switch to another app's full-screen Space, or move between displays - like Tot's overlay, for a vault note.

The plan, with every decision and test behind it, lives in the vault at `Plans/Completed/Float Note.md`.

## Install

1. Build: `npm install && npm run build`.
2. Create `<vault>/.obsidian/plugins/float-note/` and copy `main.js`, `manifest.json` and `styles.css` into it.
3. In Obsidian: Settings → Community plugins → reload the list, then enable **Float Note**.

After a rebuild, copy the files again and reload Obsidian ("Reload app without saving").

## Commands

Palette only - none has a default hotkey.

- **Float current note** - opens the active note in the panel, or retargets the open panel to it.
- **Toggle float overlay** - hides or shows the panel, saving first; with no panel open, floats the current note.
- **Toggle float view** - switches the panel between Edit and View when it does not have focus.
- **Close float overlay** - saves and closes the panel.

Inside the panel: **Cmd+E** switches between Edit and View, and **Esc**, **Cmd+W** or the **×** on the top strip close it. Drag it by the top strip.

## Edit and View

**Edit** is a small Markdown editor showing the source, with headings, bold, italic, code, links, quotes and frontmatter styled in your theme's colours. Edits are saved to the vault after a short pause, and changes made elsewhere - the main pane, the Linter, sync - appear in the panel unless it has unsaved edits of its own, in which case the panel's version wins.

**View** shows the note as Obsidian renders it - callouts, tables, images and theme included - read-only: links and checkboxes do nothing there.

There is no Live Preview. Obsidian's own cannot run in the panel, which is a separate window process with no Obsidian in it.

## Settings

- **Opacity** - 0.5 to 1.
- **Debug log** - off by default; appends panel and view events to `debug.log` in the plugin folder, for diagnosing problems.

The panel's size and position are remembered between uses; a position on a display that is no longer connected falls back to the centre of the screen.

## Limits and Dependencies

Float Note relies on parts of Obsidian and Electron that are not public, stable plugin API. Any of them can change in an Obsidian update:

- **`require('electron').remote`.** Electron removed `remote` in v14. It works only because Obsidian assigns `@electron/remote` to it at start-up. Without it the plugin cannot create its window at all.
- **Electron's `type: 'panel'` window.** On macOS this is what lets the panel float over full-screen apps with Obsidian still in the Dock. An ordinary window cannot do that. 0.5.0 in this repository's history has code that takes Obsidian out of the Dock instead, if it is ever needed.
- **`MarkdownRenderer.render`** is public API, but what View shows depends on what it produces. A few things are then patched in the copied output: callout icons, `app://` image paths, and the `contain: strict` Obsidian puts on `body`.
- **Obsidian's CSS class names** (`.markdown-source-view`, `.cm-strong`, `.cm-header-1`, `.cm-hmd-frontmatter` and others). Edit's colours are measured from a hidden copy of Obsidian's editor markup, so a theme follows automatically - but only while those classes exist.

If an update breaks something, switch on **Debug log** and look at `debug.log` in the plugin folder. It records panel, view and close events, and what the View frame actually contains.

Known limits:

- **Quitting Obsidian (Cmd+Q) while typing in the panel can lose up to about a second of text.** Edits are saved after a short pause, and quitting cannot wait for a save.
- **Edits made in the panel and somewhere else within that same second:** the panel's version wins.
- **View is read-only.** Links and checkboxes do nothing, and content plugins draw asynchronously (Dataview, Tasks queries) may be missing.
- **Obsidian's hotkeys only work while Obsidian is the frontmost app.** To summon the panel from inside another app, Obsidian has to be brought forward first.
- **The panel is not reopened after Obsidian restarts.**
- **macOS only.** Tested on macOS 27 with Obsidian 1.14.4 (Electron 37.6.0).

## How It Works

Since macOS 10.14, an ordinary window cannot float over another app's full-screen Space, and Obsidian's popout windows are ordinary windows whose options a plugin cannot change. Float Note therefore creates its own window, through the `@electron/remote` module Obsidian exposes as `require('electron').remote`, of Electron's `type: 'panel'` - an `NSPanel`, the window type Tot uses - set to join every Space including full-screen ones, at the `floating` level. On macOS 27 that is enough: Obsidian keeps its Dock icon.

The panel lives in Electron's main process, outside Obsidian's workspace, so the plugin owns its lifecycle: it saves before closing, closes with Obsidian's main window and when the plugin unloads, and destroys any panel left behind by a crash the next time it loads. The page is sandboxed, with no Node access; the plugin talks to it with `executeJavaScript` and polls it for edits, so there is no callback to leak across a reload.

Earlier versions could also take Obsidian out of the Dock (needed by an ordinary window, and not by a panel). That code is in this repository's history at 0.5.0 if a future macOS needs it.
