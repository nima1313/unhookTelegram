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

async function activeTelegramTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!tab || !tab.url || !tab.url.startsWith("https://web.telegram.org")) {
    return null;
  }
  return tab;
}

function wirePicker() {
  document.getElementById("pickBtn").addEventListener("click", async () => {
    const tab = await activeTelegramTab();
    if (!tab) {
      document.getElementById("not-telegram").hidden = false;
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

  wireToggles();
  wireFolderName();
  wireChipAdd("blockInput", "blockAdd", "blockedChats", "blockList",
    "No blocked names yet.");
  wireChipAdd("allowInput", "allowAdd", "whitelistChats", "allowList",
    "No whitelisted names yet.");
  wirePicker();
  wireReset();
  render();

  if (!(await activeTelegramTab())) {
    document.getElementById("not-telegram").hidden = false;
  }
})();
