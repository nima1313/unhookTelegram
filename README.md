# Unhook for Telegram

A Chrome extension (Manifest V3) to control what you see in **Telegram Web**
(`web.telegram.org`) — like Unhook, but tailored to Telegram and far more
customizable. Hide distracting UI, curate which chats appear, and lock yourself
into a focused view.

Works with both Telegram Web clients: **WebK** (`/k/`) and **WebA** (`/a/`).

---

## Features

### Focus folder ⭐ (the reliable way to show only chosen chats)
Create a native Telegram folder (e.g. **`focus mode`**) containing exactly the
chats you want, type its name into the extension, and on every page load the
extension **auto-opens that folder for you**. Because the filtering is done by
Telegram itself, it's always correct and complete — no matter how many chats you
have.

- Clicks the folder tab on load, retrying across the first few seconds to beat
  Telegram restoring your last-open folder.
- Plays nicely with **Hide folder tabs**: the tab bar is kept visible just long
  enough to click your folder, then hidden.

### Presets (one-click toggles)
- Hide the **search bar**
- Hide the **folder / category tabs** (All, Personal, Groups, Channels…)
- Hide the **stories bar**
- Hide the **menu / settings button** (the ☰ hamburger)
- Hide the **new-chat button** (the floating ✎ pencil)
- Hide the **entire chat list** (total focus mode)

### Chat filtering by name
- **Show only these chats** (whitelist) — hide everything except the names you list.
- **Hide chats by name** (blacklist) — hide any conversation whose title contains
  a word you add.
- Matching is case-insensitive and substring-based (`family` matches "Family ❤️").

### Element picker
Click **Pick element to hide**, then click *anything* in Telegram to remove it.
It generates a CSS selector from what you clicked and remembers it — the
guaranteed fallback when a preset doesn't match your build, or for hiding
anything not covered by a preset.

### Quality-of-life
- A **master switch** turns everything on/off at once.
- Settings **sync** across your Chrome profile (`chrome.storage.sync`).
- Everything applies **instantly** — no page reload needed.

---

## Install (developer mode)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder.
4. Open [web.telegram.org](https://web.telegram.org) and click the extension icon.

---

## Recommended setup for a focus view

1. In Telegram, create a folder named `focus mode` and add the chats you care about.
2. In the popup: enable **Focus folder** (the name box defaults to `focus mode`).
3. Also enable **Hide folder tabs**, **Hide search bar**, and any others you like.

You'll land straight in your curated, distraction-free view every time.

---

## How it works

Telegram Web is a single-page app that constantly re-renders, so the extension:

- Injects a stylesheet for the **presets** and **picked elements** (fast,
  flicker-free, survives re-renders).
- Runs a `MutationObserver`-driven pass for **name filtering** and the
  **focus-folder** click, so rules re-apply as the app updates.

### Why "Focus folder" instead of scraping the chat list?
WebA (and long lists in WebK) **virtualize** the dialog list — chats scrolled
out of view are removed from the DOM entirely. That makes DOM-based "show only
these chats" unreliable for long lists (it can only see what's currently
rendered). The **Focus folder** feature sidesteps this completely by letting
Telegram do the filtering server-side. The whitelist/blacklist still exist and
work well for shorter folders.

If a preset ever stops matching after a Telegram update, use the **element
picker** — it keeps working regardless of class-name changes.

---

## Project structure

| Path | Purpose |
|------|---------|
| `manifest.json` | MV3 manifest |
| `src/content.js` | Core engine: presets, name filtering, focus-folder click, element picker |
| `popup/` | Extension popup UI (`popup.html` / `popup.css` / `popup.js`) |
| `icons/` | Toolbar/store icons |
| `tools/make_icons.py` | Regenerates the icons (`python3 tools/make_icons.py`) |

---

## Notes

- **No data leaves your browser.** All settings live in `chrome.storage.sync`.
- The extension only runs on `https://web.telegram.org/*`.
- Some presets target WebA's stable structural classes (`#LeftMainHeader`,
  `.NewChatButton`, `.DropdownMenu`) and WebK equivalents; the element picker is
  the fallback for anything a preset misses.

## License

MIT
