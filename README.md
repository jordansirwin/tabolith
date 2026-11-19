# <img src="icons/icon48.png" alt="" width="40" align="top"> Tabolith

> *One does not simply close a tab. One files it, groups it, and lets it rest.*

You have 147 tabs open. Three are playing music. One is a recipe you opened in March.
**Tabolith** is a Chrome extension that gives them somewhere to live: a towering, vertical
monolith of tabs, neatly stacked into groups you name yourself.

## What it does

- 🪜 **Vertical outline.** Your tabs, stacked like a proper tower instead of shrinking into tiny slivers. Open it from the toolbar icon; it lives in its own small window.
- 🗂️ **Groups.** Collect tabs into groups, tint each one with any of 25 colors (right-click → Color; the dot and header highlight change together), collapse them, and rename them from the right-click menu. Deleting a group closes its tabs (you're asked first if it has any).
- 🪟 **One window per group.** Every browser window is a group, and every tab in it (new tabs too) belongs to that group: open a new window and it gets its own group ("Window 2", and so on; rename it to keep it, otherwise it disappears if the window closes empty). Move a tab to a group and it moves to that group's window; drag a tab into a window and it joins that group; drag it out into a new window and that window becomes a new group. A group's window reopens where you last left it, even after you close it or restart Chrome (after a restart, each group re-claims the window holding most of its tabs). Right-click ⚙ → *Arrange groups into windows* gathers all existing tabs into their groups' windows (it may open several windows).
- 🧲 **Drag and drop.** Pick up tabs or whole groups and drop them where they belong, or use the right-click menus to move them.
- 🖱️ **Multi-select.** Cmd/Ctrl-click to grab a bunch, Shift-click to grab a stretch, then move or close them all at once from the right-click menu.
- 🔁 **Put it back.** Close a tab and reopen it (say, with Cmd/Ctrl+Shift+T) within 10 minutes, and it returns to its old group and spot.
- 💤 **Saved tabs.** Close a whole group with ⏏, close a browser window, or quit Chrome, and the tabs stay in the outline as "saved" entries. Closing a single tab removes it, so the tower doesn't fill up with ghosts. Empty new-tab pages are never saved.
- ↺ **Reopen on demand.** Wake a saved tab with a double-click, revive an entire group in one go, or bring back every saved tab at once from ⚙ → *Reopen all saved tabs*.
- 🔄 **Reload a group.** Right-click a group → Reload tabs refreshes every open tab in it.
- 🔭 **Find a group.** Double-click a group header to jump to the browser window holding its tabs.
- 🔎 **Search.** Find that recipe from March by title, URL, or group name.
- 💾 **Import / Export.** ⚙ → *Import/Export* saves your groups and tabs to a JSON file and loads them back (importing replaces what you have now).
- ☁️ **Sync.** Turn on ⚙ → *Sync with Google account* to keep a copy of your groups and tabs in Chrome sync (it's a backup, not live merging between machines). Reinstall the extension and it restores your tower automatically. If the tower is too big for Chrome sync's quota (about 90KB compressed), the menu item shows an error.
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
