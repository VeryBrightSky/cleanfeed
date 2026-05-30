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
  // v1.5.0 phase 2 — homepage redirect destination
  cf_homepage_destination: "subscriptions",
  // v1.4.17 — license code Pro path
  cleanfeed_license: null,
  installId: "",
  // v1.4.21 Phase 3 — subscription + grandfather + dashboard data
  cf_grandfathered: false,
  cf_grandfathered_at: null,
  cf_grandfathered_reason: null,
  cf_subscription: { status: "none", plan: null, cancelAt: null, lastSyncAt: 0 },
  cf_stats: { blocked: {}, autoplay_avoided: {}, session_started: 0 },
};

// v1.4.21 Phase 3 — minimal blocker-id → human-label map for the dashboard
// breakdown table. Mirrors the popup BLOCKERS array; kept here so options.js
// doesn't have to load the popup module. Synced manually when blockers are
// added — last sync v1.4.19's 17 blockers.
const BLOCKER_LABELS = {
  "home-feed": "Homepage feed",
  "shorts": "Shorts everywhere",
  "watch-sidebar": "Sidebar recommendations",
  "end-screen": "End-screen suggestions",
  "comments": "Comments section",
  "explore": "Trending / Explore tabs",
  "live-chat": "Live chat",
  "autoplay": "Autoplay",
  "thumbnails": "Hide thumbnails",
  "subs-algo": "Subscription algorithm",
  "playables": "Playables games panel",
  "merch-shelf": "Merch shelf",
  "breaking-news": "Breaking news",
  "mixes-playlists": "Mixes & playlists",
  "subs-most-relevant": "'Most Relevant' suggestions",
  "subs-members-only": "Members-only videos",
  "subs-watched": "Already-watched (>95%)",
};
const CF_AVG_VIDEO_MIN_OPTIONS = 4;

// v1.4.17 — Cloudflare Worker that issues + validates license keys.
const LICENSE_SERVER = "https://cleanfeed-license.cleanfeed.workers.dev";

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
       "hiddenKeywords", "perPageEnabled",
       // v1.4.17 — license redemption state
       "cleanfeed_license", "installId",
       // v1.4.21 Phase 3
       "cf_grandfathered", "cf_grandfathered_at", "cf_grandfathered_reason",
       "cf_subscription", "cf_stats",
       // v1.5.0 phase 2 — homepage destination
       "cf_homepage_destination"],
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
        // v1.5.0 phase 2 — homepage destination. Strings or objects are
        // both valid; fall back to "subscriptions" for missing/garbage.
        STATE.cf_homepage_destination =
          (typeof data.cf_homepage_destination === "string"
           || (data.cf_homepage_destination && typeof data.cf_homepage_destination === "object"))
          ? data.cf_homepage_destination : "subscriptions";
        STATE.cleanfeed_license = data.cleanfeed_license || null;
        STATE.installId = data.installId || "";
        STATE.cf_grandfathered = data.cf_grandfathered === true;
        STATE.cf_grandfathered_at = data.cf_grandfathered_at || null;
        STATE.cf_grandfathered_reason = data.cf_grandfathered_reason || null;
        STATE.cf_subscription = (data.cf_subscription && typeof data.cf_subscription === "object")
          ? data.cf_subscription
          : { status: "none", plan: null, cancelAt: null, lastSyncAt: 0 };
        STATE.cf_stats = (data.cf_stats && typeof data.cf_stats === "object")
          ? data.cf_stats
          : { blocked: {}, autoplay_avoided: {}, session_started: 0 };
        resolve();
      }
    );
  });
}

// ---- v1.4.17 — license code redemption ----------------------------------

// Strip every char outside the 31-char alphabet (A–Z minus I/L/O, 2–9
// minus 0/1). Uppercases first so users pasting from email clients with
// auto-lowercase don't get falsely rejected.
function _normalizeLicense(s) {
  return String(s || "").toUpperCase().replace(/[^A-Z2-9]/g, "");
}
function _isValidLicenseFormat(normalized) {
  return /^[A-Z2-9]{24}$/.test(normalized);
}
function _formatLicense(normalized) {
  return normalized.match(/.{4}/g).join("-");
}
// v1.4.18 — display redaction shows the full 6-group canonical layout
// with the middle four groups masked as XXXX. Visually identical to a
// real key, just with everything past the first 4 chars and before the
// last 4 chars hidden.
function _partialLicense(normalized) {
  return normalized.slice(0, 4) + "-XXXX-XXXX-XXXX-XXXX-" + normalized.slice(20, 24);
}

// Single source of truth for the rendered partial. Always prefer
// deriving from the full key (which we already store for /verify), so
// the displayed format is decoupled from whatever's persisted in
// key_partial. Falls back to whatever's in key_partial if the full key
// is missing (defensive — shouldn't happen for v1.4.17+ redemptions).
function _displayPartial(lic) {
  if (lic && typeof lic.key === "string") {
    const norm = _normalizeLicense(lic.key);
    if (norm.length === 24) return _partialLicense(norm);
  }
  return (lic && lic.key_partial) || "";
}

// Race-tolerant idempotent install-id ensurer (mirrors background.js).
async function ensureInstallId() {
  const d = await chrome.storage.local.get(["installId"]);
  if (typeof d.installId === "string" && d.installId.length >= 8) return d.installId;
  let id;
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    id = crypto.randomUUID();
  } else {
    const a = new Uint8Array(16); crypto.getRandomValues(a);
    id = Array.from(a).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  const d2 = await chrome.storage.local.get(["installId"]);
  if (typeof d2.installId === "string" && d2.installId.length >= 8) return d2.installId;
  await chrome.storage.local.set({ installId: id });
  return id;
}

function renderLicensePanel() {
  const lic = STATE.cleanfeed_license;
  const form = $("cf-license-form");
  const active = $("cf-license-active");
  // v1.4.21 Phase 3 — grandfathered users (legacy ExtPay one-time buyers OR
  // license-key redeemers) get the "Lifetime Pro" framing in this panel,
  // even when no license is present (legacy-extpay case has no key). The
  // form (redemption input) is hidden — a grandfathered user is already
  // Pro forever and redemption would be a no-op.
  if (STATE.cf_grandfathered) {
    form.hidden = true;
    active.hidden = false;
    const grantedAt = STATE.cf_grandfathered_at
      ? new Date(STATE.cf_grandfathered_at).toLocaleDateString(undefined,
          { year: "numeric", month: "short", day: "numeric" })
      : "—";
    const reasonLabel = STATE.cf_grandfathered_reason === "legacy_extpay"
      ? "legacy one-time purchase"
      : STATE.cf_grandfathered_reason === "legacy_subscriber"
        ? "legacy subscriber (auto-grandfathered)"
        : STATE.cf_grandfathered_reason === "license_key"
          ? "license key"
          : "—";
    // Reuse the existing partial + when fields for the grandfather display.
    const partialNode = $("cf-license-partial");
    const whenNode = $("cf-license-when");
    if (lic && lic.active && (lic.key || lic.key_partial)) {
      partialNode.textContent = _displayPartial(lic);
    } else {
      partialNode.textContent = `Lifetime Pro · ${reasonLabel}`;
    }
    whenNode.textContent = `Granted ${grantedAt}`;
    // Override the headline status copy.
    const headline = active.querySelector(".cf-status");
    if (headline) headline.textContent = "Lifetime Pro active.";
    return;
  }
  if (lic && lic.active && (lic.key || lic.key_partial)) {
    form.hidden = true;
    active.hidden = false;
    const display = _displayPartial(lic);
    $("cf-license-partial").textContent = display;
    $("cf-license-when").textContent = lic.redeemed_at
      ? new Date(lic.redeemed_at).toLocaleString()
      : "—";
    // v1.4.18 — silently migrate the stored key_partial to the new
    // 6-group masked format. v1.4.17 wrote the ellipsis form ("ABCD…XYZ2");
    // we re-write it on first render so the storage value matches what
    // we now display. Display-only change — no security implication.
    if (display && lic.key_partial !== display) {
      const updated = Object.assign({}, lic, { key_partial: display });
      STATE.cleanfeed_license = updated;
      chrome.storage.local.set({ cleanfeed_license: updated });
    }
  } else {
    form.hidden = false;
    active.hidden = true;
  }
}

async function onLicenseRedeem() {
  const input = $("cf-license-input");
  const btn = $("cf-license-redeem");
  const status = $("cf-license-status");
  const normalized = _normalizeLicense(input.value);
  if (!_isValidLicenseFormat(normalized)) {
    status.textContent = "License code must be 24 letters/digits (e.g. ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2).";
    status.className = "cf-status cf-status-warn";
    return;
  }
  // Make sure we have an install id before the network call — background
  // seeds one on install/startup, but a user who opens Options on a brand
  // new profile before onInstalled finished should still be able to redeem.
  if (!STATE.installId) {
    STATE.installId = await ensureInstallId();
  }
  status.textContent = "Verifying…";
  status.className = "cf-status";
  btn.disabled = true;
  try {
    const resp = await fetch(LICENSE_SERVER + "/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: normalized, install_id: STATE.installId }),
    });
    if (resp.ok) {
      const body = await resp.json();
      if (body && body.ok === true) {
        const formatted = _formatLicense(normalized);
        const lic = {
          active: true,
          key: formatted,                       // stored for periodic /verify
          key_partial: _partialLicense(normalized),
          redeemed_at: Date.now(),
        };
        await chrome.storage.local.set({ cleanfeed_license: lic });
        STATE.cleanfeed_license = lic;
        // background.js's storage.onChanged listener will recompute the
        // derived `paid` flag; for instant UI feedback we also flip
        // STATE.paid locally and re-render every gated panel.
        STATE.paid = true;
        status.textContent = "License active. Pro unlocked.";
        status.className = "cf-status cf-status-ok";
        renderLicensePanel();
        renderTier();
        renderWhitelist(); renderBlockedList(); renderFocusLock();
        renderKeywords(); renderPomodoro(); renderPerPage();
        return;
      }
    }
    let msg;
    if (resp.status === 404)      msg = "Invalid code.";
    else if (resp.status === 409) msg = "This code has already been used.";
    else if (resp.status === 410) msg = "This code has been revoked.";
    else if (resp.status === 429) msg = "Too many attempts. Wait an hour and try again.";
    else                          msg = "Couldn’t reach the license server. Try again in a minute.";
    status.textContent = msg;
    status.className = "cf-status cf-status-warn";
  } catch (e) {
    status.textContent = "Couldn’t reach the license server. Try again in a minute.";
    status.className = "cf-status cf-status-warn";
  } finally {
    btn.disabled = false;
  }
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
  for (let i = 0; i < STATE.blockedChannels.length; i++) {
    const ch = STATE.blockedChannels[i];
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = ch.name || ("@" + (ch.handle || "unknown"));
    li.appendChild(span);

    // v1.5.0 phase 2 — per-row regex toggle. When checked, content.js
    // treats handle + name as RegExp patterns (case-insensitive) instead
    // of exact-string matches. Invalid regex shows a "⚠" indicator;
    // matching is silently skipped for invalid entries.
    const rxLabel = document.createElement("label");
    rxLabel.className = "cf-kw-regex";
    const rxCb = document.createElement("input");
    rxCb.type = "checkbox";
    rxCb.checked = !!ch.isRegex;
    rxLabel.appendChild(rxCb);
    const rxText = document.createElement("span");
    rxText.textContent = "regex";
    rxLabel.appendChild(rxText);
    li.appendChild(rxLabel);

    const warn = document.createElement("span");
    warn.className = "cf-kw-warn";
    warn.title = "Invalid regular expression — this channel is skipped at match time.";
    warn.textContent = "⚠";
    warn.hidden = !(ch.isRegex && !_isValidRegex(ch.handle || ch.name || ""));
    li.appendChild(warn);

    rxCb.addEventListener("change", () => toggleChannelRegex(i, rxCb.checked, warn));

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "remove";
    btn.addEventListener("click", () => removeBlockedChannel(ch));
    li.appendChild(btn);
    list.appendChild(li);
  }
}

async function toggleChannelRegex(idx, isRegex, warnNode) {
  const next = (STATE.blockedChannels || []).slice();
  if (idx < 0 || idx >= next.length) return;
  // Clone the entry so we don't mutate the storage snapshot in place.
  next[idx] = Object.assign({}, next[idx], { isRegex: !!isRegex });
  STATE.blockedChannels = next;
  await chrome.storage.local.set({ blockedChannels: next });
  if (warnNode) {
    const ch = next[idx];
    warnNode.hidden = !(ch.isRegex && !_isValidRegex(ch.handle || ch.name || ""));
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
      // v1.4.10 — include the four v1.4.0 blockers so a "Reset All"
      // writes a complete settings object instead of a stale 10-key
      // subset. Behaviour is unchanged for the user (these were already
      // re-defaulted to false at content/popup read time), but the
      // canonical-defaults block no longer drifts from BLOCKERS.
      "playables": false, "merch-shelf": false,
      "breaking-news": false, "mixes-playlists": false,
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

// ---- v1.4.0 F1 / v1.5.0 phase 2 — keyword block list -------------------
//
// Each keyword is stored as { pattern, isRegex }. The legacy shape (an
// array of lowercase strings) is migrated on first save — _normalizeKws
// accepts either form and returns the canonical objects. Substring is
// the default; the per-row "regex" checkbox flips matching to
// new RegExp(pattern, "i"). Invalid regex strings show a "⚠" indicator
// next to the row and are silently skipped at match time (content.js
// tries-and-catches the RegExp constructor).

function _normalizeKws(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    let pat, rx;
    if (typeof entry === "string") {
      pat = entry.trim();
      rx = false;
    } else if (entry && typeof entry === "object") {
      pat = String(entry.pattern || "").trim();
      rx = !!entry.isRegex;
    } else { continue; }
    if (!pat) continue;
    // Dedupe on (pattern, isRegex) — substring "react" and regex "react"
    // are conceptually different so both can coexist.
    const key = (rx ? "rx:" : "lit:") + pat.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ pattern: pat, isRegex: rx });
    if (out.length >= 200) break;
  }
  return out;
}

function _isValidRegex(pat) {
  try { new RegExp(pat, "i"); return true; }
  catch (_) { return false; }
}

function renderKeywords() {
  const host = $("cf-keywords-list");
  const addBtn = $("cf-keywords-add");
  if (!host) return;
  while (host.firstChild) host.removeChild(host.firstChild);
  const norm = _normalizeKws(STATE.hiddenKeywords);
  if (norm.length === 0) {
    const empty = document.createElement("p");
    empty.className = "cf-help";
    empty.textContent = STATE.paid
      ? "No keywords yet. Click \"+ Add keyword\" to start."
      : "Upgrade to Pro to block keywords.";
    host.appendChild(empty);
  } else {
    norm.forEach((k, idx) => {
      host.appendChild(_renderKeywordRow(k, idx));
    });
  }
  if (addBtn) addBtn.disabled = !STATE.paid;
}

function _renderKeywordRow(kw, idx) {
  const row = document.createElement("div");
  row.className = "cf-kw-row";

  const input = document.createElement("input");
  input.type = "text";
  input.value = kw.pattern;
  input.placeholder = kw.isRegex ? "^reaction(s)?$" : "reaction";
  input.disabled = !STATE.paid;
  input.dataset.idx = String(idx);
  row.appendChild(input);

  const rxLabel = document.createElement("label");
  rxLabel.className = "cf-kw-regex";
  const rxCb = document.createElement("input");
  rxCb.type = "checkbox";
  rxCb.checked = !!kw.isRegex;
  rxCb.disabled = !STATE.paid;
  rxLabel.appendChild(rxCb);
  const rxText = document.createElement("span");
  rxText.textContent = "regex";
  rxLabel.appendChild(rxText);
  row.appendChild(rxLabel);

  // Invalid-regex warning. Visible only when isRegex AND pattern doesn't
  // compile. We refresh this whenever the input or checkbox changes.
  const warn = document.createElement("span");
  warn.className = "cf-kw-warn";
  warn.title = "Invalid regular expression — this row is skipped at match time.";
  warn.textContent = "⚠ invalid";
  warn.hidden = !(kw.isRegex && !_isValidRegex(kw.pattern));
  row.appendChild(warn);

  const rm = document.createElement("button");
  rm.type = "button";
  rm.className = "cf-link cf-kw-remove";
  rm.textContent = "remove";
  rm.disabled = !STATE.paid;
  row.appendChild(rm);

  // Wiring — onBlur of input + checkbox change + remove click.
  const refreshWarn = () => {
    warn.hidden = !(rxCb.checked && !_isValidRegex(input.value));
  };
  input.addEventListener("input", refreshWarn);
  rxCb.addEventListener("change", () => { refreshWarn(); saveKeywordRow(idx, input.value, rxCb.checked); });
  input.addEventListener("blur", () => saveKeywordRow(idx, input.value, rxCb.checked));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); saveKeywordRow(idx, input.value, rxCb.checked); input.blur(); }
  });
  rm.addEventListener("click", () => removeKeywordRow(idx));

  return row;
}

async function saveKeywordRow(idx, pattern, isRegex) {
  if (!STATE.paid) return;
  const current = _normalizeKws(STATE.hiddenKeywords);
  const p = String(pattern || "").trim();
  if (!p) {
    // Empty pattern collapses to a remove.
    return removeKeywordRow(idx);
  }
  // Build a new array with the row updated. If the row doesn't exist
  // yet (e.g. a fresh Add-row that hasn't persisted), append.
  const next = current.slice();
  while (next.length <= idx) next.push({ pattern: "", isRegex: false });
  next[idx] = { pattern: p, isRegex: !!isRegex };
  // Re-normalize to drop empties + dedupe.
  const cleaned = _normalizeKws(next);
  STATE.hiddenKeywords = cleaned;
  await chrome.storage.local.set({ hiddenKeywords: cleaned });
  // Don't re-render — that would steal focus from the input. The status
  // line below confirms the write.
  const s = $("cf-keywords-status");
  if (s) {
    s.textContent = `Saved ${cleaned.length} keyword${cleaned.length === 1 ? "" : "s"}.`;
    setTimeout(() => { if (s.textContent.indexOf("Saved") === 0) s.textContent = ""; }, 1500);
  }
}

async function removeKeywordRow(idx) {
  if (!STATE.paid) return;
  const current = _normalizeKws(STATE.hiddenKeywords);
  const next = current.slice();
  next.splice(idx, 1);
  STATE.hiddenKeywords = next;
  await chrome.storage.local.set({ hiddenKeywords: next });
  renderKeywords();
}

async function addKeywordRow() {
  if (!STATE.paid) return;
  const current = _normalizeKws(STATE.hiddenKeywords);
  // Append an empty row; the user fills it in then onBlur saves. We
  // need to actually render a row, but the row's pattern is "" so
  // saveKeywordRow won't persist until the user types. Easier: render
  // a synthetic empty row inline without touching storage.
  const host = $("cf-keywords-list");
  if (!host) return;
  // Clear the "No keywords yet" empty state if visible.
  if (host.firstChild && host.firstChild.tagName === "P") {
    while (host.firstChild) host.removeChild(host.firstChild);
  }
  const row = _renderKeywordRow({ pattern: "", isRegex: false }, current.length);
  host.appendChild(row);
  const input = row.querySelector('input[type="text"]');
  if (input) input.focus();
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

// ---- v1.5.0 phase 2 — Homepage destination ----------------------------
//
// Reads chrome.storage.local.cf_homepage_destination and renders the
// dropdown + the conditional URL/handle text input. Save fires on every
// change so the user never wonders if their pick took.

function renderHomepageDestination() {
  const sel = $("cf-home-dest");
  if (!sel) return;
  const d = STATE.cf_homepage_destination;
  let pick = "subscriptions";
  if (d === "library" || d === "history" || d === "blank") {
    pick = d;
  } else if (d && typeof d === "object") {
    if (d.type === "playlist") pick = "playlist";
    else if (d.type === "channel") pick = "channel";
  }
  sel.value = pick;
  // Conditional inputs.
  const playlistBox = $("cf-home-dest-playlist");
  const channelBox  = $("cf-home-dest-channel");
  if (playlistBox) playlistBox.hidden = (pick !== "playlist");
  if (channelBox)  channelBox.hidden  = (pick !== "channel");
  // Populate values when present.
  const purl  = $("cf-home-dest-playlist-url");
  const chand = $("cf-home-dest-channel-handle");
  if (purl  && d && typeof d === "object" && d.type === "playlist") purl.value  = d.url || "";
  if (chand && d && typeof d === "object" && d.type === "channel")  chand.value = d.handle || "";
}

async function onHomepageDestinationChange() {
  const sel = $("cf-home-dest");
  const status = $("cf-home-dest-status");
  if (!sel) return;
  const pick = sel.value;
  let next;
  if (pick === "library" || pick === "history" || pick === "blank") {
    next = pick;
  } else if (pick === "playlist") {
    const u = ($("cf-home-dest-playlist-url").value || "").trim();
    next = { type: "playlist", url: u };
  } else if (pick === "channel") {
    const h = ($("cf-home-dest-channel-handle").value || "").trim();
    next = { type: "channel", handle: h };
  } else {
    next = "subscriptions";
  }
  STATE.cf_homepage_destination = next;
  await chrome.storage.local.set({ cf_homepage_destination: next });
  // Show/hide the conditional rows on dropdown change.
  const playlistBox = $("cf-home-dest-playlist");
  const channelBox  = $("cf-home-dest-channel");
  if (playlistBox) playlistBox.hidden = (pick !== "playlist");
  if (channelBox)  channelBox.hidden  = (pick !== "channel");
  if (status) {
    status.className = "cf-status cf-status-ok";
    status.textContent = "Saved.";
    // Soft-clear the status after a beat so it doesn't linger.
    setTimeout(() => { if (status.textContent === "Saved.") status.textContent = ""; }, 1500);
  }
}

async function onPerPageToggle() {
  if (!STATE.paid) return;
  STATE.perPageEnabled = !!$("cf-perpage-enable").checked;
  await chrome.storage.local.set({ perPageEnabled: STATE.perPageEnabled });
  pushChanges();
}

// ---- v1.4.21 Phase 3 — Subscription panel ------------------------------
//
// Mirrors the popup's renderUpgrade case logic but with more detail
// (renewal date when known, plan label, billing amount, customer-portal
// links + switch-plan link). Hidden entirely for grandfathered users —
// the License code section above already shows "Lifetime Pro" framing
// in that case via renderLicensePanel.

function _formatDateOnly(ms) {
  const n = Number(ms);
  if (!n || !isFinite(n)) return "";
  try {
    return new Date(n).toLocaleDateString(undefined, {
      year: "numeric", month: "short", day: "numeric",
    });
  } catch (_) {
    const d = new Date(n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
}

function _openExtpayPortal() {
  chrome.runtime.sendMessage({ type: "cf:open-login" }, () => { void chrome.runtime.lastError; });
}
function _openLifetimeCheckout() {
  // v1.4.22 — single-plan world. Always opens /choose-plan/lifetime.
  chrome.runtime.sendMessage({ type: "cf:open-payment", plan: "lifetime" }, () => {
    void chrome.runtime.lastError;
  });
}

function renderSubscriptionPanel() {
  const panel = $("cf-sub-panel");
  const body = $("cf-sub-body");
  if (!panel || !body) return;
  // Grandfathered (lifetime) users don't have a subscription. Hide the panel
  // entirely — renderLicensePanel above shows the "Lifetime Pro" framing.
  if (STATE.cf_grandfathered) {
    panel.hidden = true;
    return;
  }
  while (body.firstChild) body.removeChild(body.firstChild);
  const sub = STATE.cf_subscription || {};
  const status = sub.status || "none";

  // v1.4.22 — pricing revert. The subscription panel is now ONLY relevant
  // for the legacy edge cases:
  //   active / cancellation_pending  -> legacy-subscriber notice + Switch
  //                                     to lifetime ($0) button (no charge,
  //                                     since v1.4.22 first boot already
  //                                     auto-grandfathers via ensureGrandfather's
  //                                     legacy_subscriber branch — this
  //                                     button is the user-facing confirmation).
  //   past_due                       -> existing Update-payment copy (unchanged).
  //   none / canceled                -> panel hidden entirely.
  // Free users use the popup's single Get Pro card; the options page no
  // longer carries any upsell copy.

  const btnLink = (label, onclick, primary) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = primary ? "cf-btn cf-btn-primary" : "cf-btn";
    b.textContent = label;
    b.addEventListener("click", onclick);
    return b;
  };

  if (status === "active" || status === "cancellation_pending") {
    const notice = document.createElement("p");
    notice.className = "cf-help";
    notice.textContent = "You're subscribed to the legacy monthly/annual plan. CleanFeed has switched to a one-time $4.99 model — you'll keep Pro for your current billing period, and you can switch to lifetime at no extra cost.";
    body.appendChild(notice);
    const switchBtn = btnLink("Switch to lifetime ($0)", _onSwitchToLifetime, true);
    switchBtn.id = "cf-switch-to-lifetime";
    body.appendChild(switchBtn);
    const status_el = document.createElement("p");
    status_el.id = "cf-switch-to-lifetime-status";
    status_el.className = "cf-status";
    status_el.setAttribute("aria-live", "polite");
    body.appendChild(status_el);
    panel.hidden = false;
    return;
  }
  if (status === "past_due") {
    const warn = document.createElement("p");
    warn.className = "cf-status cf-status-warn";
    warn.textContent = "Card needs updating to keep Pro.";
    body.appendChild(warn);
    body.appendChild(btnLink("Update payment method", _openExtpayPortal, true));
    panel.hidden = false;
    return;
  }
  // status === "none" / "canceled" / anything else — hide panel entirely.
  panel.hidden = true;
}

// v1.4.22 — handle "Switch to lifetime ($0)" click. ensureGrandfather has
// almost certainly already auto-granted on the first v1.4.22 SW boot, but
// the button still goes through the dedicated cf:legacy-sub-grandfather
// message handler so the user gets explicit confirmation toast feedback.
function _onSwitchToLifetime() {
  const status_el = $("cf-switch-to-lifetime-status");
  const btn = $("cf-switch-to-lifetime");
  if (btn) btn.disabled = true;
  if (status_el) {
    status_el.className = "cf-status";
    status_el.textContent = "Granting…";
  }
  chrome.runtime.sendMessage({ type: "cf:legacy-sub-grandfather" }, (resp) => {
    if (btn) btn.disabled = false;
    if (chrome.runtime.lastError) {
      console.error("[CleanFeed] cf:legacy-sub-grandfather failed:", chrome.runtime.lastError.message);
      if (status_el) {
        status_el.className = "cf-status cf-status-warn";
        status_el.textContent = "Could not switch. Try again in a minute.";
      }
      return;
    }
    if (resp && resp.ok && resp.granted) {
      if (status_el) {
        status_el.className = "cf-status cf-status-ok";
        status_el.textContent = "Lifetime Pro granted. You're set forever.";
      }
      // The grandfather storage write triggers storage.onChanged → this page
      // re-renders the license card with "Lifetime Pro · legacy_subscriber".
    } else {
      console.error("[CleanFeed] cf:legacy-sub-grandfather refused:", resp && resp.error);
      if (status_el) {
        status_el.className = "cf-status cf-status-warn";
        status_el.textContent = "Could not grant lifetime. " + (resp && resp.error ? resp.error : "Unknown error.");
      }
    }
  });
}

// ---- v1.4.21 Phase 3 — Stats dashboard ---------------------------------
//
// Reads cf_stats and renders:
//   1. A 7-day inline-SVG bar chart of total videos blocked per day.
//   2. A per-blocker breakdown table for the last 30 days, sorted descending.
//   3. An all-time totals line.
//
// Pure render — never writes storage. Re-runs on every cf_stats change via
// the storage.onChanged listener.

function _lastNDateKeysOptions(n) {
  const out = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    out.push(`${y}-${m}-${day}`);
  }
  return out;
}

function _sumDayTotals(dayObj) {
  if (!dayObj || typeof dayObj !== "object") return 0;
  let n = 0;
  for (const id of Object.keys(dayObj)) {
    const v = Number(dayObj[id]) || 0;
    if (v > 0) n += v;
  }
  return n;
}

function renderStatsDashboard() {
  const weekHost = $("cf-stats-week");
  const breakHost = $("cf-stats-breakdown");
  const totalsHost = $("cf-stats-totals");
  if (!weekHost || !breakHost || !totalsHost) return;

  const blocked = (STATE.cf_stats && STATE.cf_stats.blocked) || {};
  const auto = (STATE.cf_stats && STATE.cf_stats.autoplay_avoided) || {};

  // ---- 7-day bar chart ----
  const weekDates = _lastNDateKeysOptions(7).slice().reverse(); // oldest -> newest
  const dailyTotals = weekDates.map((k) => _sumDayTotals(blocked[k]));
  const maxDay = Math.max.apply(null, dailyTotals.concat([1]));

  while (weekHost.firstChild) weekHost.removeChild(weekHost.firstChild);

  if (dailyTotals.every((n) => n === 0)) {
    const empty = document.createElement("p");
    empty.className = "cf-help";
    empty.textContent = "No activity in the last 7 days. Open a YouTube tab with blockers enabled and check back.";
    weekHost.appendChild(empty);
  } else {
    const W = 320, H = 90, PAD = 6;
    const barW = (W - PAD * 2) / weekDates.length;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "" + H);
    svg.setAttribute("class", "cf-stats-chart");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Videos blocked per day, last 7 days");
    weekDates.forEach((k, i) => {
      const v = dailyTotals[i];
      const h = v > 0 ? Math.max(2, Math.round((v / maxDay) * (H - PAD * 4))) : 0;
      const x = PAD + i * barW + 2;
      const y = H - PAD - h;
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", "" + x);
      rect.setAttribute("y", "" + y);
      rect.setAttribute("width", "" + Math.max(8, barW - 4));
      rect.setAttribute("height", "" + h);
      rect.setAttribute("rx", "3");
      rect.setAttribute("class", "cf-stats-bar");
      const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = `${k}: ${v} blocked`;
      rect.appendChild(title);
      svg.appendChild(rect);
    });
    weekHost.appendChild(svg);
    // Day labels (Mon/Tue/etc) under each bar — shortest form.
    const labelRow = document.createElement("div");
    labelRow.className = "cf-stats-chart-labels";
    weekDates.forEach((k) => {
      const cell = document.createElement("span");
      cell.className = "cf-stats-chart-day";
      try {
        const d = new Date(k + "T12:00:00");
        cell.textContent = d.toLocaleDateString(undefined, { weekday: "short" });
      } catch (_) {
        cell.textContent = k.slice(5);
      }
      labelRow.appendChild(cell);
    });
    weekHost.appendChild(labelRow);
  }

  // ---- per-blocker breakdown (last 30 days) ----
  const thirtyDates = _lastNDateKeysOptions(30);
  const perBlocker = {};
  for (const k of thirtyDates) {
    const day = blocked[k];
    if (!day || typeof day !== "object") continue;
    for (const id of Object.keys(day)) {
      const v = Number(day[id]) || 0;
      if (v > 0) perBlocker[id] = (perBlocker[id] || 0) + v;
    }
  }
  const sorted = Object.keys(perBlocker)
    .map((id) => ({ id, n: perBlocker[id] }))
    .sort((a, b) => b.n - a.n);

  while (breakHost.firstChild) breakHost.removeChild(breakHost.firstChild);
  if (sorted.length === 0) {
    const empty = document.createElement("p");
    empty.className = "cf-help";
    empty.textContent = "No blockers have fired in the last 30 days yet.";
    breakHost.appendChild(empty);
  } else {
    const table = document.createElement("table");
    table.className = "cf-stats-table";
    const tbody = document.createElement("tbody");
    for (const { id, n } of sorted) {
      const tr = document.createElement("tr");
      const tdLabel = document.createElement("td");
      tdLabel.textContent = BLOCKER_LABELS[id] || id;
      const tdN = document.createElement("td");
      tdN.className = "cf-stats-table-n";
      tdN.textContent = String(n);
      tr.appendChild(tdLabel); tr.appendChild(tdN);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    breakHost.appendChild(table);
  }

  // ---- all-time totals ----
  let allTimeBlocked = 0;
  for (const k of Object.keys(blocked)) {
    allTimeBlocked += _sumDayTotals(blocked[k]);
  }
  let allTimeAutoplay = 0;
  for (const k of Object.keys(auto)) {
    const a = auto[k];
    if (a && typeof a === "object") allTimeAutoplay += Number(a.videos) || 0;
  }
  const hours = Math.round(allTimeBlocked * CF_AVG_VIDEO_MIN_OPTIONS / 60 * 10) / 10;
  totalsHost.textContent = `All-time: ${allTimeBlocked} ${allTimeBlocked === 1 ? "video" : "videos"} blocked, ${hours} ${hours === 1 ? "hour" : "hours"} saved, ${allTimeAutoplay} autoplay ${allTimeAutoplay === 1 ? "chain" : "chains"} avoided.`;
}

// ---- v1.5.0-phase1 — Diagnostic info (selector health log) -------------
//
// Read-only viewer for chrome.storage.local.cf_health_log. The content
// script writes via window.__cleanfeed_healthlog.record* on every
// applyBlockers tick (throttled to once-per-page-nav per blocker). This
// page just displays + copies + clears. No internet calls; the log
// never leaves the device unless the user explicitly copies it into
// a bug report.

const DIAG_LOG_KEY = "cf_health_log";

function loadDiagnosticLog() {
  const ta = $("cf-diag-log");
  const status = $("cf-diag-status");
  if (!ta) return;
  if (status) status.textContent = "";
  try {
    chrome.storage.local.get([DIAG_LOG_KEY], (data) => {
      const arr = (data && Array.isArray(data[DIAG_LOG_KEY])) ? data[DIAG_LOG_KEY] : [];
      // Newest first so users see the most recent miss / match at the top
      // when they copy. Keep the original storage order untouched on disk;
      // this is a render-time sort only.
      const sorted = arr.slice().reverse();
      ta.value = JSON.stringify(sorted, null, 2);
      if (status) {
        status.className = "cf-status";
        status.textContent = arr.length === 0
          ? "No entries yet."
          : `${arr.length} entr${arr.length === 1 ? "y" : "ies"} (max 50, newest first).`;
      }
    });
  } catch (err) {
    if (status) {
      status.className = "cf-status cf-status-warn";
      status.textContent = "Could not read diagnostic log: " + String(err);
    }
  }
}

async function copyDiagnosticLog() {
  const ta = $("cf-diag-log");
  const status = $("cf-diag-status");
  if (!ta) return;
  // Make sure we have the freshest snapshot before copying.
  loadDiagnosticLog();
  try {
    // Wait one tick so loadDiagnosticLog's storage callback populates ta.value
    await new Promise((r) => setTimeout(r, 50));
    const text = ta.value || "[]";
    await navigator.clipboard.writeText(text);
    if (status) {
      status.className = "cf-status cf-status-ok";
      status.textContent = "Copied to clipboard.";
    }
  } catch (err) {
    if (status) {
      status.className = "cf-status cf-status-warn";
      status.textContent = "Couldn't copy — select the text and Ctrl+C instead.";
    }
  }
}

function clearDiagnosticLog() {
  const status = $("cf-diag-status");
  if (!confirm("Clear the diagnostic log? This won't affect any blocker or setting — just the health history.")) {
    return;
  }
  try {
    chrome.storage.local.remove([DIAG_LOG_KEY], () => {
      loadDiagnosticLog();
      if (status) {
        status.className = "cf-status cf-status-ok";
        status.textContent = "Cleared.";
      }
    });
  } catch (err) {
    if (status) {
      status.className = "cf-status cf-status-warn";
      status.textContent = "Could not clear: " + String(err);
    }
  }
}

async function init() {
  try {
    $("cf-version").textContent = "v" + chrome.runtime.getManifest().version;
  } catch (_) {}
  await load();
  // v1.4.17 — make sure an install id exists before any redeem attempt.
  if (!STATE.installId) STATE.installId = await ensureInstallId();
  renderTier();
  renderLicensePanel();
  // v1.4.21 Phase 3 — subscription card + dashboard
  renderSubscriptionPanel();
  renderStatsDashboard();
  renderWhitelist();
  renderBlockedList();
  renderCustomCSS();
  renderTimeTracker();
  renderFocusLock();
  // v1.4.0
  renderKeywords();
  renderPomodoro();
  renderPerPage();
  // v1.5.0 phase 2 — homepage destination
  renderHomepageDestination();

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
  // v1.5.0 phase 2 — keywords are now row-edited; an "Add" button
  // appends an empty row that persists on first blur.
  const kwAdd = $("cf-keywords-add");
  if (kwAdd) kwAdd.addEventListener("click", addKeywordRow);
  $("cf-pomo-start").addEventListener("click", startPomodoro);
  $("cf-pomo-cancel").addEventListener("click", cancelPomodoro);
  $("cf-perpage-enable").addEventListener("change", onPerPageToggle);
  // v1.5.0 phase 2 — homepage destination wiring. The dropdown fires
  // onHomepageDestinationChange directly; the playlist URL + channel
  // handle text inputs fire the same handler on blur/Enter so the user
  // doesn't need a separate "Save" button.
  const destSel = $("cf-home-dest");
  if (destSel) destSel.addEventListener("change", onHomepageDestinationChange);
  for (const id of ["cf-home-dest-playlist-url", "cf-home-dest-channel-handle"]) {
    const el = $(id);
    if (el) {
      el.addEventListener("blur", onHomepageDestinationChange);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); onHomepageDestinationChange(); }
      });
    }
  }
  // v1.4.17 — license redemption
  $("cf-license-redeem").addEventListener("click", onLicenseRedeem);
  $("cf-license-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") onLicenseRedeem();
  });

  // v1.5.0-phase1 — Diagnostic info wiring. Load lazily on <details> open
  // so we don't pay the storage round-trip for the 99% of users who never
  // open this section.
  const diagDetails = $("cf-diag-details");
  if (diagDetails) {
    diagDetails.addEventListener("toggle", () => {
      if (diagDetails.open) loadDiagnosticLog();
    });
  }
  const diagCopy = $("cf-diag-copy");
  if (diagCopy) diagCopy.addEventListener("click", copyDiagnosticLog);
  const diagClear = $("cf-diag-clear");
  if (diagClear) diagClear.addEventListener("click", clearDiagnosticLog);

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
    // v1.5.0 phase 2 — homepage destination from elsewhere (popup, another
    // options tab) is reflected back into this page's controls.
    if (changes.cf_homepage_destination) {
      STATE.cf_homepage_destination = changes.cf_homepage_destination.newValue || "subscriptions";
      renderHomepageDestination();
    }
    // v1.4.17 — license redemption updates from another tab / background's
    // /verify cycle should re-render the License panel.
    if (changes.cleanfeed_license) {
      STATE.cleanfeed_license = changes.cleanfeed_license.newValue || null;
      renderLicensePanel();
    }
    if (changes.installId) { STATE.installId = changes.installId.newValue || ""; }
    // v1.4.21 Phase 3 — re-render subscription panel + dashboard on
    // upstream state changes.
    if (changes.cf_subscription) {
      STATE.cf_subscription = changes.cf_subscription.newValue
        || { status: "none", plan: null, cancelAt: null, lastSyncAt: 0 };
      renderSubscriptionPanel();
    }
    if (changes.cf_grandfathered || changes.cf_grandfathered_reason || changes.cf_grandfathered_at) {
      if (changes.cf_grandfathered) STATE.cf_grandfathered = changes.cf_grandfathered.newValue === true;
      if (changes.cf_grandfathered_reason) STATE.cf_grandfathered_reason = changes.cf_grandfathered_reason.newValue || null;
      if (changes.cf_grandfathered_at) STATE.cf_grandfathered_at = changes.cf_grandfathered_at.newValue || null;
      renderSubscriptionPanel();
      renderLicensePanel();
    }
    if (changes.cf_stats) {
      STATE.cf_stats = changes.cf_stats.newValue
        || { blocked: {}, autoplay_avoided: {}, session_started: 0 };
      renderStatsDashboard();
    }
  });
}

document.addEventListener("DOMContentLoaded", init);
