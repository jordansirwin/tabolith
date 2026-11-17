# <img src="icons/icon48.png" alt="" width="40" align="top"> Tabolith

> *One does not simply close a tab. One files it, groups it, and lets it rest.*

You have 147 tabs open. Three are playing music. One is a recipe you opened in March.
**Tabolith** is a Chrome extension that gives them somewhere to live: a towering, vertical
monolith of tabs, neatly stacked into groups you name yourself.

## What it does

- 🪜 **Vertical outline.** Your tabs, stacked like a proper tower instead of shrinking into tiny slivers. Open it from the toolbar icon; it lives in its own small window.
- 🗂️ **Groups.** Collect tabs into groups, tint each one with a color (click its dot), collapse them, and rename them from the right-click menu. New tabs start in **Unorganized Mess**, the default group that can't be renamed or deleted.
- 🧲 **Drag and drop.** Pick up tabs or whole groups and drop them where they belong, or use the right-click menus to move them.
- 🖱️ **Multi-select.** Cmd/Ctrl-click to grab a bunch, Shift-click to grab a stretch, then move or close them all at once from the right-click menu.
- 🔁 **Put it back.** Close a tab and reopen it (say, with Cmd/Ctrl+Shift+T) within 10 minutes, and it returns to its old group and spot.
- 💤 **Saved tabs.** Close a whole group with ⏏, close a browser window, or quit Chrome, and the tabs stay in the outline as "saved" entries. Closing a single tab removes it, so the tower doesn't fill up with ghosts.
- ↺ **Reopen on demand.** Wake a saved tab with a double-click, or revive an entire group in one go.
- 🔄 **Reload a group.** Right-click a group → Reload tabs refreshes every open tab in it.
- 🔭 **Find a group.** Double-click a group header to jump to the browser window holding its tabs.
- 🔎 **Search.** Find that recipe from March by title, URL, or group name.

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
