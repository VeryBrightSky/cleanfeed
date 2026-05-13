/* CleanFeed — popup.js (v1.1)
 *
 * Adds:
 *   • 2 new Pro blockers (live-chat, autoplay)
 *   • Pause-for-1-hour with live countdown + auto-resume
 *   • Pro upsell modal triggered by:
 *       - clicking a locked Pro toggle
 *       - clicking the main "Unlock all 8 blockers" CTA
 *       (ESC + outside-click + close-button all dismiss it)
 *   • "I already paid" routes through background.js to extpay.openLoginPage()
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
  // v1.4.0 — F5
  { id: "playables",     label: "Playables games panel",    desc: "Hides the games shelf YouTube shows in some regions", tier: "pro" },
  { id: "merch-shelf",   label: "Merch shelf",              desc: "Hides merchandise shelves under videos",            tier: "free" },
  { id: "breaking-news", label: "Breaking news",            desc: "Hides the breaking-news shelf at the top of home",  tier: "free" },
  { id: "mixes-playlists", label: "Mixes & playlists",     desc: "Hides 'Mix' radios and algorithmic playlist suggestions", tier: "pro" },
];
const FREE_LIMIT = 2;
const HOLD_DURATION_MS = 60 * 1000;
const PRESETS = {
  "just-shorts": ["shorts"],
  "focused":     ["shorts", "home-feed", "end-screen", "autoplay"],
  "minimal":     ["shorts", "home-feed", "watch-sidebar", "end-screen", "comments", "explore", "autoplay", "thumbnails"],
};
const REVIEW_THRESHOLD = 5;
// Replace REPLACE_WITH_FINAL_ID once CWS listing is live with the real extension ID.
const REVIEW_URL = "https://chromewebstore.google.com/detail/REPLACE_WITH_FINAL_ID/reviews";

const STATE = {
  paid: false,
  settings: {},
  whitelistedChannels: [],
  customCSS: "",
  stats: { total: 0, perBlocker: {} },
  pausedUntil: 0,
  focusLock: { pinSet: false, activeUntil: 0, mode: "standard", pomodoroState: null },
  timeTracking: {},
  onboardingComplete: true,
  usageCount: 0,
  reviewPromptShown: false,
  // v1.4.1
  perPageEnabled: false,
  perPageSettings: { homepage: {}, watch: {}, subscriptions: {} },
  activeTab: "everywhere",   // "everywhere" | "homepage" | "watch" | "subscriptions"
};
const PAGE_TABS = [
  { key: "everywhere",     label: "Everywhere" },
  { key: "homepage",       label: "Homepage" },
  { key: "watch",          label: "Watch page" },
  { key: "subscriptions",  label: "Subscriptions" },
];

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
       "pausedUntil", "focusLock", "timeTracking",
       "onboardingComplete", "usageCount", "reviewPromptShown",
       "perPageEnabled", "perPageSettings"],
      (data) => {
        STATE.paid = !!data.paid;
        STATE.settings = data.settings || {};
        STATE.whitelistedChannels = data.whitelistedChannels || [];
        STATE.customCSS = data.customCSS || "";
        STATE.stats = data.sessionStats || { total: 0, perBlocker: {} };
        STATE.pausedUntil = Number(data.pausedUntil) || 0;
        STATE.focusLock = data.focusLock || { pinSet: false, activeUntil: 0 };
        STATE.timeTracking = data.timeTracking || {};
        STATE.onboardingComplete = !!data.onboardingComplete;
        STATE.usageCount = Number(data.usageCount) || 0;
        STATE.reviewPromptShown = !!data.reviewPromptShown;
        STATE.perPageEnabled = !!data.perPageEnabled;
        STATE.perPageSettings = data.perPageSettings || { homepage: {}, watch: {}, subscriptions: {} };
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
      // Guard against a sleeping service worker / closed port —
      // chrome.runtime.lastError is set when the callback fires without
      // a valid response. Treat that as "no update" and keep cached state.
      if (chrome.runtime.lastError) {
        resolve();
        return;
      }
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
  const pomo = STATE.focusLock && STATE.focusLock.pomodoroState;
  const standardActive = isFocusLockActive() && !pomo;
  const pomoActive = !!pomo && Number(pomo.until) > Date.now();
  if (!standardActive && !pomoActive) {
    banner.hidden = true;
    if (focusTickHandle) { clearInterval(focusTickHandle); focusTickHandle = 0; }
    return;
  }
  banner.hidden = false;

  const updateRemaining = () => {
    // v1.4.0 — Pomodoro takes precedence over standard countdown
    if (pomoActive) {
      const st = STATE.focusLock.pomodoroState;
      const ms = Number(st.until) - Date.now();
      if (ms <= 0) {
        // background's alarm will swap phase shortly; show a placeholder
        $("cf-focus-remaining").textContent = "transitioning…";
        return;
      }
      const total = Math.floor(ms / 1000);
      const m = Math.floor(total / 60);
      const s = total % 60;
      const phaseLabel = st.phase === "focus" ? "FOCUS" : "BREAK";
      $("cf-focus-remaining").textContent =
        `${phaseLabel} ${m}:${String(s).padStart(2, "0")} · Cycle ${st.cycle} of ${st.total}`;
      return;
    }
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

  // v1.4.1 — Per-page rules tab bar. Only render when the user has
  // opted in via options AND is Pro. Edge case: Free user with
  // perPageEnabled accidentally set to true → show Everywhere tab
  // only + a locked-feature banner that opens the upsell on tap.
  const perPageOn = STATE.perPageEnabled === true;
  if (perPageOn) {
    renderTabBar(container);
    if (!STATE.paid) {
      // free user — collapse to Everywhere tab and show upsell hint
      STATE.activeTab = "everywhere";
      const lock = el("div", { class: "cf-perpage-locked" },
        el("span", null, "Per-page rules is a Pro feature — "),
        el("button", {
          type: "button",
          class: "cf-link cf-perpage-upgrade",
          onclick: () => openUpsellModal(),
        }, "Upgrade"),
      );
      container.appendChild(lock);
    }
  } else {
    STATE.activeTab = "everywhere";
  }

  const paused = isPaused();
  const focusActive = isFocusLockActive();
  const activeFree = countActiveFreeBlockers();
  const onEverywhere = STATE.activeTab === "everywhere";

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

    if (onEverywhere) {
      // Standard on/off toggle (the existing v1.4.0 behaviour).
      const sw = el("label", {
        class: "cf-switch",
        title: locked
          ? "Upgrade to Pro to enable"
          : (paused ? "Paused — switches still configure your defaults" : ""),
      });
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
    } else {
      // Per-page tab: 3-state segmented control (on / off / inherit)
      const seg = renderPerPageSegment(b);
      row.appendChild(seg);
    }

    if (locked) {
      row.addEventListener("click", (e) => {
        if (e.target.tagName === "INPUT") return;
        openUpsellModal();
      });
    }
    container.appendChild(row);
  }
}

// ---- v1.4.1 per-page tab bar + 3-state segments ----
function renderTabBar(container) {
  const bar = el("div", { class: "cf-tab-bar", role: "tablist" });
  for (const t of PAGE_TABS) {
    const btn = el("button", {
      type: "button",
      role: "tab",
      class: "cf-tab" + (STATE.activeTab === t.key ? " is-active" : ""),
      "aria-selected": STATE.activeTab === t.key ? "true" : "false",
    }, t.label);
    btn.addEventListener("click", () => {
      STATE.activeTab = t.key;
      renderBlockers();
    });
    bar.appendChild(btn);
  }
  container.appendChild(bar);
}

function _readPerPageValue(pageKey, blockerId) {
  const page = STATE.perPageSettings[pageKey] || {};
  const v = page[blockerId];
  return v === "on" || v === "off" ? v : "inherit";
}

async function _writePerPageValue(pageKey, blockerId, value) {
  const all = Object.assign({ homepage: {}, watch: {}, subscriptions: {} }, STATE.perPageSettings || {});
  const page = Object.assign({}, all[pageKey] || {});
  if (value === "inherit") {
    delete page[blockerId];
  } else {
    page[blockerId] = value;
  }
  all[pageKey] = page;
  STATE.perPageSettings = all;
  await chrome.storage.local.set({ perPageSettings: all });
  pushSettingsToTabs();
}

function renderPerPageSegment(b) {
  const wrap = el("div", { class: "cf-seg" });
  const cur = _readPerPageValue(STATE.activeTab, b.id);
  const opts = [
    { v: "on",      label: "On" },
    { v: "off",     label: "Off" },
    { v: "inherit", label: "Inherit" },
  ];
  const proLocked = b.tier === "pro" && !STATE.paid;
  for (const o of opts) {
    const btn = el("button", {
      type: "button",
      class: "cf-seg-btn" + (cur === o.v ? " is-active" : ""),
      "aria-pressed": cur === o.v ? "true" : "false",
      disabled: proLocked,
    }, o.label);
    btn.addEventListener("click", async () => {
      if (proLocked) { openUpsellModal(); return; }
      await _writePerPageValue(STATE.activeTab, b.id, o.v);
      renderBlockers();
    });
    wrap.appendChild(btn);
  }
  return wrap;
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

  // v1.4.0 F3 — bump usage counter for review-prompt gating
  STATE.usageCount = (STATE.usageCount || 0) + 1;
  chrome.storage.local.set({ usageCount: STATE.usageCount });

  // v1.4.0 F2 — show onboarding view instead of toggle grid if first install
  if (!STATE.onboardingComplete) {
    renderOnboarding();
    return;
  }

  renderTierBadge();
  renderStats();
  renderUpgrade();
  renderFocusBanner();
  renderTimeMini();
  renderPause();
  renderBlockers();
  renderReviewPrompt();

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
    if (changes.perPageEnabled) {
      STATE.perPageEnabled = !!changes.perPageEnabled.newValue;
      renderBlockers();
    }
    if (changes.perPageSettings) {
      STATE.perPageSettings = changes.perPageSettings.newValue || { homepage: {}, watch: {}, subscriptions: {} };
      renderBlockers();
    }
  });
}

// ---------- v1.4.0 F2 — onboarding view ----------
function renderOnboarding() {
  const root = document.body;
  // hide everything except header (and footer maybe)
  document.querySelectorAll(
    ".cf-stats, .cf-time-mini, .cf-pause-bar, .cf-blockers, .cf-upgrade, .cf-focus-banner"
  ).forEach((el) => { el.style.display = "none"; });

  // Build onboarding container if not already present
  let host = document.getElementById("cf-onboarding");
  if (host) host.remove();
  host = document.createElement("section");
  host.id = "cf-onboarding";
  host.className = "cf-onboarding";

  const h = document.createElement("h2");
  h.textContent = "How distraction-free do you want YouTube?";
  host.appendChild(h);

  const card = (key, title, subtitle, popular) => {
    const c = document.createElement("button");
    c.type = "button";
    c.className = "cf-onb-card" + (popular ? " is-popular" : "");
    c.dataset.preset = key;
    const t = document.createElement("strong");
    t.textContent = title;
    const s = document.createElement("span");
    s.textContent = subtitle;
    c.appendChild(t);
    c.appendChild(s);
    if (popular) {
      const tag = document.createElement("em");
      tag.textContent = "MOST POPULAR";
      tag.className = "cf-onb-tag";
      c.appendChild(tag);
    }
    c.addEventListener("click", () => onPresetChosen(key));
    return c;
  };
  host.appendChild(card("just-shorts", "Just no Shorts", "I still want the homepage and recommendations.", false));
  host.appendChild(card("focused",     "Focused",        "Hide the worst rabbit holes. Keep search and watch pages clean enough to use.", true));
  host.appendChild(card("minimal",     "Minimal",        "Almost nothing. Pure watching.", false));

  const skip = document.createElement("button");
  skip.type = "button";
  skip.className = "cf-link cf-onb-skip";
  skip.textContent = "Skip — let me configure manually";
  skip.addEventListener("click", () => onPresetChosen(null));
  host.appendChild(skip);

  // Insert just after the header
  const header = document.querySelector(".cf-header");
  if (header && header.parentNode) {
    header.parentNode.insertBefore(host, header.nextSibling);
  } else {
    document.body.appendChild(host);
  }
}

async function onPresetChosen(presetKey) {
  let nextSettings = Object.assign({}, STATE.settings);
  // Reset all blockers to false first
  for (const b of BLOCKERS) nextSettings[b.id] = false;
  let upsellNeeded = false;
  if (presetKey) {
    const ids = PRESETS[presetKey] || [];
    if (STATE.paid) {
      for (const id of ids) nextSettings[id] = true;
    } else {
      // Free users: cap at 2 free-tier blockers in the preset order
      let on = 0;
      for (const id of ids) {
        const def = BLOCKERS.find((b) => b.id === id);
        if (def && def.tier === "free" && on < FREE_LIMIT) {
          nextSettings[id] = true; on++;
        } else if (def && def.tier !== "free") {
          upsellNeeded = true;
        }
      }
      if (ids.length > on) upsellNeeded = upsellNeeded || (on < ids.length);
    }
  }
  STATE.settings = nextSettings;
  await chrome.storage.local.set({
    settings: nextSettings,
    onboardingComplete: true,
    onboardingChoice: presetKey || "skip",
  });
  STATE.onboardingComplete = true;
  // Clean up onboarding UI, then bring back the regular popup view
  const ob = document.getElementById("cf-onboarding");
  if (ob) ob.remove();
  document.querySelectorAll(
    ".cf-stats, .cf-time-mini, .cf-pause-bar, .cf-blockers, .cf-upgrade"
  ).forEach((el) => { el.style.display = ""; });
  renderTierBadge();
  renderStats();
  renderUpgrade();
  renderFocusBanner();
  renderTimeMini();
  renderPause();
  renderBlockers();
  pushSettingsToTabs();
  if (upsellNeeded) openUpsellModal();
}

// ---------- v1.4.0 F3 — review prompt banner ----------
function renderReviewPrompt() {
  // remove any existing
  const old = document.getElementById("cf-review-banner");
  if (old) old.remove();
  if (STATE.reviewPromptShown || STATE.usageCount < REVIEW_THRESHOLD) return;
  const banner = document.createElement("section");
  banner.id = "cf-review-banner";
  banner.className = "cf-review-banner";
  // (no innerHTML assignment — element is freshly created so already empty)
  const txt = document.createElement("span");
  txt.textContent = "Enjoying CleanFeed? A quick review on the Chrome Web Store would really help.";
  const row = document.createElement("div");
  row.className = "cf-review-row";
  const review = document.createElement("button");
  review.type = "button";
  review.className = "cf-btn cf-btn-primary";
  review.textContent = "Leave a review";
  review.addEventListener("click", async () => {
    await markReviewShown();
    chrome.tabs.create({ url: REVIEW_URL });
    window.close();
  });
  const later = document.createElement("button");
  later.type = "button";
  later.className = "cf-btn cf-btn-ghost";
  later.textContent = "Maybe later";
  later.addEventListener("click", async () => {
    await markReviewShown();
    banner.remove();
  });
  row.appendChild(review);
  row.appendChild(later);
  banner.appendChild(txt);
  banner.appendChild(row);
  // append above footer
  const foot = document.querySelector(".cf-footer");
  if (foot && foot.parentNode) foot.parentNode.insertBefore(banner, foot);
  else document.body.appendChild(banner);

  // Mark as shown when popup closes — even without explicit click —
  // so we don't pester the user every popup open afterward.
  window.addEventListener("pagehide", markReviewShown, { once: true });
}
async function markReviewShown() {
  if (STATE.reviewPromptShown) return;
  STATE.reviewPromptShown = true;
  try { await chrome.storage.local.set({ reviewPromptShown: true }); } catch (_) {}
}

document.addEventListener("DOMContentLoaded", init);
