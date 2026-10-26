/* Unhook for Telegram — popup controller */

const DEFAULTS = {
  enabled: true,
  hideSearch: false,
  hideFolders: false,
  hideStories: false,
  hideChatList: false,
  hideSettings: false,
  hideNewChat: false,
  customSelectors: [],
  blockedChats: [],
  whitelistMode: false,
  whitelistChats: [],
  focusFolderMode: false,
  focusFolderName: "focus mode",
  blockOtherChats: false,
};

const TOGGLES = [
  "enabled",
  "hideSearch",
  "hideFolders",
  "hideStories",
  "hideChatList",
  "hideSettings",
  "hideNewChat",
  "whitelistMode",
  "focusFolderMode",
  "blockOtherChats",
];

let state = { ...DEFAULTS };

function save(patch) {
  Object.assign(state, patch);
  chrome.storage.sync.set(patch);
}

// ---- Render -----------------------------------------------------------------
function render() {
  TOGGLES.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.checked = !!state[id];
  });
  const folderInput = document.getElementById("focusFolderName");
  if (folderInput && document.activeElement !== folderInput) {
    folderInput.value = state.focusFolderName || "";
  }
  renderChips("blockList", "blockedChats", "No blocked names yet.");
  renderChips("allowList", "whitelistChats", "No whitelisted names yet.");
  renderCustom();
  renderBreak();
}

// ---- Focus break --------------------------------------------------------------
const BREAK_MS = 60 * 1000;
let breakUntil = 0;
let breakTimer = null;

// Pauses the whole extension (see content.js), so it needs the extension on.
// During a break it turns into the countdown.
function renderBreak() {
  const btn = document.getElementById("breakBtn");
  const status = document.getElementById("breakStatus");
  const left = Math.ceil((breakUntil - Date.now()) / 1000);
  const locking = state.enabled;
  clearTimeout(breakTimer);
  if (left > 0 && locking) {
    btn.disabled = true;
    btn.textContent = `Unlocked — focus back in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    status.hidden = true;
    breakTimer = setTimeout(renderBreak, 250);
    return;
  }
  btn.textContent = "Unlock for 1 minute";
  btn.disabled = !locking;
  status.hidden = locking;
  status.textContent = "Turn Unhook on (the switch at the top) to use this.";
}

function wireBreak() {
  document.getElementById("breakBtn").addEventListener("click", () => {
    breakUntil = Date.now() + BREAK_MS;
    chrome.storage.local.set({ focusBreakUntil: breakUntil });
    renderBreak();
  });
}

function renderChips(listId, key, emptyMsg) {
  const ul = document.getElementById(listId);
  ul.innerHTML = "";
  if (!state[key].length) {
    ul.innerHTML = `<span class="empty">${emptyMsg}</span>`;
    return;
  }
  state[key].forEach((name, i) => {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = name;
    const btn = document.createElement("button");
    btn.textContent = "×";
    btn.title = "Remove";
    btn.addEventListener("click", () => {
      const next = state[key].slice();
      next.splice(i, 1);
      save({ [key]: next });
      renderChips(listId, key, emptyMsg);
    });
    li.append(span, btn);
    ul.appendChild(li);
  });
}

function renderCustom() {
  const ul = document.getElementById("customList");
  ul.innerHTML = "";
  if (!state.customSelectors.length) {
    ul.innerHTML = '<li class="empty">Nothing picked yet.</li>';
    return;
  }
  state.customSelectors.forEach((item, i) => {
    const li = document.createElement("li");

    const meta = document.createElement("div");
    meta.className = "meta";
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = item.note || "(element)";
    const sel = document.createElement("div");
    sel.className = "sel";
    sel.textContent = item.selector;
    sel.title = item.selector;
    meta.append(note, sel);

    const btn = document.createElement("button");
    btn.textContent = "×";
    btn.title = "Unhide / remove";
    btn.addEventListener("click", () => {
      const next = state.customSelectors.slice();
      next.splice(i, 1);
      save({ customSelectors: next });
      renderCustom();
    });

    li.append(meta, btn);
    ul.appendChild(li);
  });
}

// ---- Events -----------------------------------------------------------------
function wireToggles() {
  TOGGLES.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", () => save({ [id]: el.checked }));
  });
}

function wireFolderName() {
  const input = document.getElementById("focusFolderName");
  let t = null;
  input.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => save({ focusFolderName: input.value.trim() }), 300);
  });
}

function wireChipAdd(inputId, btnId, key, listId, emptyMsg) {
  const input = document.getElementById(inputId);
  const add = () => {
    const val = input.value.trim();
    if (!val) return;
    if (!state[key].includes(val)) {
      save({ [key]: [...state[key], val] });
      renderChips(listId, key, emptyMsg);
    }
    input.value = "";
    input.focus();
  };
  document.getElementById(btnId).addEventListener("click", add);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") add();
  });
}

const WEBK_URL = "https://web.telegram.org/k/";

async function currentTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  return tab || null;
}

async function activeTelegramTab() {
  const tab = await currentTab();
  if (!tab || !tab.url || !tab.url.startsWith(WEBK_URL)) return null;
  return tab;
}

// Not on WebK → explain why, and offer to switch (from /a/ or elsewhere).
async function showNotTelegramHint() {
  const tab = await currentTab();
  const onOtherClient =
    tab && tab.url && tab.url.startsWith("https://web.telegram.org");
  document.getElementById("not-telegram-msg").textContent = onOtherClient
    ? "This extension works with Telegram Web K only."
    : "Open Telegram Web K to use these controls.";
  document.getElementById("not-telegram").hidden = false;
  document.getElementById("openWebK").onclick = () => {
    if (onOtherClient) chrome.tabs.update(tab.id, { url: WEBK_URL });
    else chrome.tabs.create({ url: WEBK_URL });
    window.close();
  };
}

function wirePicker() {
  document.getElementById("pickBtn").addEventListener("click", async () => {
    const tab = await activeTelegramTab();
    if (!tab) {
      showNotTelegramHint();
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: "utg-start-picker" }, () => {
      // Close the popup so the user can interact with the page.
      void chrome.runtime.lastError; // ignore if no receiver
      window.close();
    });
  });
}

function wireReset() {
  document.getElementById("resetBtn").addEventListener("click", () => {
    state = { ...DEFAULTS };
    chrome.storage.sync.set(DEFAULTS);
    render();
  });
}

// Reflect external changes (e.g. picker adding a selector) live.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "focusBreakUntil" in changes) {
    breakUntil = changes.focusBreakUntil.newValue || 0;
    renderBreak();
    return;
  }
  if (area !== "sync") return;
  for (const [k, { newValue }] of Object.entries(changes)) {
    state[k] = newValue;
  }
  render();
});

// ---- Init -------------------------------------------------------------------
(async () => {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  state = { ...DEFAULTS, ...stored };
  breakUntil = (await chrome.storage.local.get({ focusBreakUntil: 0 })).focusBreakUntil || 0;

  wireToggles();
  wireFolderName();
  wireChipAdd("blockInput", "blockAdd", "blockedChats", "blockList",
    "No blocked names yet.");
  wireChipAdd("allowInput", "allowAdd", "whitelistChats", "allowList",
    "No whitelisted names yet.");
  wirePicker();
  wireBreak();
  wireReset();
  render();

  if (!(await activeTelegramTab())) showNotTelegramHint();
})();
