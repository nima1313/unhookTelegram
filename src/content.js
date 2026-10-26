/*
 * Unhook for Telegram — content script (Telegram Web K: web.telegram.org/k/)
 *
 * Strategy:
 *  - Presets + custom picked selectors are applied purely with CSS (injected
 *    <style>), which is instant and flicker-free.
 *  - "Show only / hide chats by name" is done by page.js in WebK's own page
 *    world, where it filters the data behind Telegram's virtual chat list.
 *    This script just forwards the current filter config to it.
 *  - "Focus folder" clicks a native Telegram folder tab on load.
 */

(() => {
  "use strict";

  const STYLE_ID = "utg-style";

  const DEFAULTS = {
    hideSearch: false,
    hideFolders: false,
    hideChatList: false,
    hideStories: false,
    hideSettings: false,
    hideNewChat: false,
    customSelectors: [], // [{ selector, note }]
    blockedChats: [], // hide chats whose title contains one of these
    whitelistMode: false, // when true: show ONLY whitelisted chats
    whitelistChats: [], // ["family", "work", ...]
    focusFolderMode: false, // auto-open a native Telegram folder
    focusFolderName: "focus mode",
    blockOtherChats: false, // cover opened chats that aren't in the focus set
    enabled: true,
  };

  // ---- WebK preset selectors (verified against the live DOM) ---------------
  const PRESETS = {
    hideSearch: ["#column-left .sidebar-header .input-search"],
    hideFolders: [
      "#column-left .folders-tabs-scrollable",
      "#column-left .folders-tabs-gradient-container",
    ],
    // #folders-container holds one chat list per folder. (Not
    // .chatlist-container — WebK puts that class on the whole left column.)
    hideChatList: ["#folders-container"],
    hideStories: ["#column-left .stories-list"],
    // The ☰ button only; its sibling back-arrow stays usable during search.
    hideSettings: [
      "#column-left .left-sidebar-burger .btn-menu-toggle",
      "#column-left .left-sidebar-burger .animated-menu-icon",
    ],
    hideNewChat: ["#new-menu"],
  };

  // Flags set on <html> by page.js while a name filter is active / loading.
  const FILTER_CSS = `
html[data-utg-filtering] #column-left .sidebar-left-contacts-section {
  display: none !important;
}
html[data-utg-loading] #folders-container {
  visibility: hidden !important;
}`;

  let settings = { ...DEFAULTS };
  let settingsLoaded = false;
  // Set by the popup's "Unlock for 1 minute". Until then the extension acts
  // as if switched off — tabs, search and every chat come back — and then it
  // all returns by itself and the focus folder is reopened. Kept in
  // storage.local, not sync: a break here shouldn't unlock your other devices.
  let focusBreakUntil = 0;
  let breakTimer = null;
  const onBreak = () => Date.now() < focusBreakUntil;
  const active = () => settings.enabled && !onBreak();

  function setBreak(until) {
    focusBreakUntil = Number(until) || 0;
    clearTimeout(breakTimer);
    if (onBreak()) {
      breakTimer = setTimeout(endBreak, focusBreakUntil - Date.now() + 50);
    }
    if (settingsLoaded) {
      applyStyles();
      sendFilter();
      startFocusRetries();
    }
  }

  function endBreak() {
    applyStyles();
    sendFilter();
    startFocusRetries();
  }

  // -------------------------------------------------------------------------
  // Style application (presets + custom selectors)
  // -------------------------------------------------------------------------
  function buildCss() {
    if (!active()) return "";

    const groups = [];
    for (const key of Object.keys(PRESETS)) {
      if (settings[key]) groups.push(...PRESETS[key]);
    }
    for (const item of settings.customSelectors || []) {
      if (item && item.selector) groups.push(item.selector);
    }

    const hideCss = groups.length
      ? `${groups.join(",\n")} {\n  display: none !important;\n}`
      : "";
    return `${hideCss}\n${FILTER_CSS}`;
  }

  function applyStyles() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = buildCss();
  }

  // -------------------------------------------------------------------------
  // Chat filtering by name — forwarded to page.js
  //   - whitelist mode: show ONLY chats matching `whitelistChats`
  //   - chats matching `blockedChats` are always hidden (in both modes)
  // plus the "block other chats" guard, which page.js also runs.
  // -------------------------------------------------------------------------
  function sendFilter() {
    const clean = (list) =>
      (list || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean);
    const on = active();
    const allow = on && settings.whitelistMode ? clean(settings.whitelistChats) : [];
    const block = on ? clean(settings.blockedChats) : [];
    const guard = {
      on: on && !!settings.blockOtherChats,
      folder: settings.focusFolderMode ? settings.focusFolderName || "" : "",
      // Only for the countdown on the page; the break itself is `on`.
      breakUntil: settings.enabled ? focusBreakUntil : 0,
    };
    document.dispatchEvent(
      new CustomEvent("utg:filter", {
        detail: JSON.stringify({ allow, block, guard }),
      })
    );
  }

  document.addEventListener("utg:page-ready", () => {
    if (settingsLoaded) sendFilter();
  });

  // -------------------------------------------------------------------------
  // Focus folder: auto-open a native Telegram folder (e.g. "focus mode").
  // Telegram itself then shows only that folder's chats. Clicking works even
  // while the folder bar is hidden, so "Hide folder tabs" can stay on.
  // -------------------------------------------------------------------------
  const FOCUS_TICK_MS = 400;
  const FOCUS_GIVE_UP_MS = 20000;
  const FOCUS_STABLE_TICKS = 3; // active this many ticks in a row → done
  let focusTimer = null;

  const normLabel = (s) =>
    (s || "").replace(/\s+/g, " ").trim().toLowerCase();

  function findFocusTab(name) {
    for (const tab of document.querySelectorAll(
      "#folders-tabs .menu-horizontal-div-item"
    )) {
      const label = tab.querySelector(".text-super");
      if (label && normLabel(label.textContent) === name) return tab;
    }
    return null;
  }

  // Keep re-checking for a few seconds: Telegram restores the last-open folder
  // shortly after load, which can undo an early click.
  function startFocusRetries() {
    clearTimeout(focusTimer);
    if (!active() || !settings.focusFolderMode) return;
    const name = normLabel(settings.focusFolderName);
    if (!name) return;

    const started = Date.now();
    let stable = 0;
    const tick = () => {
      if (!active() || !settings.focusFolderMode) return;
      const tab = findFocusTab(name);
      if (tab && tab.classList.contains("active")) {
        if (++stable >= FOCUS_STABLE_TICKS) return; // settled on our folder
      } else {
        stable = 0;
        if (tab) tab.click();
      }
      if (Date.now() - started < FOCUS_GIVE_UP_MS) {
        focusTimer = setTimeout(tick, FOCUS_TICK_MS);
      }
    };
    tick();
  }

  // -------------------------------------------------------------------------
  // Element picker (click-to-hide) — the robust fallback for any element
  // -------------------------------------------------------------------------
  let picker = null;

  // Classes that make a poor selector: WebK's hashed CSS-module classes
  // (e.g. "_Item_5idej_1") change every build; state classes come and go.
  const UNSTABLE_CLASS =
    /^(_|utg-|is-|active$|rp$|hover-effect$|scrolled-|animate)/;

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id) return "#" + CSS.escape(el.id);

    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      if (node.id) {
        parts.unshift("#" + CSS.escape(node.id));
        break;
      }
      let sel = node.nodeName.toLowerCase();
      const classes = [...node.classList]
        .filter((c) => !UNSTABLE_CLASS.test(c))
        .slice(0, 2);
      if (classes.length) {
        sel += "." + classes.map((c) => CSS.escape(c)).join(".");
      }
      const parent = node.parentNode;
      if (parent) {
        const sameType = [...parent.children].filter(
          (s) => s.nodeName === node.nodeName
        );
        if (sameType.length > 1) {
          sel += `:nth-of-type(${sameType.indexOf(node) + 1})`;
        }
      }
      parts.unshift(sel);
      node = node.parentNode;
    }
    return parts.join(" > ");
  }

  // WebK reacts to pointerdown/mousedown (e.g. opening a chat), so swallow
  // those too while picking — not just the click.
  const SWALLOWED = ["pointerdown", "mousedown", "pointerup", "mouseup"];

  function stopPicker() {
    if (!picker) return;
    document.removeEventListener("mousemove", picker.onMove, true);
    document.removeEventListener("click", picker.onClick, true);
    document.removeEventListener("keydown", picker.onKey, true);
    for (const type of SWALLOWED) {
      document.removeEventListener(type, picker.swallow, true);
    }
    picker.overlay.remove();
    picker.banner.remove();
    picker = null;
  }

  function startPicker() {
    if (picker) return;

    const overlay = document.createElement("div");
    overlay.className = "utg-picker-overlay";
    Object.assign(overlay.style, {
      position: "fixed",
      zIndex: "2147483646",
      background: "rgba(51,144,236,0.35)",
      border: "2px solid #3390ec",
      pointerEvents: "none",
      borderRadius: "4px",
      transition: "all 40ms ease-out",
      display: "none",
    });

    const banner = document.createElement("div");
    banner.className = "utg-picker-banner";
    banner.textContent = "Click an element to hide it · Esc to cancel";
    Object.assign(banner.style, {
      position: "fixed",
      zIndex: "2147483647",
      top: "12px",
      left: "50%",
      transform: "translateX(-50%)",
      background: "#3390ec",
      color: "#fff",
      font: "13px/1.4 system-ui, sans-serif",
      padding: "8px 14px",
      borderRadius: "20px",
      boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
      pointerEvents: "none",
    });

    document.body.appendChild(overlay);
    document.body.appendChild(banner);

    let current = null;

    const onMove = (e) => {
      let el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === overlay || el === banner) return;
      // WebK lays an invisible ripple layer over buttons/rows; pick what's
      // underneath it instead.
      if (el.classList.contains("c-ripple") && el.parentElement) {
        el = el.parentElement;
      }
      // A chat row can't be hidden by selector (the virtual list recycles
      // rows and would leave a gap), so highlight the whole row and turn the
      // pick into a "hide chats by name" entry.
      el = el.closest("#folders-container a.chatlist-chat") || el;
      current = el;
      const r = el.getBoundingClientRect();
      overlay.style.display = "block";
      overlay.style.top = r.top + "px";
      overlay.style.left = r.left + "px";
      overlay.style.width = r.width + "px";
      overlay.style.height = r.height + "px";
    };

    const swallow = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };

    const onClick = (e) => {
      swallow(e);
      const el = current;
      stopPicker();
      if (!el) return;

      if (el.matches("a.chatlist-chat")) {
        const titleEl = el.querySelector(".peer-title");
        const title = titleEl ? titleEl.textContent.trim() : "";
        const blocked = settings.blockedChats || [];
        if (title && !blocked.includes(title)) {
          chrome.storage.sync.set({ blockedChats: [...blocked, title] });
        }
        return;
      }

      const selector = cssPath(el);
      if (!selector) return;
      const note = (el.textContent || el.className || el.nodeName)
        .trim()
        .slice(0, 40);
      const list = settings.customSelectors || [];
      if (!list.some((x) => x.selector === selector)) {
        list.push({ selector, note });
        chrome.storage.sync.set({ customSelectors: list });
      }
    };

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        stopPicker();
      }
    };

    picker = { overlay, banner, onMove, onClick, onKey, swallow };
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    for (const type of SWALLOWED) {
      document.addEventListener(type, swallow, true);
    }
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------
  chrome.storage.sync.get(DEFAULTS, (stored) => {
    settings = { ...DEFAULTS, ...stored };
    settingsLoaded = true;
    applyStyles(); // instant, even before body exists
    sendFilter();
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", startFocusRetries);
    } else {
      startFocusRetries();
    }
  });

  chrome.storage.local.get({ focusBreakUntil: 0 }, (stored) => {
    setBreak(stored.focusBreakUntil);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && "focusBreakUntil" in changes) {
      setBreak(changes.focusBreakUntil.newValue);
      return;
    }
    if (area !== "sync") return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      settings[key] = newValue === undefined ? DEFAULTS[key] : newValue;
    }
    applyStyles();
    sendFilter();
    if (
      "focusFolderMode" in changes ||
      "focusFolderName" in changes ||
      "enabled" in changes
    ) {
      startFocusRetries();
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "utg-start-picker") {
      startPicker();
      sendResponse({ ok: true });
    }
    return true;
  });
})();
