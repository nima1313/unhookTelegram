# Unhook for Telegram

A Chrome extension (Manifest V3) to control what you see in **Telegram Web K**
(`web.telegram.org/k/`) — like Unhook, but tailored to Telegram and far more
customizable. Hide distracting UI, curate which chats appear, and lock yourself
into a focused view.

Built for the **WebK** client (`/k/`) only. If you open the extension on WebA
(`/a/`), the popup offers to switch you over.

---

## Features

### Focus folder ⭐ (the reliable way to show only chosen chats)
Create a native Telegram folder (e.g. **`focus mode`**) containing exactly the
chats you want, type its name into the extension, and on every page load the
extension **auto-opens that folder for you**. Because the filtering is done by
Telegram itself, it's always correct and complete — no matter how many chats you
have.

- Clicks the folder tab on load, re-checking for a few seconds to beat
  Telegram restoring your last-open folder.
- Works with **Hide folder tabs** turned on — the folder opens even while the
  tab bar is hidden.

### Block other chats
Filters only shape the chat *list* — Telegram still opens any chat you reach
another way (a channel link inside a message, a mention, search). With **Block
other chats** on, opening a chat outside your focus set covers the conversation
with a "Hidden by Focus Mode" screen and a **Back to focus** button.

- The focus set is your **focus folder** (when Focus folder is on) and/or your
  **whitelist** (when whitelist mode is on). Blocked names are always blocked.
- Membership comes from Telegram's own folder data, so every chat in the
  folder counts — not just the ones currently on screen.

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
  a word you add. Applies in whitelist mode too.
- Matching is case-insensitive and substring-based (`family` matches "Family ❤️").
  `saved messages` matches your Saved Messages chat.
- Filters your **whole** chat list (not just what's on screen), in every folder,
  with no gaps — see *How it works*.

### Element picker
Click **Pick element to hide**, then click *anything* in Telegram to remove it.
It generates a CSS selector from what you clicked and remembers it — the
fallback when a preset doesn't match your build, or for hiding anything not
covered by a preset. Picking a chat in the list adds it to **Hide chats by
name** instead (a selector can't cleanly remove one row of Telegram's virtual
list).

### Quality-of-life
- A **master switch** turns everything on/off at once.
- Settings **sync** across your Chrome profile (`chrome.storage.sync`).
- Everything applies **instantly** — no page reload needed.

---

## Install (developer mode)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder.
4. Open [web.telegram.org/k/](https://web.telegram.org/k/) and click the extension icon.

---

## Recommended setup for a focus view

1. In Telegram, create a folder named `focus mode` and add the chats you care about.
2. In the popup: enable **Focus folder** (the name box defaults to `focus mode`).
3. Also enable **Hide folder tabs**, **Hide search bar**, and any others you like.

You'll land straight in your curated, distraction-free view every time.

---

## How it works

- **Presets** and **picked elements** are a stylesheet injected by
  `src/content.js` — fast, flicker-free, and it survives re-renders.
- **Focus folder** clicks your folder's tab in `#folders-tabs` on load.
- **Name filtering** runs in `src/page.js`, inside WebK's own page context.
  WebK's chat list is *virtual*: only the rows on screen exist in the DOM,
  each absolutely positioned, so hiding rows would leave gaps and miss every
  chat that isn't on screen. Instead, `page.js` wraps the function WebK uses to
  fetch pages of dialogs: it scans the folder's whole list once, keeps the
  matching chats, and hands Telegram only those. Telegram then renders a
  normal, gap-free list. Live updates (a new message in a hidden chat) are
  filtered the same way.

`page.js` relies on WebK internals (`window.appDialogsManager`). If a Telegram
update changes them, name filtering stops (a warning is logged to the console)
while everything else keeps working. If a preset stops matching after an
update, the **element picker** still works.

---

## Project structure

| Path | Purpose |
|------|---------|
| `manifest.json` | MV3 manifest |
| `src/content.js` | Presets, focus-folder click, element picker; forwards filter settings to `page.js` |
| `src/page.js` | Name filtering (whitelist / blacklist) and the "block other chats" guard, inside WebK's page context |
| `popup/` | Extension popup UI (`popup.html` / `popup.css` / `popup.js`) |
| `icons/` | Toolbar/store icons |
| `tools/make_icons.py` | Regenerates the icons (`python3 tools/make_icons.py`) |

---

## Notes

- **No data leaves your browser.** All settings live in `chrome.storage.sync`.
- The extension only runs on `https://web.telegram.org/k/*`.
- Presets target WebK's stable structural ids/classes (`#column-left`,
  `#folders-tabs`, `#folders-container`, `#new-menu`, …); the element picker is
  the fallback for anything a preset misses.

## License

MIT
