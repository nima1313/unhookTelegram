/*
 * Unhook for Telegram — content script
 *
 * Strategy:
 *  - Telegram Web ships two clients: WebK (web.telegram.org/k/) and
 *    WebA (web.telegram.org/a/). They use different DOM/class names, so each
 *    preset targets BOTH with a list of candidate selectors. Selectors that
 *    don't match anything are harmless.
 *  - Presets + custom picked selectors are applied purely with CSS (injected
 *    <style>), which is instant and flicker-free.
 *  - "Hide chats by name" can't be done in CSS (no text matching), so it runs
 *    as a JS pass driven by a debounced MutationObserver.
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
    enabled: true,
  };

  // ---- Best-effort preset selectors (WebK + WebA) --------------------------
  // Grouped generously; a superset is fine because non-matching selectors do
  // nothing. If Telegram renames something, use the element picker as a fallback.
  // Note: hideSearch is handled in JS (findLeftSearchInput) because CSS can
  // only reliably hit the <input>, which leaves the rounded wrapper visible.
  const PRESETS = {
    hideFolders: [
      // WebK
      "#folders-container",
      ".folders-tabs-scrollable",
      ".folders-tabs",
      ".chatlist-parts .menu-horizontal-scrollable",
      // WebA
      ".ChatFolders .TabList",
      "#LeftColumn .TabList",
    ],
    hideChatList: [
      // WebK
      "#chatlist-container",
      ".chatlist-container",
      "#column-left .chatlist",
      // WebA
      ".chat-list",
      "#LeftColumn .ChatList",
    ],
    hideStories: [
      // WebK
      ".stories-list",
      "#stories-container",
      // WebA
      ".StoryRibbon",
      ".StoryToggler",
    ],
    hideSettings: [
      // WebA — the top-left hamburger that opens the settings menu
      "#LeftMainHeader .DropdownMenu",
      "#LeftColumn .DropdownMenu.main-menu",
      // WebK
      ".sidebar-header .btn-menu-toggle",
      "#column-left .sidebar-header .btn-menu",
    ],
    hideNewChat: [
      // WebA — the floating pencil / new-message button
      ".NewChatButton",
      "#LeftColumn .FloatingActionButton",
      // WebK
      "#new-menu",
      ".btn-corner",
    ],
  };

  // Candidate selectors used by the "hide chats by name" pass.
  const CHAT_ITEM_SELECTORS = [
    "a.chatlist-chat",
    ".chatlist-chat",
    "li.chatlist-chat",
    ".ListItem.Chat",
    ".chat-item-clickable",
  ];
  const CHAT_TITLE_SELECTORS = [
    ".peer-title",
    ".user-title",
    ".info .title",
    ".ChatInfo .title",
    ".title span",
  ];

  // Folder / category tabs, for the "open my focus folder" feature.
  const FOLDER_TAB_SELECTORS = [
    // WebK
    ".folders-tabs-scrollable .menu-horizontal-div-item",
    "#folders-container .menu-horizontal-div-item",
    ".menu-horizontal-div-item",
    // WebA
    ".ChatFolders .Tab",
    ".TabList .Tab",
    ".Tab",
    "[role='tab']",
  ];

  let settings = { ...DEFAULTS };

  // Chat-list containers we may re-stack when filtering hides items.
  const CHATLIST_CONTAINERS =
    "ul.chatlist, .chatlist, .chat-list, .ChatList";

  // Telegram positions each chat with an absolute transform:translateY(). When
  // we hide some, the survivors keep their offsets and leave gaps. This class,
  // toggled onto the list while filtering, collapses them back to normal flow.
  const REFLOW_CSS = `
.utg-reflow {
  height: auto !important;
  min-height: 0 !important;
}
.utg-reflow > *,
.utg-reflow a.chatlist-chat,
.utg-reflow li.chatlist-chat,
.utg-reflow .chatlist-chat,
.utg-reflow .ListItem.Chat {
  position: relative !important;
  transform: none !important;
  top: auto !important;
  left: auto !important;
}`;

  // -------------------------------------------------------------------------
  // Style application (presets + custom selectors)
  // -------------------------------------------------------------------------
  function buildCss() {
    if (!settings.enabled) return "";

    const groups = [];

    for (const key of Object.keys(PRESETS)) {
      if (!settings[key]) continue;
      // Don't hide the folder bar until the focus-folder click has landed —
      // clicking a display:none tab can't switch folders.
      if (key === "hideFolders" && settings.focusFolderMode && !focusClicked) {
        continue;
      }
      groups.push(...PRESETS[key]);
    }

    for (const item of settings.customSelectors || []) {
      if (item && item.selector) groups.push(item.selector);
    }

    const hideCss = groups.length
      ? `${groups.join(",\n")} {\n  display: none !important;\n}`
      : "";

    // Reflow rules are always present but only bite when .utg-reflow is set.
    return `${hideCss}\n${REFLOW_CSS}`;
  }

  function updateReflow(active) {
    document.querySelectorAll(CHATLIST_CONTAINERS).forEach((el) => {
      el.classList.toggle("utg-reflow", active);
    });
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
  // Chat filtering by name (JS, text-based)
  //   - blacklist mode (default): hide chats matching `blockedChats`
  //   - whitelist mode: show ONLY chats matching `whitelistChats`
  // -------------------------------------------------------------------------
  function chatTitle(item) {
    let titleEl = null;
    for (const sel of CHAT_TITLE_SELECTORS) {
      titleEl = item.querySelector(sel);
      if (titleEl) break;
    }
    return (titleEl ? titleEl.textContent : item.textContent)
      .trim()
      .toLowerCase();
  }

  function restoreChat(item) {
    if (item.dataset.utgHidden === "1") {
      item.style.display = "";
      delete item.dataset.utgHidden;
    }
  }

  // -------------------------------------------------------------------------
  // Preload: Telegram loads the dialog list in pages as you scroll. To filter
  // the WHOLE list (not just what's on screen) we scroll the list to the
  // bottom once, forcing every dialog to load into the DOM, then filter.
  // On WebK loaded rows stay in the DOM, so this is a reliable one-time pass.
  // -------------------------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Only scan the most-recent N chats. Filtering the entire (possibly huge)
  // dialog list is slow and rarely needed — the top chats are what matter.
  const SCAN_LIMIT = 200;
  let preloadDone = false;
  let preloading = false;

  function scrollParent(el) {
    let node = el;
    while (node && node !== document.body) {
      const s = getComputedStyle(node);
      if (
        /(auto|scroll)/.test(s.overflowY) &&
        node.scrollHeight > node.clientHeight + 4
      ) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  // The scroll container of the folder the user is actually looking at.
  // WebK renders one .chatlist per folder tab; only the active one is visible.
  function activeScroller() {
    const lists = [...document.querySelectorAll(CHATLIST_CONTAINERS)].filter(
      (el) => el.offsetParent !== null && el.clientHeight > 0
    );
    for (const el of lists) {
      const sp = scrollParent(el);
      if (sp) return sp;
    }
    return null;
  }

  function loadedCount(scroller) {
    return scroller.querySelectorAll(CHAT_ITEM_SELECTORS.join(",")).length;
  }

  // WebK virtualizes long lists: rows scrolled out of view are unmounted from
  // the DOM. We defeat that by forcing the scroll viewport tall enough that
  // Telegram treats every loaded row as "on screen" and keeps it mounted.
  const ROW_PX = 84;
  let expandedScroller = null;
  let savedHeight = "";

  function expandViewport(scroller, rows) {
    if (expandedScroller && expandedScroller !== scroller) restoreViewport();
    if (!expandedScroller) {
      expandedScroller = scroller;
      savedHeight = scroller.style.height;
    }
    scroller.style.height = Math.max(rows, 20) * ROW_PX + "px";
  }

  function restoreViewport() {
    if (expandedScroller) {
      expandedScroller.style.height = savedHeight;
      expandedScroller = null;
      savedHeight = "";
    }
  }

  // Load the active folder's list (up to SCAN_LIMIT) AND keep every row mounted
  // by growing the viewport as we go. MUST run with nothing hidden.
  async function preloadChats() {
    const scroller = activeScroller();
    if (!scroller) return;

    let last = -1;
    let stable = 0;
    for (let i = 0; i < 60; i++) {
      const count = loadedCount(scroller);
      if (count >= SCAN_LIMIT) break;
      // Viewport a bit taller than what's loaded → pulls in the next page and
      // keeps the already-loaded rows mounted.
      expandViewport(scroller, Math.min(count + 40, SCAN_LIMIT + 40));
      scroller.scrollTop = scroller.scrollHeight;
      await sleep(260);
      if (count === last) {
        if (++stable >= 4) break; // no growth → reached the end of the list
      } else {
        stable = 0;
        last = count;
      }
    }
    // Keep the viewport tall enough to hold every loaded row mounted, then
    // return to the top for the filtered view.
    expandViewport(scroller, loadedCount(scroller) + 6);
    scroller.scrollTop = 0;
  }

  function applyChatFilter() {
    const block = (settings.blockedChats || [])
      .map((t) => String(t).trim().toLowerCase())
      .filter(Boolean);
    const allow = (settings.whitelistChats || [])
      .map((t) => String(t).trim().toLowerCase())
      .filter(Boolean);

    const useWhitelist =
      settings.enabled && settings.whitelistMode && allow.length > 0;
    const useBlacklist =
      settings.enabled && !settings.whitelistMode && block.length > 0;
    const filtering = useWhitelist || useBlacklist;

    const items = document.querySelectorAll(CHAT_ITEM_SELECTORS.join(","));

    // Not filtering → undo everything and hand the list back to Telegram.
    if (!filtering) {
      updateReflow(false);
      restoreViewport();
      items.forEach(restoreChat);
      return;
    }

    // Phase 1 — load the whole (top-N) list first, keeping every chat visible
    // and un-reflowed so the list stays tall enough to scroll & keep rows
    // mounted. Hiding here would collapse it.
    if (!preloadDone) {
      if (!preloading) {
        preloading = true;
        preloadChats().finally(() => {
          preloading = false;
          preloadDone = true;
          applyAll(); // everything is now loaded & mounted → hide + reflow
        });
      }
      updateReflow(false);
      items.forEach(restoreChat);
      return;
    }

    // Phase 2 — filter the fully-loaded, still-mounted list.
    updateReflow(true);

    items.forEach((item) => {
      const name = chatTitle(item);
      const hide = useWhitelist
        ? !allow.some((t) => name.includes(t))
        : block.some((t) => name.includes(t));

      if (hide) {
        item.style.display = "none";
        item.dataset.utgHidden = "1";
      } else {
        restoreChat(item);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Focus folder: auto-open a native Telegram folder (e.g. "focus mode").
  // This sidesteps virtualization entirely — Telegram itself shows only that
  // folder's chats. The tab is clicked even if the folder bar is hidden.
  // -------------------------------------------------------------------------
  let focusTimer = null;
  let focusClicked = false; // has the focus-folder click landed at least once?

  const normLabel = (s) =>
    (s || "").replace(/\s+/g, " ").trim().toLowerCase();

  // Normalized label with a trailing unread count stripped ("focus mode 3").
  const baseLabel = (s) => normLabel(s).replace(/\s*\d+$/, "").trim();

  // Fire a full pointer+mouse sequence — some WebK builds switch folders on
  // mousedown/pointer events, not a bare click().
  function fireClick(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    const types = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
    for (const type of types) {
      const Ctor =
        type.startsWith("pointer") && window.PointerEvent
          ? PointerEvent
          : MouseEvent;
      try {
        el.dispatchEvent(new Ctor(type, opts));
      } catch (_) {
        /* ignore unsupported event types */
      }
    }
  }

  function findFocusTab(name) {
    const matches = [];

    // 1) Known folder-tab selectors.
    for (const el of document.querySelectorAll(FOLDER_TAB_SELECTORS.join(","))) {
      if (baseLabel(el.textContent) === name) matches.push(el);
    }
    // 2) Fallback: any small, visible element whose label matches.
    if (!matches.length) {
      for (const el of document.querySelectorAll("div,span,a,li,button")) {
        if (el.getElementsByTagName("*").length > 8) continue;
        if (baseLabel(el.textContent) === name) matches.push(el);
      }
    }

    // Pick the smallest visible match (the tab itself, not a wrapper).
    let best = null;
    let bestArea = Infinity;
    for (const el of matches) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const area = r.width * r.height;
      if (area < bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  }

  // WebA (React) puts the click handler on an ancestor, not the text node.
  // Climb to the nearest clickable ancestor (cursor:pointer / role=tab / <a>).
  function clickableAncestor(el) {
    let node = el;
    for (let i = 0; i < 6 && node; i++) {
      if (
        node.tagName === "A" ||
        node.tagName === "BUTTON" ||
        node.getAttribute("role") === "tab" ||
        getComputedStyle(node).cursor === "pointer"
      ) {
        return node;
      }
      node = node.parentElement;
    }
    return el;
  }

  function clickFocusOnce() {
    if (!settings.enabled || !settings.focusFolderMode) return false;
    const name = baseLabel(settings.focusFolderName);
    if (!name) return false;
    const tab = findFocusTab(name);
    if (!tab) return false;
    fireClick(clickableAncestor(tab));
    return true;
  }

  // Retry the click across the first few seconds of load. This beats two race
  // conditions: (1) React hasn't attached its handlers yet, and (2) Telegram
  // restores the last-open folder ("All") shortly after we click. We stop once
  // we've clicked a few times after the tab appeared, so we don't fight the
  // user later on.
  function startFocusRetries() {
    clearTimeout(focusTimer);
    // Reset: keep the folder bar visible again while we (re)attempt the click.
    focusClicked = false;
    applyStyles();
    if (!settings.enabled || !settings.focusFolderMode) return;

    let attempts = 0;
    let clickedTimes = 0;
    const tick = () => {
      if (!settings.enabled || !settings.focusFolderMode) return;
      if (clickFocusOnce()) clickedTimes++;
      attempts++;
      // Keep the bar visible & keep clicking until several clicks land (beats
      // Telegram restoring "All") or we give up after ~9s.
      if (clickedTimes < 4 && attempts < 20) {
        focusTimer = setTimeout(tick, 450);
      } else if (clickedTimes > 0) {
        // Switched successfully → now it's safe to hide the folder bar.
        focusClicked = true;
        applyStyles();
      }
    };
    tick();
  }

  // -------------------------------------------------------------------------
  // Hide the left-column search bar (JS — hides the wrapper, not just <input>)
  // -------------------------------------------------------------------------
  const SEARCH_HINT = /search|جستجو|جست‌وجو|поиск|искать/i;
  let hiddenSearchEl = null;

  function findLeftSearchInput() {
    const roots = ["#column-left", "#LeftColumn"];
    for (const sel of roots) {
      const root = document.querySelector(sel);
      if (!root) continue;
      const inputs = [...root.querySelectorAll("input")];
      // Prefer an input that clearly is the search field.
      const match = inputs.find((inp) => {
        const meta =
          (inp.getAttribute("placeholder") || "") +
          " " +
          (inp.getAttribute("aria-label") || "") +
          " " +
          (inp.className || "") +
          " " +
          (inp.id || "");
        return inp.type === "search" || SEARCH_HINT.test(meta);
      });
      if (match) return match;
      // Fallback: first text input in the column (usually the search box).
      const fallback = root.querySelector(
        "input[type='text'], input:not([type])"
      );
      if (fallback) return fallback;
    }
    return null;
  }

  function applySearchHide() {
    // Reset previous hide first.
    if (hiddenSearchEl) {
      hiddenSearchEl.style.display = "";
      delete hiddenSearchEl.dataset.utgSearch;
      hiddenSearchEl = null;
    }
    if (!settings.enabled || !settings.hideSearch) return;

    const input = findLeftSearchInput();
    if (!input) return;

    // Hide the rounded wrapper around the input, but never a container that
    // also holds the hamburger/menu button (that would remove navigation).
    let target = input;
    const parent = input.parentElement;
    if (
      parent &&
      !parent.querySelector("button") &&
      parent.children.length <= 8
    ) {
      target = parent;
    }
    target.style.display = "none";
    target.dataset.utgSearch = "1";
    hiddenSearchEl = target;
  }

  // -------------------------------------------------------------------------
  // Observe the SPA so rules survive re-renders / navigation
  // -------------------------------------------------------------------------
  let scheduled = false;
  function scheduleApply() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      applyChatFilter();
      applySearchHide();
    });
  }

  function startObserver() {
    const observer = new MutationObserver(scheduleApply);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  // -------------------------------------------------------------------------
  // Element picker (click-to-hide) — the robust fallback for any element
  // -------------------------------------------------------------------------
  let picker = null;

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
        .filter((c) => !c.startsWith("utg-"))
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

  function stopPicker() {
    if (!picker) return;
    document.removeEventListener("mousemove", picker.onMove, true);
    document.removeEventListener("click", picker.onClick, true);
    document.removeEventListener("keydown", picker.onKey, true);
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
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === overlay || el === banner) return;
      current = el;
      const r = el.getBoundingClientRect();
      overlay.style.display = "block";
      overlay.style.top = r.top + "px";
      overlay.style.left = r.left + "px";
      overlay.style.width = r.width + "px";
      overlay.style.height = r.height + "px";
    };

    const onClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const el = current;
      stopPicker();
      if (!el) return;
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

    picker = { overlay, banner, onMove, onClick, onKey };
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------
  function applyAll() {
    applyStyles();
    applyChatFilter();
    applySearchHide();
  }

  chrome.storage.sync.get(DEFAULTS, (stored) => {
    settings = { ...DEFAULTS, ...stored };
    applyStyles(); // instant, even before body exists
    const boot = () => {
      applyAll();
      startObserver();
      startFocusRetries();
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot);
    } else {
      boot();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      settings[key] = newValue;
    }
    // Membership/settings changed → rescan the list.
    preloadDone = false;
    applyAll();
    // Re-open the focus folder if that setting was just changed/toggled.
    if ("focusFolderMode" in changes || "focusFolderName" in changes) {
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
