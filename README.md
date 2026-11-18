# <img src="icons/icon48.png" alt="" width="40" align="top"> Tabolith

> *One does not simply close a tab. One files it, groups it, and lets it rest.*

You have 147 tabs open. Three are playing music. One is a recipe you opened in March.
**Tabolith** is a Chrome extension that gives them somewhere to live: a towering, vertical
monolith of tabs, neatly stacked into groups you name yourself.

## What it does

- 🪜 **Vertical outline.** Your tabs, stacked like a proper tower instead of shrinking into tiny slivers. Open it from the toolbar icon; it lives in its own small window.
- 🗂️ **Groups.** Collect tabs into groups, tint each one with any of 25 colors (right-click → Color; the dot and header highlight change together), collapse them, and rename them from the right-click menu. New tabs start in **Unorganized Mess**, the default group that can't be renamed or deleted. Deleting a group asks whether to move its tabs to Unorganized Mess or close them.
- 🪟 **One window per group.** Each group lives in its own browser window. Move a tab to a group and it moves to that group's window; drag a tab into a group's window and it joins the group; tabs you open in a group's window belong to it. **Unorganized Mess** takes over the window you're already using, and other groups get a window the first time a tab moves into them, and it reopens where you last left it, even after you close it or restart Chrome (after a restart, each group re-claims the window holding most of its tabs). A tab dragged into a window that no group owns goes to **Unorganized Mess**. Right-click ⚙ → *Arrange groups into windows* gathers all existing tabs into their groups' windows (it may open several windows).
- 🧲 **Drag and drop.** Pick up tabs or whole groups and drop them where they belong, or use the right-click menus to move them.
- 🖱️ **Multi-select.** Cmd/Ctrl-click to grab a bunch, Shift-click to grab a stretch, then move or close them all at once from the right-click menu.
- 🔁 **Put it back.** Close a tab and reopen it (say, with Cmd/Ctrl+Shift+T) within 10 minutes, and it returns to its old group and spot.
- 💤 **Saved tabs.** Close a whole group with ⏏, close a browser window, or quit Chrome, and the tabs stay in the outline as "saved" entries. Closing a single tab removes it, so the tower doesn't fill up with ghosts.
- ↺ **Reopen on demand.** Wake a saved tab with a double-click, or revive an entire group in one go.
- 🔄 **Reload a group.** Right-click a group → Reload tabs refreshes every open tab in it.
- 🔭 **Find a group.** Double-click a group header to jump to the browser window holding its tabs.
- 🔎 **Search.** Find that recipe from March by title, URL, or group name.
- 🚀 **Open at launch.** Turn on ⚙ → *Open when Chrome starts* and the Tabolith window appears whenever Chrome does.
- ⌨️ **Keyboard shortcut.** Press Option+Shift+A (Mac) or Alt+Shift+S (Windows/Linux) from any Chrome window to open Tabolith with the search box ready. Change it at `chrome://extensions/shortcuts`.

## Install (dev edition)

1. Open `chrome://extensions` and flip on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Click the toolbar icon. The Tabolith window rises from the ground.

## What's inside the monolith

```
manifest.json
icons/                    toolbar/extension icons
src/background/           service worker: owns the tree model + persistence
src/sidepanel/            panel UI (html/css/js), renders state and sends commands
```

The background worker is the keeper of the tree and writes it to `chrome.storage.local`.
The panel just draws what it's told and sends polite requests back.

## License

[MIT](LICENSE). Build your own monolith.
