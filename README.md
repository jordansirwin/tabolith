# Tabolith

Chrome (MV3) extension with its own standalone window: vertical tab outline with groups, drag and drop,
and persistence across restarts (closed tabs stay as "saved" entries).

## Install (dev)
1. Open `chrome://extensions` and enable Developer mode.
2. Load unpacked → select this folder.
3. Click the toolbar icon to open the Tabolith window.

## Layout
```
manifest.json
icons/                    toolbar/extension icons
src/background/           service worker: owns the tree model + persistence
src/sidepanel/            panel UI (html/css/js), renders state and sends commands
```

## License

[MIT](LICENSE)
