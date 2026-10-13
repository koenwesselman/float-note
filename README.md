# Float Note

A desktop-only Obsidian plugin for macOS that pops the current note into a small window which stays on top and stays visible when you switch Spaces, switch to another app's full-screen Space, or move between displays.

**Status: 0.5.0, Phase 3d of the plan.** The note opens in a plugin-created macOS panel window (an `NSPanel`) that floats over other apps, including full-screen ones, while Obsidian keeps its Dock icon. Edit shows styled Markdown source and saves to the vault after a short pause. View (Cmd+E) shows the note as Obsidian renders it, read-only. The plan lives in the vault at `Plans/Float Note.md`.

## Install

1. Build: `npm install && npm run build`.
2. Create `<vault>/.obsidian/plugins/float-note/` and copy `main.js`, `manifest.json` and `styles.css` into it.
3. In Obsidian: Settings → Community plugins → reload the list, then enable **Float Note**.

After a rebuild, copy the files again and toggle the plugin off and on (or reload Obsidian).

## Commands

Palette only - none has a default hotkey.

- **Float current note** - opens the active note in the panel, or retargets the open panel to it.
- **Toggle float overlay** - hides or shows the panel, saving first; with no panel open, floats the current note.
- **Toggle float view** - switches the panel between Edit and View, for when it does not have focus (Cmd+E inside it).
- **Close float overlay** - saves and closes the panel. From inside the panel: the `×` on its top strip, or Esc (Cmd+W too, where Electron lets it through).
- **Restore Dock icon** - escape hatch if Obsidian is ever left out of the Dock.

## Settings

- **Always-on-top level** - `floating` (default), `pop-up-menu` or `screen-saver`.
- **Opacity** - 0.5 to 1.
- **Full-screen method** - whether Obsidian leaves the Dock and Cmd+Tab while the panel is open: None (default, and enough on macOS 27), Activation policy, or Process transform. See below.
- **Debug log** - off by default; appends window, Dock and view state to `debug.log` in the plugin folder.

The panel's size and position are remembered between uses, and a position on a display that is no longer connected falls back to the centre of the screen.

## Why a panel, and why the Dock might disappear

Since macOS 10.14, an ordinary window cannot float over another app's full-screen Space. On macOS 27, an Obsidian popout failed to, even with Obsidian out of the Dock. Obsidian creates popouts with fixed window options, so a popout cannot be made a panel - the window type that utilities like Tot use. Float Note therefore creates its own `BrowserWindow` with `type: 'panel'` through `@electron/remote`, which Obsidian exposes as `require('electron').remote`.

On macOS 27 the panel alone is enough: it floats over full-screen apps with Obsidian still in the Dock. The Full-screen method setting stays for other macOS versions. Whatever hid the Dock icon, Float Note puts it back when the panel closes.

## How the panel is managed

The panel lives in Electron's main process, outside Obsidian's workspace, so the plugin owns its lifecycle. It closes with Obsidian's main window and when the plugin unloads. Any panel left behind by a crash is destroyed the next time the plugin loads. The page is sandboxed, with no Node access.
