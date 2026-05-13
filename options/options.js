/* CleanFeed — options.js (v1.2)
 *
 * Adds:
 *   • Focus Lock with SHA-256 hashed PIN + per-install salt
 *   • Blocked-channels list (Pro)
 *   • Time-tracker daily/weekly/avg summary (FREE)
 */
"use strict";

const STATE = {
  paid: false,
  whitelistedChannels: [],
  customCSS: "",
  blockedChannels: [],
  focusLock: { pinSet: false, activeUntil: 0, pinHash: "", pinSalt: "", mode: "standard", pomodoro: { focusMin: 25, breakMin: 5, cycles: 4 }, pomodoroState: null },
  timeTracking: {},
  selectedDurationMin: 0,  // 0 = none, -1 = until manually unlocked
  // v1.4.0
  hiddenKeywords: [],
  perPageEnabled: false,
};

function $(id) { return document.getElementById(id); }

// ---- crypto helpers (PIN hashing) ---------------------------------------

function _randomSalt(len = 16) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text) {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hashPin(pin, salt) {
  return await sha256Hex("cf|" + salt + "|" + pin);
}

// ---- storage ------------------------------------------------------------

async function load() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ["paid", "whitelistedChannels", "customCSS",
       "blockedChannels", "focusLock", "timeTracking",
       "hiddenKeywords", "perPageEnabled"],
      (data) => {
        STATE.paid = !!data.paid;
        STATE.whitelistedChannels = data.whitelistedChannels || [];
        STATE.customCSS = data.customCSS || "";
        STATE.blockedChannels = Array.isArray(data.blockedChannels) ? data.blockedChannels : [];
        STATE.focusLock = Object.assign(
          { pinSet: false, activeUntil: 0, pinHash: "", pinSalt: "", mode: "standard", pomodoro: { focusMin: 25, breakMin: 5, cycles: 4 }, pomodoroState: null },
          data.focusLock || {}
        );
        STATE.timeTracking = data.timeTracking || {};
        STATE.hiddenKeywords = Array.isArray(data.hiddenKeywords) ? data.hiddenKeywords : [];
        STATE.perPageEnabled = !!data.perPageEnabled;
        resolve();
      }
    );
  });
}

function pushChanges() {
  chrome.runtime.sendMessage({
    type: "cf:push-settings",
    paid: STATE.paid,
    whitelistedChannels: STATE.whitelistedChannels,
    customCSS: STATE.customCSS,
  }).catch(() => {});
}

// ---- tier rendering -----------------------------------------------------

function renderTier() {
  const b = $("cf-tier-badge");
  if (STATE.paid) { b.textContent = "PRO"; b.classList.add("pro"); }
  else            { b.textContent = "FREE"; b.classList.remove("pro"); }
  // gate pro panels
  document.querySelectorAll(".cf-panel").forEach((p) => {
    const hasPro = p.querySelector(".cf-tag-pro");
    if (!hasPro) return;
    if (STATE.paid) {
      p.classList.remove("locked");
      p.querySelectorAll("input, textarea, button.cf-btn-primary, .cf-duration")
        .forEach((el) => { el.disabled = false; });
    } else {
      p.classList.add("locked");
      p.querySelectorAll("input, textarea, button.cf-btn-primary, .cf-duration")
        .forEach((el) => { el.disabled = true; });
    }
  });
}

// ---- channel whitelist (unchanged from v1.1) ----------------------------

function renderWhitelist() {
  const list = $("cf-whitelist");
  while (list.firstChild) list.removeChild(list.firstChild);
  if (!STATE.whitelistedChannels.length) {
    const li = document.createElement("li");
    li.style.color = "var(--text-dim)";
    li.style.justifyContent = "center";
    li.textContent = STATE.paid
      ? "No channels yet. Add one above."
      : "Upgrade to Pro to whitelist channels.";
    list.appendChild(li);
    return;
  }
  for (const name of STATE.whitelistedChannels) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = name;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "remove";
    btn.addEventListener("click", () => removeChannel(name));
    li.appendChild(span);
    li.appendChild(btn);
    list.appendChild(li);
  }
}

async function addChannel() {
  if (!STATE.paid) return;
  const input = $("cf-whitelist-new");
  const v = input.value.trim();
  if (!v) return;
  const lower = v.toLowerCase();
  if (STATE.whitelistedChannels.some((c) => c.toLowerCase() === lower)) {
    input.value = "";
    return;
  }
  STATE.whitelistedChannels.push(v);
  await chrome.storage.local.set({ whitelistedChannels: STATE.whitelistedChannels });
  chrome.storage.sync.set({ whitelistedChannels: STATE.whitelistedChannels }).catch(() => {});
  input.value = "";
  renderWhitelist();
  pushChanges();
}

async function removeChannel(name) {
  STATE.whitelistedChannels = STATE.whitelistedChannels.filter((c) => c !== name);
  await chrome.storage.local.set({ whitelistedChannels: STATE.whitelistedChannels });
  chrome.storage.sync.set({ whitelistedChannels: STATE.whitelistedChannels }).catch(() => {});
  renderWhitelist();
  pushChanges();
}

// ---- blocked channels (new) ---------------------------------------------

function renderBlockedList() {
  const list = $("cf-blocked-list");
  while (list.firstChild) list.removeChild(list.firstChild);
  if (!STATE.blockedChannels.length) {
    const li = document.createElement("li");
    li.style.color = "var(--text-dim)";
    li.style.justifyContent = "center";
    li.textContent = STATE.paid
      ? "No channels blocked yet."
      : "Upgrade to Pro to block channels.";
    list.appendChild(li);
    return;
  }
  for (const ch of STATE.blockedChannels) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = ch.name || ("@" + (ch.handle || "unknown"));
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "remove";
    btn.addEventListener("click", () => removeBlockedChannel(ch));
    li.appendChild(span);
    li.appendChild(btn);
    list.appendChild(li);
  }
}

async function removeBlockedChannel(ch) {
  STATE.blockedChannels = STATE.blockedChannels.filter(
    (c) => !((c.handle && c.handle === ch.handle) ||
             (c.name && ch.name && c.name.toLowerCase() === ch.name.toLowerCase()))
  );
  await chrome.storage.local.set({ blockedChannels: STATE.blockedChannels });
  renderBlockedList();
}

// ---- focus lock ---------------------------------------------------------

function renderFocusLock() {
  const isPaid = STATE.paid;
  const active = (STATE.focusLock.activeUntil || 0) > Date.now();
  $("cf-focus-active").hidden = !active;
  $("cf-focus-controls").hidden = active;
  $("cf-focus-pin-setup").hidden = active;
  // Show state of PIN
  const stateText = STATE.focusLock.pinSet
    ? "PIN is set. Use it to start a Focus session, or change it below."
    : "No PIN set yet. Set one to enable Focus Lock.";
  $("cf-pin-state").textContent = stateText;
  // Save button gating: must have non-empty inputs
  const enableStart = !active && STATE.focusLock.pinSet && STATE.selectedDurationMin !== 0 && isPaid;
  $("cf-start-lock").disabled = !enableStart;
}

async function savePin() {
  if (!STATE.paid) return;
  const a = $("cf-pin-input").value.trim();
  const b = $("cf-pin-input2").value.trim();
  $("cf-pin-error").textContent = "";
  if (!/^\d{4}$/.test(a)) {
    $("cf-pin-error").textContent = "PIN must be exactly 4 digits.";
    return;
  }
  if (a !== b) {
    $("cf-pin-error").textContent = "PINs don't match.";
    return;
  }
  const salt = STATE.focusLock.pinSalt || _randomSalt();
  const hash = await hashPin(a, salt);
  STATE.focusLock = Object.assign({}, STATE.focusLock, {
    pinSet: true, pinSalt: salt, pinHash: hash,
  });
  await chrome.storage.local.set({ focusLock: STATE.focusLock });
  $("cf-pin-input").value = "";
  $("cf-pin-input2").value = "";
  renderFocusLock();
}

function selectDuration(btn) {
  const dur = Number(btn.dataset.duration);
  STATE.selectedDurationMin = dur;
  document.querySelectorAll(".cf-duration").forEach((b) => b.classList.remove("selected"));
  btn.classList.add("selected");
  renderFocusLock();
}

async function startFocusLock() {
  if (!STATE.paid) return;
  if (!STATE.focusLock.pinSet) {
    $("cf-start-error").textContent = "Set a PIN first.";
    return;
  }
  const enteredPin = $("cf-start-pin").value.trim();
  $("cf-start-error").textContent = "";
  if (!/^\d{4}$/.test(enteredPin)) {
    $("cf-start-error").textContent = "Enter your 4-digit PIN.";
    return;
  }
  const calc = await hashPin(enteredPin, STATE.focusLock.pinSalt);
  if (calc !== STATE.focusLock.pinHash) {
    $("cf-start-error").textContent = "Wrong PIN.";
    return;
  }
  // compute activeUntil
  const dur = STATE.selectedDurationMin;
  const FAR_FUTURE = 8640000000000000;  // beyond any reasonable date
  const activeUntil = dur === -1 ? FAR_FUTURE : Date.now() + dur * 60 * 1000;
  STATE.focusLock = Object.assign({}, STATE.focusLock, { activeUntil });
  await chrome.storage.local.set({ focusLock: STATE.focusLock });
  $("cf-start-pin").value = "";
  renderFocusLock();
}

// ---- time tracker -------------------------------------------------------

function _todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function _formatMin(seconds) {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
}

function renderTimeTracker() {
  const tt = STATE.timeTracking || {};
  const today = tt[_todayKey()] || 0;
  // week = last 7 days inclusive of today
  let weekSec = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    weekSec += tt[k] || 0;
  }
  const days = Object.keys(tt).length || 1;
  let totalSec = 0;
  for (const k in tt) totalSec += tt[k];
  const avgSec = Math.round(totalSec / days);
  $("cf-time-today").textContent = _formatMin(today);
  $("cf-time-week").textContent  = _formatMin(weekSec);
  $("cf-time-avg").textContent   = _formatMin(avgSec);
}

async function resetTimeHistory() {
  const ok = confirm("Reset all stored YouTube time history?");
  if (!ok) return;
  STATE.timeTracking = {};
  await chrome.storage.local.set({ timeTracking: {} });
  renderTimeTracker();
}

// ---- custom CSS (unchanged from v1.1) -----------------------------------

function renderCustomCSS() {
  $("cf-css").value = STATE.customCSS || "";
}
async function saveCustomCSS() {
  if (!STATE.paid) return;
  const value = $("cf-css").value.slice(0, 50000);
  STATE.customCSS = value;
  await chrome.storage.local.set({ customCSS: value });
  const status = $("cf-css-status");
  status.textContent = "Saved ✓";
  setTimeout(() => { status.textContent = ""; }, 1800);
  pushChanges();
}

async function resetAll() {
  const ok = confirm("Reset all CleanFeed settings to defaults? This won't affect your Pro license, Focus Lock PIN, or time history.");
  if (!ok) return;
  const defaults = {
    settings: {
      "home-feed": true, "shorts": true, "watch-sidebar": false,
      "end-screen": false, "comments": false, "explore": false,
      "live-chat": false, "autoplay": false,
      "thumbnails": false, "subs-algo": false,
    },
    whitelistedChannels: [],
    customCSS: "",
    sessionStats: { total: 0, perBlocker: {} },
    pausedUntil: 0,
    blockedChannels: [],
  };
  await chrome.storage.local.set(defaults);
  await chrome.storage.sync.set({
    settings: defaults.settings,
    whitelistedChannels: [],
  }).catch(() => {});
  STATE.whitelistedChannels = [];
  STATE.customCSS = "";
  STATE.blockedChannels = [];
  renderWhitelist();
  renderBlockedList();
  renderCustomCSS();
  pushChanges();
}

// ---- bootstrap ----------------------------------------------------------

// ---- v1.4.0 F1 — keyword block list -------------------------------------

function renderKeywords() {
  const ta = $("cf-keywords");
  if (!ta) return;
  ta.value = (STATE.hiddenKeywords || []).join("\n");
  ta.disabled = !STATE.paid;
  const btn = $("cf-keywords-save");
  if (btn) btn.disabled = !STATE.paid;
}

async function saveKeywords() {
  if (!STATE.paid) return;
  const raw = ($("cf-keywords").value || "").split(/\r?\n/);
  const seen = new Set();
  const cleaned = [];
  for (const line of raw) {
    const t = line.trim().toLowerCase();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    cleaned.push(t);
    if (cleaned.length >= 200) break;
  }
  STATE.hiddenKeywords = cleaned;
  await chrome.storage.local.set({ hiddenKeywords: cleaned });
  const s = $("cf-keywords-status");
  if (s) {
    s.textContent = `Saved ${cleaned.length} keyword${cleaned.length === 1 ? "" : "s"}.`;
    setTimeout(() => { s.textContent = ""; }, 2000);
  }
}

// ---- v1.4.0 F4 — Pomodoro UI --------------------------------------------

function renderPomodoro() {
  const cfg = (STATE.focusLock && STATE.focusLock.pomodoro) || { focusMin: 25, breakMin: 5, cycles: 4 };
  const f = $("cf-pomo-focus");  if (f) f.value = cfg.focusMin;
  const b = $("cf-pomo-break");  if (b) b.value = cfg.breakMin;
  const c = $("cf-pomo-cycles"); if (c) c.value = cfg.cycles;
  const pinReady = !!(STATE.focusLock && STATE.focusLock.pinSet);
  const active = !!(STATE.focusLock && STATE.focusLock.pomodoroState);
  const start = $("cf-pomo-start"); const cancel = $("cf-pomo-cancel");
  if (start)  start.disabled = !STATE.paid || !pinReady || active;
  if (cancel) cancel.hidden = !active;
  const status = $("cf-pomo-status");
  if (status) {
    if (!STATE.paid) {
      status.textContent = "Pro feature — upgrade to use Pomodoro Focus Lock.";
    } else if (!pinReady) {
      status.textContent = "Set a 4-digit PIN above first.";
    } else if (active) {
      const st = STATE.focusLock.pomodoroState;
      status.textContent = `Session active — ${st.phase.toUpperCase()} phase, cycle ${st.cycle} of ${st.total}.`;
    } else {
      status.textContent = "";
    }
  }
  // gate inputs too
  const inputs = ["cf-pomo-focus", "cf-pomo-break", "cf-pomo-cycles", "cf-pomo-pin"];
  for (const id of inputs) {
    const el = $(id);
    if (el) el.disabled = !STATE.paid || active;
  }
}

async function startPomodoro() {
  if (!STATE.paid) return;
  $("cf-pomo-error").textContent = "";
  if (!(STATE.focusLock && STATE.focusLock.pinSet)) {
    $("cf-pomo-error").textContent = "Set a PIN above first.";
    return;
  }
  const enteredPin = ($("cf-pomo-pin").value || "").trim();
  if (!/^\d{4}$/.test(enteredPin)) {
    $("cf-pomo-error").textContent = "Enter your 4-digit PIN.";
    return;
  }
  const calc = await hashPin(enteredPin, STATE.focusLock.pinSalt);
  if (calc !== STATE.focusLock.pinHash) {
    $("cf-pomo-error").textContent = "Wrong PIN.";
    return;
  }
  const cfg = {
    focusMin: Number($("cf-pomo-focus").value) || 25,
    breakMin: Number($("cf-pomo-break").value) || 5,
    cycles:   Number($("cf-pomo-cycles").value) || 4,
  };
  chrome.runtime.sendMessage({ type: "cf:pomodoro-start", config: cfg }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      $("cf-pomo-error").textContent = "Could not start session.";
    }
  });
  $("cf-pomo-pin").value = "";
}

function cancelPomodoro() {
  chrome.runtime.sendMessage({ type: "cf:pomodoro-cancel" }, () => {
    void chrome.runtime.lastError; // ignore
  });
}

// ---- v1.4.0 F6 — per-page enable toggle ---------------------------------

function renderPerPage() {
  const cb = $("cf-perpage-enable");
  if (!cb) return;
  cb.checked = !!STATE.perPageEnabled;
  cb.disabled = !STATE.paid;
}

async function onPerPageToggle() {
  if (!STATE.paid) return;
  STATE.perPageEnabled = !!$("cf-perpage-enable").checked;
  await chrome.storage.local.set({ perPageEnabled: STATE.perPageEnabled });
  pushChanges();
}

async function init() {
  try {
    $("cf-version").textContent = "v" + chrome.runtime.getManifest().version;
  } catch (_) {}
  await load();
  renderTier();
  renderWhitelist();
  renderBlockedList();
  renderCustomCSS();
  renderTimeTracker();
  renderFocusLock();
  // v1.4.0
  renderKeywords();
  renderPomodoro();
  renderPerPage();

  $("cf-whitelist-add").addEventListener("click", addChannel);
  $("cf-whitelist-new").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addChannel();
  });
  $("cf-css-save").addEventListener("click", saveCustomCSS);
  $("cf-reset-all").addEventListener("click", resetAll);
  $("cf-reset-time").addEventListener("click", resetTimeHistory);
  $("cf-pin-save").addEventListener("click", savePin);
  $("cf-start-lock").addEventListener("click", startFocusLock);
  document.querySelectorAll(".cf-duration").forEach((b) => {
    b.addEventListener("click", () => selectDuration(b));
  });
  // v1.4.0 wiring
  $("cf-keywords-save").addEventListener("click", saveKeywords);
  $("cf-pomo-start").addEventListener("click", startPomodoro);
  $("cf-pomo-cancel").addEventListener("click", cancelPomodoro);
  $("cf-perpage-enable").addEventListener("change", onPerPageToggle);

  // re-render every minute so time-tracker stays fresh
  setInterval(() => renderTimeTracker(), 60 * 1000);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.paid) { STATE.paid = !!changes.paid.newValue; renderTier(); renderWhitelist(); renderBlockedList(); renderFocusLock(); renderKeywords(); renderPomodoro(); renderPerPage(); }
    if (changes.whitelistedChannels) { STATE.whitelistedChannels = changes.whitelistedChannels.newValue || []; renderWhitelist(); }
    if (changes.customCSS) { STATE.customCSS = changes.customCSS.newValue || ""; renderCustomCSS(); }
    if (changes.blockedChannels) { STATE.blockedChannels = changes.blockedChannels.newValue || []; renderBlockedList(); }
    if (changes.focusLock) { STATE.focusLock = changes.focusLock.newValue || STATE.focusLock; renderFocusLock(); renderPomodoro(); }
    if (changes.timeTracking) { STATE.timeTracking = changes.timeTracking.newValue || {}; renderTimeTracker(); }
    if (changes.hiddenKeywords) { STATE.hiddenKeywords = changes.hiddenKeywords.newValue || []; renderKeywords(); }
    if (changes.perPageEnabled) { STATE.perPageEnabled = !!changes.perPageEnabled.newValue; renderPerPage(); }
  });
}

document.addEventListener("DOMContentLoaded", init);
