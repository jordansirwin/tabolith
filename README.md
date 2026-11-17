# 🗿 Tabolith

> *One does not simply close a tab. One files it, groups it, and lets it rest.*

You have 147 tabs open. Three are playing music. One is a recipe you opened in March.
**Tabolith** is a Chrome extension that gives them somewhere to live: a towering, vertical
monolith of tabs, neatly stacked into groups you name yourself.

## What it does

- 🪜 **Vertical outline.** Your tabs, stacked like a proper tower instead of shrinking into tiny slivers.
- 🗂️ **Groups.** Collect tabs into groups, rename them (double-click, or right-click → Rename), and tint them with a color.
- 🧲 **Drag and drop.** Pick up tabs or whole groups and drop them where they belong.
- 🖱️ **Multi-select.** Cmd/Ctrl-click to grab a bunch, Shift-click to grab a stretch, then move them all at once from the right-click menu.
- 💤 **Saved tabs.** Close a tab (or a whole group) and it stays in the outline as a "saved" entry. Chrome can restart; Tabolith remembers.
- ↺ **Reopen on demand.** Wake a single tab with a double-click, or revive an entire group in one go.
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
