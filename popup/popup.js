/* CleanFeed — popup.js (v1.1)
 *
 * Adds:
 *   • 2 new Pro blockers (live-chat, autoplay)
 *   • Pause-for-1-hour with live countdown + auto-resume
 *   • Pro upsell modal triggered by:
 *       - clicking a locked Pro toggle
 *       - clicking the main "Unlock all 8 blockers" CTA
 *       (ESC + outside-click + close-button all dismiss it)
 *   • "I already paid" now opens our branded /login/login.html page
 */
"use strict";

const EXTPAY_ID = "cleanfeed2342"; // also used in background.js
const PAUSE_DURATION_MS = 60 * 60 * 1000;   // 1 hour

// Mirror of blockers.js — kept in sync but isolated so popup doesn't need
// to load the content-script bundle.
const BLOCKERS = [
  { id: "home-feed",     label: "Homepage feed",            desc: "Hides the endless recommendation grid",         tier: "free" },
  { id: "shorts",        label: "Shorts everywhere",        desc: "Shelves on homepage, search, and the left nav", tier: "free" },
  { id: "watch-sidebar", label: "Sidebar recommendations",  desc: "Hides the rail of related videos on watch pages", tier: "pro"  },
  { id: "end-screen",    label: "End-screen suggestions",   desc: "Hides the overlay cards near the end of videos", tier: "pro"  },
  { id: "comments",      label: "Comments section",         desc: "Replaces comments with a 'show comments' button", tier: "pro" },
  { id: "explore",       label: "Trending / Explore tabs",  desc: "Hides Trending, Music, Gaming, News, Sports",    tier: "pro" },
  { id: "live-chat",     label: "Live chat",                desc: "Hides the live-chat panel on streams + premieres", tier: "pro" },
  { id: "autoplay",      label: "Autoplay",                 desc: "Auto-disables the autoplay toggle on every watch page", tier: "pro" },
  { id: "thumbnails",    label: "Hide thumbnails",          desc: "Replaces video thumbnails with neutral placeholders. Hover to peek.", tier: "pro" },
  { id: "subs-algo",     label: "Hide subscription algorithm", desc: "On /feed/subscriptions, hides 'For you' shelves",   tier: "pro" },
];
const FREE_LIMIT = 2;
const HOLD_DURATION_MS = 60 * 1000;

const STATE = {
  paid: false,
  settings: {},
  whitelistedChannels: [],
  customCSS: "",
  stats: { total: 0, perBlocker: {} },
  pausedUntil: 0,
  focusLock: { pinSet: false, activeUntil: 0 },
  timeTracking: {},
};

let pauseTickHandle = 0;
let focusTickHandle = 0;

// ---- DOM helpers --------------------------------------------------------

function $(id) { return document.getElementById(id); }

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "checked") node.checked = !!v;
      else if (k === "disabled") node.disabled = !!v;
      else if (k.startsWith("on") && typeof v === "function") {
        node.addEventListener(k.slice(2), v);
      } else {
        node.setAttribute(k, v);
      }
    }
  }
  for (const c of children) {
    if (c == null) continue;
    if (typeof c === "string") node.appendChild(document.createTextNode(c));
    else node.appendChild(c);
  }
  return node;
}

// ---- storage ------------------------------------------------------------

function loadState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ["settings", "paid", "whitelistedChannels", "customCSS", "sessionStats",
       "pausedUntil", "focusLock", "timeTracking"],
      (data) => {
        STATE.paid = !!data.paid;
        STATE.settings = data.settings || {};
        STATE.whitelistedChannels = data.whitelistedChannels || [];
        STATE.customCSS = data.customCSS || "";
        STATE.stats = data.sessionStats || { total: 0, perBlocker: {} };
        STATE.pausedUntil = Number(data.pausedUntil) || 0;
        STATE.focusLock = data.focusLock || { pinSet: false, activeUntil: 0 };
        STATE.timeTracking = data.timeTracking || {};
        resolve();
      }
    );
  });
}

function isFocusLockActive() {
  // Active iff there is a focusLock object AND it has a non-zero
  // activeUntil that is still in the future. v1.2.3: spelled out
  // explicitly because the `focusLock` object itself is always truthy
  // — `activeUntil` is the only field that signals "active".
  const lock = STATE.focusLock;
  return !!(
    lock &&
    lock.activeUntil &&
    Number(lock.activeUntil) > Date.now()
  );
}

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

function renderTimeMini() {
  const tt = STATE.timeTracking || {};
  const today = tt[_todayKey()] || 0;
  let weekSec = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    weekSec += tt[k] || 0;
  }
  $("cf-time-today-mini").textContent = _formatMin(today);
  $("cf-time-week-mini").textContent  = _formatMin(weekSec);
}

function persistSettings() {
  return chrome.storage.local.set({ settings: STATE.settings });
}

function pushSettingsToTabs() {
  chrome.runtime.sendMessage({
    type: "cf:push-settings",
    settings: STATE.settings,
    paid: STATE.paid,
    whitelistedChannels: STATE.whitelistedChannels,
    customCSS: STATE.customCSS,
    pausedUntil: STATE.pausedUntil,
  }).catch(() => {});
}

async function refreshPaidStatus() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "cf:get-paid" }, (resp) => {
      if (resp && typeof resp.paid === "boolean") STATE.paid = resp.paid;
      resolve();
    });
  });
}

// ---- pause feature ------------------------------------------------------

function isPaused() {
  return STATE.pausedUntil > Date.now();
}

function formatRemaining(ms) {
  if (ms <= 0) return "0:00";
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function togglePause() {
  if (isPaused()) {
    STATE.pausedUntil = 0;
  } else {
    STATE.pausedUntil = Date.now() + PAUSE_DURATION_MS;
  }
  await chrome.storage.local.set({ pausedUntil: STATE.pausedUntil });
  pushSettingsToTabs();
  renderPause();
  renderBlockers();
}

// Render the red Focus Lock banner with a live MM:SS countdown.
//
// v1.2.2 fixes:
//   * Every tick now logs to DevTools (so a stuck "--:--" is diagnosable).
//   * Storage is re-read defensively each tick — if a background process
//     auto-expires the lock, the popup notices and clears itself even
//     without an explicit storage.onChanged push.
//   * updateRemaining() is called immediately AND on a 1-second interval
//     starting at popup-open time so the user sees real time within ~1s.
function renderFocusBanner() {
  const banner = $("cf-focus-banner");
  if (!isFocusLockActive()) {
    banner.hidden = true;
    if (focusTickHandle) { clearInterval(focusTickHandle); focusTickHandle = 0; }
    return;
  }
  banner.hidden = false;

  const updateRemaining = () => {
    const until = Number(STATE.focusLock && STATE.focusLock.activeUntil) || 0;
    const ms = until - Date.now();
    console.log("[CleanFeed] focus-lock tick", {
      activeUntil: until, msRemaining: ms,
    });
    if (ms <= 0) {
      console.log("[CleanFeed] focus-lock auto-expired");
      STATE.focusLock = Object.assign({}, STATE.focusLock, { activeUntil: 0 });
      chrome.storage.local.set({ focusLock: STATE.focusLock });
      renderFocusBanner();
      renderBlockers();
      return;
    }
    // "Until I unlock" uses a far-future timestamp
    if (ms > 365 * 24 * 60 * 60 * 1000) {
      $("cf-focus-remaining").textContent = "Until you unlock";
      return;
    }
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const text = h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    $("cf-focus-remaining").textContent = text;
  };

  // Tick once now so the user sees the real value within the first paint,
  // not the static "--:--" placeholder that's in the HTML.
  updateRemaining();
  if (focusTickHandle) clearInterval(focusTickHandle);
  focusTickHandle = setInterval(updateRemaining, 1000);
}

// ----- 60-second hold-to-unlock (Focus Lock emergency bypass) -----
//
// Implementation: pointerdown starts a CSS transition that animates the
// progress bar from 0% → 100% over exactly HOLD_DURATION_MS, AND schedules
// a single setTimeout to fire _completeHold() at the same time. Releasing
// or moving the pointer off the button cancels both.
//
// Touch fallback uses touchstart / touchend / touchcancel — same handlers.
let _holdTimeoutHandle = 0;

function _startHold(e) {
  console.log("[CleanFeed] hold-to-unlock: pointerdown");
  if (!isFocusLockActive()) {
    console.log("[CleanFeed] hold-to-unlock: ignored (lock not active)");
    return;
  }
  if (_holdTimeoutHandle) {
    console.log("[CleanFeed] hold-to-unlock: ignored (already holding)");
    return;
  }
  const btn = $("cf-focus-hold");
  const bar = $("cf-hold-progress");
  if (!btn || !bar) {
    console.warn("[CleanFeed] hold-to-unlock: DOM elements missing");
    return;
  }
  btn.classList.add("is-holding");

  // Snap to 0% with no transition, force reflow, then animate to 100%
  // over the full 60 seconds using a single CSS transition.
  bar.style.transition = "none";
  bar.style.width = "0%";
  void bar.offsetWidth;  // force reflow so the transition starts cleanly
  bar.style.transition = `width ${HOLD_DURATION_MS}ms linear`;
  bar.style.width = "100%";

  _holdTimeoutHandle = setTimeout(() => {
    _holdTimeoutHandle = 0;
    _completeHold();
  }, HOLD_DURATION_MS);
}

function _cancelHold(e) {
  if (!_holdTimeoutHandle) return;
  console.log("[CleanFeed] hold-to-unlock: cancelled");
  clearTimeout(_holdTimeoutHandle);
  _holdTimeoutHandle = 0;
  const btn = $("cf-focus-hold");
  const bar = $("cf-hold-progress");
  if (btn) btn.classList.remove("is-holding");
  if (bar) {
    // Snap progress bar back to 0% with a short retraction animation
    bar.style.transition = "width 200ms ease-out";
    bar.style.width = "0%";
  }
}

async function _completeHold() {
  console.log("[CleanFeed] hold-to-unlock: complete — disabling Focus Lock");
  const btn = $("cf-focus-hold");
  const bar = $("cf-hold-progress");
  if (btn) btn.classList.remove("is-holding");
  if (bar) {
    bar.style.transition = "width 200ms ease-out";
    bar.style.width = "0%";
  }
  // Per v1.2.2 spec: clear active state AND the PIN hash on emergency
  // bypass — the user must re-set a PIN before starting a new session.
  STATE.focusLock = {
    pinSet: false,
    activeUntil: 0,
    pinHash: "",
    pinSalt: "",
  };
  await chrome.storage.local.set({ focusLock: STATE.focusLock });
  renderFocusBanner();
  renderBlockers();
}

function renderPause() {
  const text = $("cf-pause-text");
  // While Focus Lock is active, pause is disabled — the lock owns the state.
  $("cf-pause-btn").disabled = isFocusLockActive() && STATE.paid;
  if (isPaused()) {
    document.body.classList.add("cf-paused-state");
    const remaining = STATE.pausedUntil - Date.now();
    text.textContent = `Paused — ${formatRemaining(remaining)} remaining`;
    if (!pauseTickHandle) {
      pauseTickHandle = setInterval(() => {
        if (!isPaused()) {
          STATE.pausedUntil = 0;
          renderPause();
          renderBlockers();
          return;
        }
        text.textContent = `Paused — ${formatRemaining(STATE.pausedUntil - Date.now())} remaining`;
      }, 1000);
    }
  } else {
    document.body.classList.remove("cf-paused-state");
    text.textContent = "Pause for 1 hour";
    if (pauseTickHandle) {
      clearInterval(pauseTickHandle);
      pauseTickHandle = 0;
    }
  }
}

// ---- counting active free blockers --------------------------------------

function countActiveFreeBlockers() {
  let count = 0;
  for (const b of BLOCKERS) {
    if (b.tier === "free" && STATE.settings[b.id]) count++;
  }
  return count;
}

// ---- rendering ----------------------------------------------------------

function renderTierBadge() {
  const badge = $("cf-tier-badge");
  if (STATE.paid) {
    badge.textContent = "PRO";
    badge.classList.add("pro");
  } else {
    badge.textContent = "FREE";
    badge.classList.remove("pro");
  }
}

function renderUpgrade() {
  const card = $("cf-upgrade-card");
  card.hidden = !!STATE.paid;
}

function renderStats() {
  const total = (STATE.stats && STATE.stats.total) || 0;
  $("cf-stat-total").textContent = total.toLocaleString();
}

function renderBlockers() {
  const container = $("cf-blockers");
  while (container.firstChild) container.removeChild(container.firstChild);

  const paused = isPaused();
  const focusActive = isFocusLockActive();
  const activeFree = countActiveFreeBlockers();

  for (const b of BLOCKERS) {
    const locked = b.tier === "pro" && !STATE.paid;
    const checked = !!STATE.settings[b.id] && !locked;
    const wouldExceedFreeLimit =
      !STATE.paid &&
      b.tier === "free" &&
      !STATE.settings[b.id] &&
      activeFree >= FREE_LIMIT;

    const row = el("div", { class: "cf-row" + (locked ? " locked" : "") });

    const text = el("div", { class: "cf-row-text" });
    const labelLine = el("div", { class: "cf-row-label" }, b.label);
    if (locked) {
      labelLine.appendChild(el("span", { class: "cf-lock" }, "PRO"));
    }
    text.appendChild(labelLine);
    text.appendChild(el("div", { class: "cf-row-desc" }, b.desc));
    row.appendChild(text);

    const sw = el("label", {
      class: "cf-switch",
      title: locked
        ? "Upgrade to Pro to enable"
        : (paused ? "Paused — switches still configure your defaults" : ""),
    });
    // While Focus Lock is active for a paid user, all blockers are
    // force-on and the switches are disabled (the lock owns them).
    const forcedOn = focusActive && STATE.paid;
    const input = el("input", {
      type: "checkbox",
      id: "tg-" + b.id,
      checked: forcedOn ? true : checked,
      disabled: locked || wouldExceedFreeLimit || forcedOn,
    });
    input.addEventListener("change", () => onToggle(b, input));
    const slider = el("span", { class: "cf-slider" });
    sw.appendChild(input);
    sw.appendChild(slider);
    row.appendChild(sw);

    if (locked) {
      row.addEventListener("click", (e) => {
        if (e.target.tagName === "INPUT") return;
        openUpsellModal();
      });
    }
    container.appendChild(row);
  }
}

// ---- interactions -------------------------------------------------------

async function onToggle(blocker, inputEl) {
  if (blocker.tier === "pro" && !STATE.paid) {
    inputEl.checked = false;
    openUpsellModal();
    return;
  }
  if (!STATE.paid && blocker.tier === "free" && inputEl.checked) {
    if (countActiveFreeBlockers() >= FREE_LIMIT) {
      inputEl.checked = false;
      renderBlockers();
      return;
    }
  }
  STATE.settings[blocker.id] = !!inputEl.checked;
  await persistSettings();
  pushSettingsToTabs();
  renderBlockers();
}

function openPayment() {
  chrome.runtime.sendMessage({ type: "cf:open-payment" }).catch(() => {});
  // close popup so user can see the payment tab
  window.close();
}
function openLogin() {
  // v1.2.4: routes straight through the official ExtPay SDK's
  // openLoginPage() (handled in background.js), which opens ExtPay's
  // hosted email-collection page. Skips our branded login.html — the
  // SDK has no extpay.login(email) we could call from a custom form,
  // so anything we built locally would just bounce the user here anyway.
  chrome.runtime.sendMessage({ type: "cf:open-login" }).catch(() => {});
  window.close();
}

function resetStats() {
  STATE.stats = { total: 0, perBlocker: {} };
  chrome.storage.local.set({ sessionStats: STATE.stats });
  chrome.tabs.query({ url: "*://*.youtube.com/*" }, (tabs) => {
    for (const t of tabs) {
      chrome.tabs.sendMessage(t.id, { type: "cf:reset-stats" }).catch(() => {});
    }
  });
  renderStats();
}

// ---- upsell modal -------------------------------------------------------

function openUpsellModal() {
  const m = $("cf-modal");
  m.hidden = false;
  m.setAttribute("aria-hidden", "false");
  // focus the upgrade button after the slide-in animation
  setTimeout(() => $("cf-modal-upgrade").focus(), 60);
  document.addEventListener("keydown", onModalKey, { once: false });
}

function closeUpsellModal() {
  const m = $("cf-modal");
  m.hidden = true;
  m.setAttribute("aria-hidden", "true");
  document.removeEventListener("keydown", onModalKey);
}

function onModalKey(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    closeUpsellModal();
  }
}

// ---- bootstrap ----------------------------------------------------------

async function init() {
  // Show version from manifest
  try {
    $("cf-version").textContent = "v" + chrome.runtime.getManifest().version;
  } catch (_) {}

  await loadState();
  renderTierBadge();
  renderStats();
  renderUpgrade();
  renderFocusBanner();
  renderTimeMini();
  renderPause();
  renderBlockers();

  // Refresh paid status from background; re-render the parts that depend on it.
  await refreshPaidStatus();
  renderTierBadge();
  renderUpgrade();
  renderBlockers();

  // Fixed buttons
  $("cf-upgrade").addEventListener("click", openUpsellModal);
  $("cf-login").addEventListener("click", openLogin);
  $("cf-reset-stats").addEventListener("click", resetStats);
  $("cf-open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("cf-open-onboarding").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding/welcome.html") });
  });

  $("cf-pause-btn").addEventListener("click", togglePause);

  // Hold-to-disable Focus Lock — pointerdown starts, leave/up cancels.
  const holdBtn = $("cf-focus-hold");
  holdBtn.addEventListener("pointerdown", _startHold);
  holdBtn.addEventListener("pointerup", _cancelHold);
  holdBtn.addEventListener("pointerleave", _cancelHold);
  holdBtn.addEventListener("pointercancel", _cancelHold);
  // touch fallback (some Chrome versions don't trigger pointer events for touch)
  holdBtn.addEventListener("touchstart", _startHold, { passive: true });
  holdBtn.addEventListener("touchend", _cancelHold);
  holdBtn.addEventListener("touchcancel", _cancelHold);

  // Modal buttons
  $("cf-modal-upgrade").addEventListener("click", openPayment);
  $("cf-modal-login").addEventListener("click", openLogin);
  // Close on backdrop or explicit close
  document.querySelectorAll("[data-cf-close-modal]").forEach((el) => {
    el.addEventListener("click", closeUpsellModal);
  });

  // Live update on storage change
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.paid) {
      STATE.paid = !!changes.paid.newValue;
      renderTierBadge();
      renderBlockers();
      renderUpgrade();
    }
    if (changes.settings) {
      STATE.settings = changes.settings.newValue || {};
      renderBlockers();
    }
    if (changes.sessionStats) {
      STATE.stats = changes.sessionStats.newValue || { total: 0, perBlocker: {} };
      renderStats();
    }
    if (changes.pausedUntil) {
      STATE.pausedUntil = Number(changes.pausedUntil.newValue) || 0;
      renderPause();
      renderBlockers();
    }
    if (changes.focusLock) {
      STATE.focusLock = changes.focusLock.newValue || STATE.focusLock;
      renderFocusBanner();
      renderPause();
      renderBlockers();
    }
    if (changes.timeTracking) {
      STATE.timeTracking = changes.timeTracking.newValue || {};
      renderTimeMini();
    }
  });
}

document.addEventListener("DOMContentLoaded", init);
