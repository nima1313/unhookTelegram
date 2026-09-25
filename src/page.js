/*
 * Unhook for Telegram — page-world chat filter (runs in WebK's MAIN world)
 *
 * WebK renders the dialog list as a *virtual* list: only the rows on screen
 * are mounted, each absolutely positioned at index * row height, and the list
 * height comes from the total dialog count. Hiding rows in the DOM therefore
 * leaves gaps and can never reach chats that aren't mounted.
 *
 * Instead we filter the data Telegram feeds into that list. Every folder list
 * pulls pages through `dialogsFetcher(offset, limit)` and accepts live updates
 * through `canUpdateDialog(dialog)`. While a name filter is active we wrap
 * both: the fetcher scans the whole dialog list once and serves its pages out
 * of the matching chats only, so Telegram itself renders a gap-free list.
 *
 * It also loads every chat of the focus folder (WebK skips folder chats it
 * hasn't cached) and runs the "block other chats" guard, which covers any
 * open chat that isn't part of the focus set (see below).
 *
 * Config arrives from content.js as a `utg:filter` CustomEvent on document.
 */

(() => {
  "use strict";

  const POLL_MS = 50;
  const POLL_MAX_MS = 60000;
  const PAGE_SIZE = 100;
  const SCAN_CAP = 3000; // stop scanning huge accounts after this many dialogs
  const LOADING_MAX_MS = 8000; // never keep the list hidden longer than this

  // allow: whitelist terms (empty = no whitelist); block: always-hidden terms.
  let config = { allow: [], block: [] };
  let configKey = JSON.stringify(config);
  let patched = false;

  const filtering = () => config.allow.length > 0 || config.block.length > 0;

  // ---- Titles ---------------------------------------------------------------
  function peerTitle(peerId) {
    const proxy = window.apiManagerProxy;
    const peer = proxy && proxy.getPeer ? proxy.getPeer(peerId) : null;
    let title = "";
    if (peer) {
      title =
        peer.title || [peer.first_name, peer.last_name].filter(Boolean).join(" ");
    }
    const myId = window.rootScope && window.rootScope.myId;
    if (myId !== undefined && String(peerId) === String(myId)) {
      title += " saved messages";
    }
    return title.toLowerCase();
  }

  function allowed(peerId) {
    if (!filtering()) return true;
    const title = peerTitle(peerId);
    const hit = (terms) => terms.some((t) => title.includes(t));
    if (config.allow.length && !hit(config.allow)) return false;
    return !hit(config.block);
  }

  // ---- Patching ---------------------------------------------------------------
  // The prototype deepest in the chain that owns `name` — the base class, so
  // every folder list subclass (and its `super` calls) goes through our wrap.
  function baseOwner(obj, name) {
    let owner = null;
    for (let p = Object.getPrototypeOf(obj); p && p !== Object.prototype; ) {
      if (Object.prototype.hasOwnProperty.call(p, name)) owner = p;
      p = Object.getPrototypeOf(p);
    }
    return owner;
  }

  // Scan a folder's whole dialog list (up to SCAN_CAP) and keep the matches,
  // in Telegram's order (index descending).
  async function scanMatches(list, origFetch) {
    const matches = [];
    let cursor;
    let scanned = 0;
    while (true) {
      const res = await origFetch.call(list, cursor, PAGE_SIZE);
      const page = (res && res.dialogs) || [];
      scanned += page.length;
      for (const d of page) if (allowed(d.peerId)) matches.push(d);
      if (!res || res.isEnd || !page.length || scanned >= SCAN_CAP) break;
      const next = Math.min(
        ...page.map((d) => d[list.indexKey]).filter((v) => v !== undefined)
      );
      if (!Number.isFinite(next) || next === cursor) break;
      cursor = next;
    }
    return matches;
  }

  // One scan per list + config, reused for every page Telegram asks for. The
  // virtual list drops far-away items and re-fetches them by cursor, so pages
  // must be consistent slices of the same filtered list. Dialog order changes
  // as messages arrive, hence the short lifetime.
  const CACHE_MS = 30000;
  let scans = new WeakMap(); // list -> { key, at, promise }

  function filteredDialogs(list, origFetch) {
    const hit = scans.get(list);
    if (hit && hit.key === configKey && Date.now() - hit.at < CACHE_MS) {
      return hit.promise;
    }
    const promise = scanMatches(list, origFetch);
    const entry = { key: configKey, at: Date.now(), promise };
    scans.set(list, entry);
    promise.catch(() => {
      if (scans.get(list) === entry) scans.delete(list);
    });
    return promise;
  }

  function patch(xd) {
    const fetchOwner = baseOwner(xd, "dialogsFetcher");
    const updateOwner = baseOwner(xd, "canUpdateDialog");
    if (!fetchOwner || !updateOwner) return false;

    const origFetch = fetchOwner.dialogsFetcher;
    fetchOwner.dialogsFetcher = async function (offsetIndex, limit) {
      if (!filtering()) return origFetch.call(this, offsetIndex, limit);

      // Serve a normal page (dialogs after the cursor), but out of the
      // filtered list and with its size as the total — so Telegram's virtual
      // list sizes and paginates exactly as if only the matches existed.
      const all = await filteredDialogs(this, origFetch);
      let from = 0;
      if (offsetIndex != null) {
        from = all.findIndex((d) => d[this.indexKey] < offsetIndex);
        if (from === -1) from = all.length;
      }
      const to = from + (limit || PAGE_SIZE);
      return {
        dialogs: all.slice(from, to),
        count: all.length,
        isTopEnd: from === 0,
        isEnd: to >= all.length,
      };
    };

    const origCanUpdate = updateOwner.canUpdateDialog;
    updateOwner.canUpdateDialog = function (dialog) {
      if (dialog && !allowed(dialog.peerId)) return false;
      return origCanUpdate.call(this, dialog);
    };

    return true;
  }

  // Rebuild the dialog lists with the current config. The visible list reloads
  // right away; the others are just cleared and reload when their tab opens.
  function refreshLists() {
    const dm = window.appDialogsManager;
    if (!dm || !dm.xds) return;
    for (const xd of Object.values(dm.xds)) {
      if (!xd || xd === dm.xd) continue;
      try {
        xd.reset();
        xd.clear();
      } catch (e) {
        console.warn("[Unhook for Telegram] could not clear a list", e);
      }
    }
    if (!dm.xd) return;
    Promise.resolve()
      .then(() => dm.xd.fullReset())
      .catch((e) => console.warn("[Unhook for Telegram] list reload failed", e))
      .finally(() => setLoading(false));
  }

  // ---- Page flags (read by content.js's CSS) ----------------------------------
  let loadingTimer = null;
  function setLoading(on) {
    const root = document.documentElement;
    clearTimeout(loadingTimer);
    if (on) {
      root.dataset.utgLoading = "1";
      loadingTimer = setTimeout(() => setLoading(false), LOADING_MAX_MS);
    } else {
      delete root.dataset.utgLoading;
    }
  }

  function setFilteringFlag() {
    const root = document.documentElement;
    if (filtering()) root.dataset.utgFiltering = "1";
    else delete root.dataset.utgFiltering;
  }

  // ---- Block other chats ------------------------------------------------------
  // The list filters only shape the LEFT list; Telegram still opens any chat
  // you reach another way (a channel link in a message, a mention, search).
  // When "block other chats" is on, we check the open chat against Telegram's
  // own data and cover the conversation if it isn't part of the focus set:
  //   - in the focus folder (when "Focus folder" is on), or
  //   - matching a whitelist term (when whitelist mode is on),
  //   - and never matching a blocked name.
  // With neither a focus folder nor a whitelist, only blocked names are blocked.
  const GUARD_ID = "utg-guard";
  const GUARD_TICK_MS = 100;
  let guard = { on: false, folder: "" };
  let guardPeer = null; // peer the current verdict is for
  let guardToken = 0; // discards stale async verdicts

  function openPeerId() {
    const im = window.appImManager;
    return (im && im.chat && im.chat.peerId) || 0;
  }

  // The folder whose tab label is `name`: its filter (explicit chat list) and
  // dialog index key (e.g. "index_5" — a dialog belongs to the folder exactly
  // when it has a value under that key). Null if there's no such tab yet.
  async function findFolder(name) {
    const tab = [
      ...document.querySelectorAll("#folders-tabs .menu-horizontal-div-item"),
    ].find((t) => {
      const label = t.querySelector(".text-super");
      return label && label.textContent.replace(/\s+/g, " ").trim().toLowerCase() === name;
    });
    const dm = window.appDialogsManager;
    if (!tab || !dm || !dm.managers) return null;
    const filter = await dm.managers.filtersStorage.getFilter(Number(tab.dataset.filterId));
    if (!filter || filter.localId === undefined) return null;
    return { filter, key: `index_${filter.localId}` };
  }

  // ---- Focus folder: load all of its chats ------------------------------------
  // WebK lists a folder's chats only if their dialogs are already in its local
  // cache, and never fetches the rest — so older chats added to the folder
  // silently never show up. Load those dialogs explicitly; WebK then adds
  // them to the folder list by itself.
  let hydrated = ""; // folder name already loaded this page session
  let hydrating = false;

  async function hydrateFolder(name) {
    const folder = await findFolder(name);
    if (!folder) return null; // tabs not rendered yet — retry later
    const { filter } = folder;
    const mm = window.appDialogsManager.managers.appMessagesManager;
    const ids = [...(filter.pinnedPeerIds || []), ...(filter.includePeerIds || [])];
    const inputs = [...(filter.pinned_peers || []), ...(filter.include_peers || [])];
    const missing = [];
    for (let i = 0; i < ids.length; i++) {
      if (inputs[i] && !(await mm.getDialogOnly(ids[i]))) missing.push(inputs[i]);
    }
    // The input peers carry access hashes, so this works even for chats WebK
    // has never seen.
    await Promise.all(missing.map((p) => mm.reloadConversation(p).catch(() => {})));
    return { loaded: missing.length };
  }

  function maybeHydrate() {
    const name = guard.folder;
    if (!name || name === hydrated || hydrating || !window.appDialogsManager) return;
    hydrating = true;
    hydrateFolder(name)
      .then((done) => {
        if (!done) return;
        hydrated = name;
        // A name-filtered list serves a cached scan — rebuild it to include
        // the chats that were just loaded.
        if (done.loaded && patched && filtering()) {
          scans = new WeakMap();
          refreshLists();
        }
      })
      .catch((e) => console.warn("[Unhook for Telegram] could not load folder chats", e))
      .finally(() => {
        hydrating = false;
      });
  }

  setInterval(maybeHydrate, 500);

  async function guardAllows(peerId) {
    const title = peerTitle(peerId);
    const hit = (terms) => terms.some((t) => title.includes(t));
    if (hit(config.block)) return false;

    const checks = [];
    if (guard.folder) {
      const folder = await findFolder(guard.folder);
      // Folder not found (renamed / not loaded yet) → fail open.
      if (!folder) return true;
      const { filter, key } = folder;
      checks.push(async () => {
        const listed = [...(filter.pinnedPeerIds || []), ...(filter.includePeerIds || [])];
        if (listed.some((id) => String(id) === String(peerId))) return true;
        const dialog = await window.appDialogsManager.managers.appMessagesManager.getDialogOnly(
          peerId
        );
        return !!dialog && dialog[key] !== undefined;
      });
    }
    if (config.allow.length) checks.push(async () => hit(config.allow));
    if (!checks.length) return true;
    for (const check of checks) if (await check()) return true;
    return false;
  }

  function guardTarget() {
    // The open chat's message area matches the visible conversation exactly.
    // (#column-center itself extends under the left column.)
    return document.querySelector("#column-center .chat.active .bubbles");
  }

  function positionGuard(ov) {
    const target = guardTarget();
    const r = target
      ? target.getBoundingClientRect()
      : { top: 0, left: 0, width: innerWidth, height: innerHeight };
    Object.assign(ov.style, {
      top: r.top + "px",
      left: r.left + "px",
      width: r.width + "px",
      height: r.height + "px",
    });
  }

  function showGuard() {
    let ov = document.getElementById(GUARD_ID);
    if (!ov) {
      ov = document.createElement("div");
      ov.id = GUARD_ID;
      Object.assign(ov.style, {
        position: "fixed",
        zIndex: "2147483000",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(24,34,45,0.92)",
        backdropFilter: "blur(8px)",
        color: "#fff",
        font: "15px/1.5 system-ui, -apple-system, sans-serif",
        textAlign: "center",
      });
      const box = document.createElement("div");
      box.style.maxWidth = "320px";
      box.style.padding = "24px";
      const icon = document.createElement("div");
      icon.textContent = "🔒";
      Object.assign(icon.style, { fontSize: "34px", marginBottom: "10px" });
      const title = document.createElement("div");
      title.textContent = "Hidden by Focus Mode";
      Object.assign(title.style, { fontWeight: "600", marginBottom: "6px" });
      const sub = document.createElement("div");
      sub.textContent = "This chat isn't in your focus list.";
      Object.assign(sub.style, { opacity: "0.75", marginBottom: "16px" });
      const btn = document.createElement("button");
      btn.textContent = "← Back to focus";
      Object.assign(btn.style, {
        background: "#3390ec",
        color: "#fff",
        border: "none",
        borderRadius: "20px",
        padding: "9px 18px",
        font: "14px system-ui, sans-serif",
        cursor: "pointer",
      });
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideGuard();
        window.appImManager.setPeer({ peerId: 0 }); // close the chat
      });
      box.append(icon, title, sub, btn);
      ov.appendChild(box);
      document.body.appendChild(ov);
    }
    positionGuard(ov);
  }

  function hideGuard() {
    const ov = document.getElementById(GUARD_ID);
    if (ov) ov.remove();
  }

  // Re-evaluate when the open chat changes (or `force` after a config change).
  function checkGuard(force) {
    const peerId = guard.on ? openPeerId() : 0;
    if (!peerId) {
      guardPeer = null;
      guardToken++;
      hideGuard();
      return;
    }
    if (!force && peerId === guardPeer) {
      const ov = document.getElementById(GUARD_ID);
      if (ov) positionGuard(ov); // follow layout changes
      return;
    }
    guardPeer = peerId;
    const token = ++guardToken;
    guardAllows(peerId)
      .catch(() => true) // on internal errors, never trap the user
      .then((ok) => {
        if (token !== guardToken) return;
        if (ok) hideGuard();
        else showGuard();
      });
  }

  setInterval(() => {
    if (guard.on && window.appImManager) checkGuard(false);
  }, GUARD_TICK_MS);

  // ---- Config channel -------------------------------------------------------
  document.addEventListener("utg:filter", (e) => {
    let next;
    try {
      next = JSON.parse(e.detail);
    } catch (_) {
      return;
    }
    const clean = (list) =>
      (Array.isArray(list) ? list : [])
        .map((t) => String(t).trim().toLowerCase())
        .filter(Boolean);
    const allow = clean(next && next.allow);
    const block = clean(next && next.block);

    const g = (next && next.guard) || {};
    guard = { on: !!g.on, folder: String(g.folder || "").trim().toLowerCase() };
    checkGuard(true);

    const key = JSON.stringify({ allow, block });
    if (key === configKey) return;

    const wasFiltering = filtering();
    config = { allow, block };
    configKey = key;
    setFilteringFlag();

    if (!wasFiltering && !filtering()) return; // still off — nothing to redo
    if (patched) {
      refreshLists();
    } else if (filtering()) {
      // Hide the unfiltered list until the patch lands and it reloads.
      setLoading(true);
    }
  });

  // ---- Boot -----------------------------------------------------------------
  const started = Date.now();
  const poll = setInterval(() => {
    const dm = window.appDialogsManager;
    if (dm && dm.xd && window.apiManagerProxy) {
      clearInterval(poll);
      patched = patch(dm.xd);
      if (!patched) {
        console.warn(
          "[Unhook for Telegram] WebK internals changed — name filtering is unavailable."
        );
        setLoading(false);
        return;
      }
      if (filtering()) refreshLists();
    } else if (Date.now() - started > POLL_MAX_MS) {
      clearInterval(poll);
      setLoading(false);
    }
  }, POLL_MS);

  // Ask content.js for the current config (covers either script loading first).
  document.dispatchEvent(new CustomEvent("utg:page-ready"));
})();
