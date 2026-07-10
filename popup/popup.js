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
// v1.4.9 — any pausedUntil more than (now + max-duration + 5min slack) is
// treated as corrupted and reset to 0. Fail-OPEN here means fail-CLOSED for
// the user: a garbage timestamp can never pin the extension paused forever.
const PAUSE_MAX_SLACK_MS = 5 * 60 * 1000;
function sanePausedUntil(raw) {
  const n = Number(raw) || 0;
  if (n <= 0) return 0;
  if (n > Date.now() + PAUSE_DURATION_MS + PAUSE_MAX_SLACK_MS) return 0;
  return n;
}

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
  // v1.4.19 — three new Pro blockers for the Subscriptions feed.
  { id: "subs-most-relevant", label: "Hide 'Most Relevant' suggestions", desc: "On /feed/subscriptions, removes the algorithmic 'Most Relevant' insertion", tier: "pro" },
  { id: "subs-members-only",  label: "Hide members-only videos",         desc: "Hides subscription videos with a 'members only' badge",                    tier: "pro" },
  { id: "subs-watched",       label: "Hide already-watched (>95%)",      desc: "On /feed/subscriptions, hides videos whose progress bar is past 95%",      tier: "pro" },
];
const FREE_LIMIT = 2;
const HOLD_DURATION_MS = 60 * 1000;
const PRESETS = {
  "just-shorts": ["shorts"],
  "focused":     ["shorts", "home-feed", "end-screen", "autoplay"],
  "minimal":     ["shorts", "home-feed", "watch-sidebar", "end-screen", "comments", "explore", "autoplay", "thumbnails"],
};
const REVIEW_THRESHOLD = 5;
const REVIEW_URL = "https://chromewebstore.google.com/detail/mghmfmjlaelbkellppfneocliomiclnn/reviews";

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
  // v1.4.3 — flips true once loadState() resolves. STATE-dependent handlers
  // (togglePause, _startHold) guard on this so a click before storage loads
  // is a safe no-op instead of acting on the empty initial STATE.
  loaded: false,
  // v1.4.19 — per-blocker render mode override. Read from chrome.storage.local
  // (settings.blockerModes) at loadState; missing entries fall back to "hide".
  blockerModes: {},
  // v1.4.19 F2 — homepage → subscriptions redirect toggle (default OFF).
  redirectHomeToSubs: false,
  // v1.4.19 F1 — true when the active tab is on music.youtube.com. The popup
  // collapses to the YT Music explainer + hides the toggle grid.
  onYouTubeMusic: false,
  // v1.4.21 Phase 3 — subscription model. Read from chrome.storage.local
  // in loadState; defaults match the install-seed shape from background.js.
  cf_grandfathered: false,
  cf_grandfathered_reason: null,
  cf_subscription: { status: "none", plan: null, cancelAt: null, lastSyncAt: 0 },
  // v1.4.21 Phase 3 — analytics dashboard. Phase 1 (v1.4.20-alpha) collects
  // this; Phase 3 reads + renders. Schema documented in background.js.
  cf_stats: { blocked: {}, autoplay_avoided: {}, session_started: 0 },
};
// v1.4.21 Phase 3 — average video length used for the "time saved" estimate
// shown in the weekly stats card. Conservative midpoint; tracking precise
// per-video duration would require persisting metadata we don't currently
// have. 4 min matches the v1.4.20-alpha autoplay-avoidance fallback.
const CF_AVG_VIDEO_MIN = 4;
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

// v1.4.6 — On a brand-new install the popup can open BEFORE background's
// onInstalled handler has finished seeding defaults. Reading empty storage
// caused the popup to render the onboarding view, then onInstalled's later
// `set(defaults)` would clobber the user's preset choice and the popup
// looked broken until ~3 reopens. We now block on a `cf_initialized` flag
// (set in a separate write at the end of seeding) before loadState, with a
// short timeout fallback so a missing/old-storage edge case can't wedge us.
function _isInitialized(data) {
  if (data && data.cf_initialized === true) return true;
  // Existing users from pre-v1.4.6 won't have cf_initialized yet, but their
  // settings object exists. Treat populated settings as initialized too.
  if (data && data.settings && typeof data.settings === "object" &&
      Object.keys(data.settings).length > 0) {
    return true;
  }
  return false;
}

function waitForInitialized() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { chrome.storage.onChanged.removeListener(onChange); } catch (_) {}
      clearTimeout(safety);
      resolve();
    };
    function onChange(changes, area) {
      if (area !== "local") return;
      if (changes.cf_initialized && changes.cf_initialized.newValue === true) {
        finish();
        return;
      }
      // Defensive: if the seed write lands as a `settings` change first,
      // that's enough to proceed too.
      if (changes.settings && changes.settings.newValue &&
          typeof changes.settings.newValue === "object" &&
          Object.keys(changes.settings.newValue).length > 0) {
        finish();
      }
    }
    chrome.storage.onChanged.addListener(onChange);
    // First check — may already be initialized between bootstrap and here.
    chrome.storage.local.get(["cf_initialized", "settings"], (data) => {
      if (_isInitialized(data)) finish();
    });
    // Safety timeout — render with whatever we have rather than hang.
    // 3s is well past a healthy onInstalled seed (~10-50ms) but short
    // enough that the user isn't staring at the loading line forever.
    const safety = setTimeout(finish, 3000);
  });
}

function loadState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ["settings", "paid", "whitelistedChannels", "customCSS", "sessionStats",
       "pausedUntil", "focusLock", "timeTracking",
       "onboardingComplete", "usageCount", "reviewPromptShown",
       "perPageEnabled", "perPageSettings",
       // v1.4.19
       "blockerModes", "redirectHomeToSubs",
       // v1.4.21 Phase 3 — subscription + grandfather + dashboard data
       "cf_grandfathered", "cf_grandfathered_reason", "cf_subscription",
       "cf_stats",
       // v1.4.24 — Focus Schedule + usage streak + popup theme
       "focusSchedule", "cf_streak", "popupTheme"],
      (data) => {
        STATE.paid = !!data.paid;
        STATE.settings = data.settings || {};
        STATE.whitelistedChannels = data.whitelistedChannels || [];
        STATE.customCSS = data.customCSS || "";
        STATE.stats = data.sessionStats || { total: 0, perBlocker: {} };
        STATE.pausedUntil = sanePausedUntil(data.pausedUntil);
        STATE.focusLock = data.focusLock || { pinSet: false, activeUntil: 0 };
        STATE.timeTracking = data.timeTracking || {};
        STATE.onboardingComplete = !!data.onboardingComplete;
        // v1.4.2 — explicit integer coercion. Number(undefined) is NaN
        // which then "|| 0" yielded 0 anyway, but parseInt is the more
        // defensive expression and matches the spec verbatim.
        STATE.usageCount = parseInt(data.usageCount, 10) || 0;
        STATE.reviewPromptShown = !!data.reviewPromptShown;
        STATE.perPageEnabled = !!data.perPageEnabled;
        STATE.perPageSettings = data.perPageSettings || { homepage: {}, watch: {}, subscriptions: {} };
        STATE.blockerModes = (data.blockerModes && typeof data.blockerModes === "object") ? data.blockerModes : {};
        STATE.redirectHomeToSubs = !!data.redirectHomeToSubs;
        STATE.cf_grandfathered = data.cf_grandfathered === true;
        STATE.cf_grandfathered_reason = data.cf_grandfathered_reason || null;
        STATE.cf_subscription = (data.cf_subscription && typeof data.cf_subscription === "object")
          ? data.cf_subscription
          : { status: "none", plan: null, cancelAt: null, lastSyncAt: 0 };
        STATE.cf_stats = (data.cf_stats && typeof data.cf_stats === "object")
          ? data.cf_stats
          : { blocked: {}, autoplay_avoided: {}, session_started: 0 };
        // v1.4.24
        STATE.focusSchedule = (data.focusSchedule && typeof data.focusSchedule === "object")
          ? data.focusSchedule
          : { enabled: false, schedules: [] };
        STATE.cf_streak = (data.cf_streak && typeof data.cf_streak === "object")
          ? data.cf_streak
          : { streakCount: 0, lastActiveDate: null };
        STATE.popupTheme = data.popupTheme || "auto";
        resolve();
      }
    );
  });
}

// v1.4.19 F1 — detect active-tab host for the YT Music smart-exemption.
// Resolves a boolean even when chrome.tabs.query fails (popup opened on
// non-tab contexts, permissions blip, etc.) — default false (normal popup).
function detectActiveYouTubeMusicTab() {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError || !tabs || !tabs.length) {
          resolve(false);
          return;
        }
        const url = tabs[0].url || "";
        // host-match: bare music.youtube.com or any sub of it
        try {
          const u = new URL(url);
          const h = u.hostname || "";
          resolve(h === "music.youtube.com" || /(^|\.)music\.youtube\.com$/.test(h));
        } catch (_) {
          resolve(false);
        }
      });
    } catch (_) { resolve(false); }
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

// v1.4.9 — re-entrance lock for togglePause. Without this, rapid spam-clicks
// fire N overlapping async handlers that race on STATE.pausedUntil and on
// chrome.storage.local. The popup's own storage.onChanged listener can then
// clobber STATE between successive clicks' sync read-modify-write, leaving
// storage in a state that doesn't match the user's last intent. The lock
// + visible button-disable coalesces a burst into a single transition.
let togglePauseInFlight = false;

async function togglePause() {
  // v1.4.3 — handler is attached synchronously now; STATE.pausedUntil is 0
  // (the default) until loadState() resolves. A click before then would
  // happily start a 1-hour pause based on stale state. Ignore until loaded.
  if (!STATE.loaded) return;
  // v1.4.9 — if a previous toggle is still mid-flight (storage write or
  // re-render not yet finished) drop the click. The button is also disabled
  // visually for the duration so the user sees no-op feedback.
  if (togglePauseInFlight) return;
  togglePauseInFlight = true;
  const btn = $("cf-pause-btn");
  btn.disabled = true;
  try {
    if (isPaused()) {
      STATE.pausedUntil = 0;
    } else {
      STATE.pausedUntil = Date.now() + PAUSE_DURATION_MS;
    }
    await chrome.storage.local.set({ pausedUntil: STATE.pausedUntil });
    // v1.4.24.6 — render BEFORE tab messaging (same hardening as resumeNow):
    // the banner must appear/disappear in the open popup even if messaging
    // throws. Banner + button state are a pure function of STATE.pausedUntil.
    renderPause();
    renderBlockers();
    try { pushSettingsToTabs(); } catch (_) {}
  } finally {
    togglePauseInFlight = false;
    // renderPause() may have re-disabled the button if Focus Lock is active;
    // honour that. Otherwise re-enable.
    btn.disabled = isFocusLockActive() && STATE.paid;
  }
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
  // v1.4.3 — handler attaches synchronously on DOMContentLoaded so it works
  // on cold popup open. STATE.focusLock is empty until loadState() resolves;
  // ignore early clicks rather than acting on stale defaults.
  if (!STATE.loaded) return;
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

// v1.4.24.5 — the top-of-popup paused banner. Visible IFF paused; the
// sub-line is a live countdown re-rendered by the same 1s tick that drives
// the pause-button text. "Resumes in N min" above a minute, seconds below.
function renderPauseBanner() {
  const banner = $("cf-paused-banner");
  if (!banner) return;
  if (!isPaused()) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  const line = $("cf-paused-remaining");
  if (!line) return;
  const ms = STATE.pausedUntil - Date.now();
  line.textContent = ms >= 60 * 1000
    ? `Resumes in ${Math.ceil(ms / 60000)} min`
    : `Resumes in ${Math.max(1, Math.ceil(ms / 1000))}s`;
}

// v1.4.24.5 — "Resume now" in the paused banner. Clears the pause, then
// reloads YouTube tabs so blockers re-apply on a clean page (the content
// script would also catch the storage change, but a reload guarantees no
// half-hidden feed lingers). Shares togglePause's in-flight lock so a
// banner click and a pause-button click can't race each other.
//
// v1.4.24.6 — the paused UI (banner + pause button) is re-rendered HERE,
// synchronously, the moment the storage write resolves — BEFORE any tab
// messaging. v1.4.24.5 rendered last, after pushSettingsToTabs() and the
// chrome.tabs reload loop; an exception anywhere in that messaging path
// skipped the render and left the open popup showing a stale paused banner
// even though pausedUntil was already 0 (confirmed live). The DOM update
// must never depend on the messaging succeeding, nor on a storage.onChanged
// round-trip.
async function resumeNow() {
  if (!STATE.loaded || togglePauseInFlight) return;
  togglePauseInFlight = true;
  const btn = $("cf-resume-now");
  if (btn) btn.disabled = true;
  try {
    STATE.pausedUntil = 0;
    await chrome.storage.local.set({ pausedUntil: 0 });
    // 1) Popup UI first — banner hides, button resets to "Pause for 1 hour",
    //    countdown tick is torn down. Pure function of STATE.pausedUntil.
    renderPause();
    renderBlockers();
    // 2) Then best-effort tab messaging; each step isolated so a failure
    //    here can never affect the popup UI (already updated above).
    try { pushSettingsToTabs(); } catch (_) {}
    try {
      chrome.tabs.query(
        { url: ["*://*.youtube.com/*", "*://music.youtube.com/*"] },
        (tabs) => {
          void chrome.runtime.lastError;
          (tabs || []).forEach((t) => {
            try { chrome.tabs.reload(t.id); } catch (_) {}
          });
        }
      );
    } catch (_) {}
  } finally {
    togglePauseInFlight = false;
    if (btn) btn.disabled = false;
  }
}

function renderPause() {
  const text = $("cf-pause-text");
  // While Focus Lock is active, pause is disabled — the lock owns the state.
  $("cf-pause-btn").disabled = isFocusLockActive() && STATE.paid;
  if (isPaused()) {
    document.body.classList.add("cf-paused-state");
    const remaining = STATE.pausedUntil - Date.now();
    text.textContent = `Paused — ${formatRemaining(remaining)} remaining`;
    renderPauseBanner();
    if (!pauseTickHandle) {
      pauseTickHandle = setInterval(() => {
        if (!isPaused()) {
          STATE.pausedUntil = 0;
          renderPause();
          renderBlockers();
          return;
        }
        text.textContent = `Paused — ${formatRemaining(STATE.pausedUntil - Date.now())} remaining`;
        renderPauseBanner();
      }, 1000);
    }
  } else {
    document.body.classList.remove("cf-paused-state");
    text.textContent = "Pause for 1 hour";
    renderPauseBanner();
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

// v1.4.21 Phase 3 — return YYYY-MM-DD in the user's local timezone for the
// last N days, newest first. Mirrors content/content.js _todayLocalDateKey
// so cf_stats date keys line up exactly. Read-only; cheap to recompute.
function _lastNDateKeys(n) {
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

// v1.4.21 Phase 3 — sum cf_stats for the last 7 days into { videos,
// estimatedMinutes, autoplayVideos, autoplayMinutes }. `videos` is the
// total count of blocked elements summed across every blocker and day.
// `estimatedMinutes` uses CF_AVG_VIDEO_MIN as the per-video estimate.
// Autoplay-avoidance numbers come from the separate autoplay_avoided
// accumulator written by content.js _evaluateAutoplayAvoided.
function computeWeekStats() {
  const dates = _lastNDateKeys(7);
  const blocked = (STATE.cf_stats && STATE.cf_stats.blocked) || {};
  const auto = (STATE.cf_stats && STATE.cf_stats.autoplay_avoided) || {};
  let videos = 0;
  let autoplayVideos = 0;
  let autoplayMinutes = 0;
  for (const k of dates) {
    const day = blocked[k];
    if (day && typeof day === "object") {
      for (const id of Object.keys(day)) {
        const n = Number(day[id]) || 0;
        if (n > 0) videos += n;
      }
    }
    const adata = auto[k];
    if (adata && typeof adata === "object") {
      autoplayVideos += Number(adata.videos) || 0;
      autoplayMinutes += Number(adata.estimated_minutes) || 0;
    }
  }
  return {
    videos,
    estimatedMinutes: videos * CF_AVG_VIDEO_MIN,
    autoplayVideos,
    autoplayMinutes,
  };
}

// v1.4.21 Phase 3 — format "1h 14m" / "47m" / "0m" for the time-saved cell.
function _formatHM(totalMinutes) {
  const m = Math.max(0, Math.round(totalMinutes));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
}

function renderWeekStats() {
  const host = $("cf-week-stats");
  if (!host) return;
  // Hide on YT Music (matches the rest of the YT-Music-paused state).
  if (STATE.onYouTubeMusic) { host.hidden = true; return; }
  const s = computeWeekStats();
  // Reset content idempotently — popup may re-render on storage events.
  while (host.firstChild) host.removeChild(host.firstChild);
  if (s.videos === 0 && s.autoplayVideos === 0) {
    // All-zeros (new install / no activity). Show the prompt copy instead
    // of three 0/0/0 cells, per spec.
    const head = el("div", { class: "cf-week-head" }, "This week");
    const body = el("div", { class: "cf-week-empty" },
      "Browse YouTube to start tracking what you’re saving.");
    host.appendChild(head);
    host.appendChild(body);
    host.hidden = false;
    return;
  }
  const head = el("div", { class: "cf-week-head" }, "This week");
  const row = el("div", { class: "cf-week-row" },
    el("div", { class: "cf-week-cell" },
      el("span", { class: "cf-week-value" }, String(s.videos)),
      el("span", { class: "cf-week-label" }, s.videos === 1 ? "video blocked" : "videos blocked")
    ),
    el("span", { class: "cf-week-sep" }, "·"),
    el("div", { class: "cf-week-cell" },
      el("span", { class: "cf-week-value" }, _formatHM(s.estimatedMinutes)),
      el("span", { class: "cf-week-label" }, "saved")
    ),
  );
  host.appendChild(head);
  host.appendChild(row);
  if (s.autoplayVideos > 0) {
    host.appendChild(el("div", { class: "cf-week-extra" },
      `+ ${s.autoplayVideos} autoplay${s.autoplayVideos === 1 ? "" : "s"} avoided`));
  }
  host.hidden = false;
}

// ---------- v1.4.24 — popup theme (Auto / Dark / Light) ----------
// Forced themes set a class on <html>; "auto" removes both so the
// prefers-color-scheme media query in popup.css takes over.
function applyTheme(mode) {
  const root = document.documentElement;
  root.classList.remove("cf-theme-dark", "cf-theme-light");
  if (mode === "dark") root.classList.add("cf-theme-dark");
  else if (mode === "light") root.classList.add("cf-theme-light");
}

// ---------- v1.4.24 — today's stats one-liner ----------
function renderTodayStats() {
  const host = $("cf-today-bar");
  const line = $("cf-today-line");
  if (!host || !line) return;
  if (STATE.onYouTubeMusic) { host.hidden = true; return; }
  const F = (typeof self !== "undefined" && self.CFFeatures) ? self.CFFeatures : null;
  const blocked = (STATE.cf_stats && STATE.cf_stats.blocked) || {};
  const dayObj = blocked[_todayKey()];
  const today = (dayObj && typeof dayObj === "object") ? dayObj : {};
  const total = F ? F.totalToday(today) : 0;
  if (!F || total === 0) {
    line.textContent = "Open YouTube to start counting today’s blocks";
    line.classList.add("cf-today-empty");
    host.hidden = false;
    return;
  }
  line.classList.remove("cf-today-empty");
  const top = F.summarizeToday(today, 3, F.SHORT_LABELS);
  line.textContent = "Today: " + top.map((t) => `${t.count} ${t.label}`).join(" · ") + " hidden";
  host.hidden = false;
}

// ---------- v1.4.24 — quiet usage streak (no nudges, no alerts) ----------
function renderStreak() {
  const line = $("cf-streak-line");
  if (!line) return;
  const n = Number(STATE.cf_streak && STATE.cf_streak.streakCount) || 0;
  if (n < 1 || STATE.onYouTubeMusic) { line.hidden = true; return; }
  line.textContent = `🔥 ${n} day${n === 1 ? "" : "s"} using CleanFeed`;
  line.hidden = false;
}

// ---------- v1.4.24 — scheduled Focus Lock indicator ----------
function _formatClock(ms) {
  const n = Number(ms);
  try {
    return new Date(n).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch (_) {
    const d = new Date(n);
    return d.getHours() + ":" + String(d.getMinutes()).padStart(2, "0");
  }
}
function _relDayLabel(ms, now) {
  const a = new Date(Number(ms));
  const b = now || new Date();
  const da = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const db = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  const diff = Math.round((da - db) / 86400000);
  if (diff <= 0) return "today";
  if (diff === 1) return "tomorrow";
  try { return a.toLocaleDateString(undefined, { weekday: "long" }); }
  catch (_) { return "in " + diff + " days"; }
}
function renderScheduleIndicator() {
  const host = $("cf-sched-indicator");
  const text = $("cf-sched-text");
  if (!host || !text) return;
  const F = (typeof self !== "undefined" && self.CFFeatures) ? self.CFFeatures : null;
  const fs = STATE.focusSchedule || { enabled: false, schedules: [] };
  if (!F || !fs.enabled || !Array.isArray(fs.schedules) || fs.schedules.length === 0 || STATE.onYouTubeMusic) {
    host.hidden = true; return;
  }
  const lock = STATE.focusLock || {};
  const lockedBySched = lock.scheduleInitiated && Number(lock.activeUntil || 0) > Date.now();
  if (lockedBySched) {
    const end = Number(lock.scheduleEndsAt || lock.activeUntil);
    text.textContent = "Active focus window until " + _formatClock(end);
    host.classList.add("cf-sched-active");
    host.hidden = false;
    return;
  }
  const next = F.findNextWindow(fs, new Date(), 8);
  if (next) {
    text.textContent = "Next focus window: " + _relDayLabel(next.startsAt) + " " + _formatClock(next.startsAt);
    host.classList.remove("cf-sched-active");
    host.hidden = false;
    return;
  }
  host.hidden = true;
}

// v1.4.21 Phase 3 — short locale-aware date string for "Pro ends Aug 12, 2026"
// renderings. Falls back to a numeric YYYY-MM-DD on Intl failure (very old
// runtimes — popup targets MV3-capable Chrome which always has Intl, but
// defensive).
function _formatRenewDate(ms) {
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

// v1.4.21 Phase 3 — six-state upgrade card. The whole body is JS-rendered
// to keep the six cases at a single source of truth; the spec cases A–F
// are dispatched on cf_grandfathered + cf_subscription.status.
//
//   A: cf_grandfathered=true                              -> lifetime ✓
//   B: status=active + plan=monthly                       -> manage
//   C: status=active + plan=annual                        -> manage
//   D: status=cancellation_pending                        -> resubscribe
//   E: status=past_due                                    -> amber update-card
//   F: status=canceled|none AND !cf_grandfathered         -> plan picker
//
// A defensive seventh case covers paid=true that doesn't match A–E (e.g. a
// freshly-redeemed license before ensureGrandfather has fired). Treat that
// transient state as Case A.
function renderUpgrade() {
  const host = $("cf-upgrade-card");
  if (!host) return;
  // Hide on YT Music (matches existing renderYouTubeMusicPause behavior).
  if (STATE.onYouTubeMusic) { host.hidden = true; return; }
  // Reset content idempotently.
  while (host.firstChild) host.removeChild(host.firstChild);
  // Drop variant classes on every render so transitions don't compound.
  host.className = "cf-upgrade";

  const sub = STATE.cf_subscription || {};
  const status = sub.status || "none";
  const plan = sub.plan || null;
  const cancelAt = sub.cancelAt || null;

  // --- Case A — grandfathered (lifetime) -----------------------------
  // Catches both legacy ExtPay one-time buyers and license-key redeemers,
  // plus the transient "paid=true but cf_grandfathered not yet set"
  // window after redemption.
  if (STATE.cf_grandfathered || (STATE.paid && status !== "active" &&
      status !== "cancellation_pending" && status !== "past_due")) {
    host.classList.add("is-lifetime");
    host.appendChild(el("div", { class: "cf-upgrade-state" },
      el("span", { class: "cf-tick", "aria-hidden": "true" }, "✓"),
      el("span", { class: "cf-upgrade-state-text" }, "Lifetime Pro active"),
      el("span", { class: "cf-heart", "aria-hidden": "true" }, "♥")));
    host.hidden = false;
    return;
  }

  // --- Cases B / C — active subscription -----------------------------
  if (status === "active") {
    host.classList.add("is-active");
    const planLabel = (plan === "annual") ? "Annual plan" : (plan === "monthly") ? "Monthly plan" : "Pro plan";
    host.appendChild(el("div", { class: "cf-upgrade-state" },
      el("span", { class: "cf-tick", "aria-hidden": "true" }, "✓"),
      el("span", { class: "cf-upgrade-state-text" }, `Pro active — ${planLabel}`)));
    const btn = el("button", { type: "button", class: "cf-btn cf-btn-ghost", id: "cf-manage-sub" }, "Manage subscription");
    btn.addEventListener("click", onManageSubscription);
    host.appendChild(btn);
    host.hidden = false;
    return;
  }

  // --- Case D — cancellation_pending ---------------------------------
  if (status === "cancellation_pending") {
    host.classList.add("is-cancellation-pending");
    const dateStr = _formatRenewDate(cancelAt);
    host.appendChild(el("div", { class: "cf-upgrade-state" },
      dateStr ? `Pro ends ${dateStr}` : "Pro ends at end of current period"));
    // v1.4.22 — Resubscribe routes to the lifetime checkout. monthly/annual
    // nicknames are deleted from ExtPay; lifetime is the only paid path.
    const btn = el("button", { type: "button", class: "cf-btn cf-btn-primary",
      "data-plan": "lifetime", id: "cf-resubscribe" },
      "Switch to Pro for life");
    btn.addEventListener("click", onResubscribeClick);
    host.appendChild(btn);
    host.hidden = false;
    return;
  }

  // --- Case E — past_due ---------------------------------------------
  if (status === "past_due") {
    host.classList.add("is-past-due");
    host.appendChild(el("div", { class: "cf-upgrade-state" },
      el("span", { class: "cf-warn", "aria-hidden": "true" }, "!"),
      el("span", { class: "cf-upgrade-state-text" }, "Card needs updating to keep Pro")));
    const btn = el("button", { type: "button", class: "cf-btn cf-btn-primary", id: "cf-update-payment" }, "Update payment method");
    btn.addEventListener("click", onManageSubscription);   // same Stripe portal
    host.appendChild(btn);
    host.hidden = false;
    return;
  }

  // --- Case F — upsell (canceled / none, NOT grandfathered) ----------
  // v1.4.22 — pricing revert. Single $4.99-once CTA. The Phase 3 side-by-
  // side monthly+annual cards are gone; competitive research (Unhook 800k
  // installs free, UnTrap subscription failure-mode, DF Tube paid clone)
  // made subscription wrong for this product at this scale. The grandfather
  // + cf_subscription scaffolding stays in storage for defensive reasons.
  host.classList.add("is-free");
  host.appendChild(el("h2", { class: "cf-upgrade-title" }, "Unlock all 17 blockers + Focus Lock"));
  host.appendChild(el("div", { class: "cf-upgrade-price" },
    el("span", { class: "cf-price" }, "$4.99"),
    el("span", { class: "cf-upgrade-once" }, "once · yours forever"),
  ));
  const getProBtn = el("button", {
    type: "button",
    class: "cf-btn cf-btn-primary cf-btn-lg cf-upgrade-cta",
    "data-plan": "lifetime",
    id: "cf-get-pro",
  }, "Get Pro");
  getProBtn.addEventListener("click", onGetProClick);
  host.appendChild(getProBtn);
  host.appendChild(el("p", { class: "cf-upgrade-features" },
    "No subscription. No upsell. No ads. One-time payment. Lifetime access."));
  // Already-paid path still routes through openLogin / extpay reactivate.
  const loginBtn = el("button", { type: "button", class: "cf-link cf-already-paid", id: "cf-login" }, "Already paid? Log in");
  loginBtn.addEventListener("click", openLogin);
  host.appendChild(loginBtn);

  host.hidden = false;
}

// v1.4.22 — Get Pro click handler. Single CTA. Always sends plan="lifetime"
// to background.js cf:open-payment, which routes through ExtPay's
// openPaymentPage("lifetime"). The plan field is preserved as a
// safety/future hedge — if a future revert re-enables multi-plan, only
// the data-plan attribute on this button needs to flip.
//
// v1.4.21-fix1 — each handler sets e._cfHandled = true so the delegated
// fallback on #cf-upgrade-card (see _attachStaticHandlers) doesn't
// double-dispatch the same click. The delegation exists as a safety net
// for re-render races; under normal operation these inline handlers fire
// first and the delegated path short-circuits.
function onGetProClick(e) {
  if (e) e._cfHandled = true;
  // Always lifetime now. data-plan is read defensively, but coerced to
  // "lifetime" if missing — single-plan world.
  const btn = e && e.currentTarget;
  const plan = (btn && btn.dataset && btn.dataset.plan === "lifetime") ? "lifetime" : "lifetime";
  _busyClickWithPayload(e, "Opening…", "cf:open-payment", { plan });
}
function onResubscribeClick(e) {
  // v1.4.22 — Case D (cancellation_pending) sends users to the lifetime
  // checkout too. They keep Pro through their current billing period,
  // and from v1.4.22 onwards the only paid path IS lifetime.
  if (e) e._cfHandled = true;
  _busyClickWithPayload(e, "Opening…", "cf:open-payment", { plan: "lifetime" });
}
function onManageSubscription(e) {
  // Open the Stripe customer portal — ExtPay's openLoginPage() is the
  // existing reactivate/manage route. Routed through background.js to
  // pick up the api_key first.
  if (e) e._cfHandled = true;
  _busyClick(e, "Opening…", "cf:open-login");
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

  // v1.4.19 F2 — Homepage → Subscriptions redirect row (free, default off).
  // Only on the "Everywhere" tab to avoid cluttering per-page views.
  if (onEverywhere) {
    container.appendChild(renderHomeRedirectRow());
  }

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
      // v1.4.19 F3 — per-blocker render-mode dropdown (Hide / Blur / Dim).
      // Autoplay has no DOM target (it's a JS handler), so the dropdown is
      // hidden for that one — Hide is the only meaningful mode.
      if (b.id !== "autoplay") {
        row.appendChild(renderModeDropdown(b, locked));
      }
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

// ---- v1.4.19 F3 — per-blocker render-mode dropdown (Hide / Blur / Dim) ----
function _effectiveModeFor(id) {
  const m = STATE.blockerModes && STATE.blockerModes[id];
  return (m === "blur" || m === "dim") ? m : "hide";
}

function renderModeDropdown(blocker, locked) {
  const sel = document.createElement("select");
  sel.className = "cf-mode-select";
  sel.id = "mode-" + blocker.id;
  sel.disabled = !!locked;
  sel.title = "How to hide this — fully (Hide), blurred (Blur), or dimmed (Dim).";
  const cur = _effectiveModeFor(blocker.id);
  for (const opt of [
    { v: "hide", label: "Hide" },
    { v: "blur", label: "Blur" },
    { v: "dim",  label: "Dim"  },
  ]) {
    const o = document.createElement("option");
    o.value = opt.v;
    o.textContent = opt.label;
    if (opt.v === cur) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener("change", async () => {
    await _writeBlockerMode(blocker.id, sel.value);
  });
  // Don't propagate clicks on the locked row to the upsell modal —
  // the select is a no-op when disabled, and the visual feedback is enough.
  sel.addEventListener("click", (e) => { e.stopPropagation(); });
  return sel;
}

async function _writeBlockerMode(id, mode) {
  const next = Object.assign({}, STATE.blockerModes || {});
  if (mode === "hide") {
    // Default — don't persist; missing entries are treated as "hide" by
    // _effectiveModeFor in content.js. Keeps the storage object small.
    delete next[id];
  } else {
    next[id] = mode;
  }
  STATE.blockerModes = next;
  await chrome.storage.local.set({ blockerModes: next });
  pushSettingsToTabs();
}

// ---- v1.4.19 F2 — homepage → subscriptions redirect row ----
function renderHomeRedirectRow() {
  const row = el("div", { class: "cf-row" });
  const text = el("div", { class: "cf-row-text" });
  text.appendChild(el("div", { class: "cf-row-label" }, "Open YouTube on Subscriptions"));
  text.appendChild(el("div", { class: "cf-row-desc" },
    "Auto-redirect youtube.com to /feed/subscriptions. Doesn't touch /watch, /results, /shorts, etc."));
  row.appendChild(text);

  const sw = el("label", { class: "cf-switch" });
  const input = el("input", {
    type: "checkbox",
    id: "tg-redirect-home-to-subs",
    checked: !!STATE.redirectHomeToSubs,
  });
  input.addEventListener("change", async () => {
    STATE.redirectHomeToSubs = !!input.checked;
    await chrome.storage.local.set({ redirectHomeToSubs: STATE.redirectHomeToSubs });
    // Push to active YT tabs so they react without a reload.
    pushSettingsToTabs();
  });
  sw.appendChild(input);
  sw.appendChild(el("span", { class: "cf-slider" }));
  row.appendChild(sw);
  return row;
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

// v1.4.10 — re-entrance lock for onToggle. Same shape as the v1.4.9
// togglePause fix: rapid checkbox clicks (or fast cross-toggle clicks)
// otherwise fire overlapping async handlers, each calling persistSettings
// + pushSettingsToTabs + renderBlockers. renderBlockers tears down and
// rebuilds the toggle <input> nodes, so a click that lands on a destroyed
// input is lost — same "toggles stop working" symptom flagged in the
// pause-bug audit. The lock coalesces a burst into a single transition.
let onToggleInFlight = false;

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
  // v1.4.10 — if a previous toggle's storage write is still in flight,
  // drop the click and revert the checkbox UI to the committed STATE so
  // no visual inconsistency lingers. Same-input clicks during the write
  // are also prevented by inputEl.disabled=true below.
  if (onToggleInFlight) {
    inputEl.checked = !!STATE.settings[blocker.id];
    return;
  }
  onToggleInFlight = true;
  inputEl.disabled = true;
  try {
    STATE.settings[blocker.id] = !!inputEl.checked;
    await persistSettings();
    pushSettingsToTabs();
    renderBlockers();
  } finally {
    onToggleInFlight = false;
    // renderBlockers() detaches the old inputEl; only re-enable if it's
    // still in the DOM (e.g. an early bail or a future code path).
    if (inputEl.isConnected) inputEl.disabled = false;
  }
}

// v1.4.2 — small generic "busy state" helper for upgrade / login clicks.
//
// Immediate feedback (button text + .is-busy class + disabled) so the
// click doesn't feel frozen. At 5 s we swap the text to
// "Still working… check your browser tabs" so the user knows where to
// look if the new tab opens behind the popup. At 8 s we restore the
// button as a safety net in case the background SW never responds —
// they can retry.
function _busyClick(e, text, msgType) {
  const btn = (e && e.currentTarget) || (e && e.target);
  const origText = btn ? btn.textContent : "";
  const origDisabled = btn ? btn.disabled : false;
  if (btn) {
    btn.textContent = text;
    btn.disabled = true;
    btn.classList.add("is-busy");
  }
  let restored = false;
  const restore = () => {
    if (restored || !btn) return;
    restored = true;
    btn.textContent = origText;
    btn.disabled = origDisabled;
    btn.classList.remove("is-busy");
  };
  // 5 s — change the label so the user knows something's still happening
  // and where to look (a new tab somewhere).
  const tMid = setTimeout(() => {
    if (btn && !restored) btn.textContent = "Still working… check your browser tabs";
  }, 5000);
  // 8 s — safety restore so the user can retry on a true failure
  const tSafety = setTimeout(restore, 8000);
  try {
    chrome.runtime.sendMessage({ type: msgType }, (resp) => {
      clearTimeout(tMid);
      clearTimeout(tSafety);
      // v1.4.21-fix1 — error surfacing (matches _busyClickWithPayload).
      if (chrome.runtime.lastError) {
        console.error("[CleanFeed]", msgType, "failed: message port closed",
          chrome.runtime.lastError.message);
        restore();
        return;
      }
      if (!resp || resp.ok === false) {
        console.error("[CleanFeed]", msgType, "background reported failure:",
          (resp && resp.error) || "(empty response)");
        restore();
        return;
      }
      // Success — the background SW has already opened the tab.
      try { window.close(); } catch (_) { restore(); }
    });
  } catch (err) {
    clearTimeout(tMid);
    clearTimeout(tSafety);
    console.error("[CleanFeed] _busyClick sendMessage threw:", err);
    restore();
  }
}

// v1.4.21 Phase 3 — variant that lets the caller merge fields into the
// outgoing message (used by the plan-picker buttons to pass msg.plan).
// Behaviour is otherwise identical to _busyClick.
function _busyClickWithPayload(e, text, msgType, payload) {
  const btn = (e && e.currentTarget) || (e && e.target);
  const origText = btn ? btn.textContent : "";
  const origDisabled = btn ? btn.disabled : false;
  if (btn) {
    btn.textContent = text;
    btn.disabled = true;
    btn.classList.add("is-busy");
  }
  let restored = false;
  const restore = () => {
    if (restored || !btn) return;
    restored = true;
    btn.textContent = origText;
    btn.disabled = origDisabled;
    btn.classList.remove("is-busy");
  };
  const tMid = setTimeout(() => {
    if (btn && !restored) btn.textContent = "Still working… check your browser tabs";
  }, 5000);
  const tSafety = setTimeout(restore, 8000);
  try {
    const msg = Object.assign({ type: msgType }, payload || {});
    chrome.runtime.sendMessage(msg, (resp) => {
      clearTimeout(tMid);
      clearTimeout(tSafety);
      // v1.4.21-fix1 — surface every failure mode. Pre-fix this branch
      // collapsed three distinct failures (closed message port, missing
      // response, background returned ok:false) into a single silent
      // restore. Future regressions were impossible to debug.
      if (chrome.runtime.lastError) {
        console.error("[CleanFeed] cf:open-payment failed: message port closed",
          chrome.runtime.lastError.message, "msg=", msg);
        restore();
        return;
      }
      if (!resp) {
        console.error("[CleanFeed] cf:open-payment got empty response. msg=", msg);
        restore();
        return;
      }
      if (resp.ok === false) {
        console.error("[CleanFeed] cf:open-payment background reported failure:",
          resp.error || "(no error string)", "msg=", msg);
        restore();
        return;
      }
      try { window.close(); } catch (_) { restore(); }
    });
  } catch (err) {
    clearTimeout(tMid);
    clearTimeout(tSafety);
    console.error("[CleanFeed] _busyClickWithPayload sendMessage threw:", err);
    restore();
  }
}

function openPayment(e) {
  if (e) e._cfHandled = true;
  _busyClick(e, "Opening…", "cf:open-payment");
}
function openLogin(e) {
  // Routes through background.js → extpay.openLoginPage() URL. The
  // background handler ensures the api_key exists in storage before
  // building the URL (v1.3.4), and we pre-fetch on popup open (v1.4.2)
  // so this is usually instant.
  if (e) e._cfHandled = true;
  _busyClick(e, "Connecting…", "cf:open-login");
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
  // v1.4.22 — single CTA, focus the Get Pro button after the slide-in.
  setTimeout(() => {
    const target = $("cf-modal-get-pro");
    if (target) target.focus();
  }, 60);
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
//
// v1.4.3 — the bug we're fixing here: in v1.4.2 every click handler was
// attached AFTER `await loadState()` inside init(). On the FIRST popup
// open after install (and intermittently after the MV3 SW slept for ~30 s)
// chrome.storage.local.get could take long enough that users tried to
// click toggles / Upgrade before the listeners were live. The UI was
// visible but inert. Reopening "fixed it" because by then the SW was warm.
//
// Fix: a synchronous `bootstrap()` runs on DOMContentLoaded. It (a) pings
// the SW awake, (b) attaches EVERY click handler immediately, (c) shows a
// thin progress line if storage is slow, then (d) kicks off the async
// init() to load state and render. STATE-dependent handlers gate on
// STATE.loaded so a too-early click is a no-op, not a wrong action.

function _showLoadingLine() {
  if (document.getElementById("cf-loading-line")) return;
  const bar = document.createElement("div");
  bar.id = "cf-loading-line";
  bar.className = "cf-loading-line";
  document.body.appendChild(bar);
}

function _hideLoadingLine() {
  const bar = document.getElementById("cf-loading-line");
  if (bar) bar.remove();
  document.body.classList.remove("cf-popup-loading");
}

// v1.4.3 — attach EVERY top-level click handler synchronously, before any
// await. Handlers that depend on STATE check STATE.loaded internally and
// are no-ops until loadState() resolves.
function _attachStaticHandlers() {
  // Fixed buttons — none of these depend on STATE except togglePause/_startHold,
  // which guard internally.
  // v1.4.21 Phase 3 — cf-upgrade / cf-login are now JS-rendered inside
  // renderUpgrade (Case F), so they're attached at render time, not here.
  $("cf-reset-stats").addEventListener("click", resetStats);

  // v1.4.21-fix1 — event-DELEGATION fallback for every Subscribe / plan
  // button inside the upgrade card. Why both per-button AND delegated:
  //   (a) per-button addEventListener inside renderUpgrade is fine on the
  //       happy path and gives `e.currentTarget` directly;
  //   (b) renderUpgrade rebuilds the upgrade-card body and re-attaches on
  //       every re-render (init + storage.onChanged for cf_subscription /
  //       cf_grandfathered). If a render race ever orphaned a listener
  //       OR a future button is added without an inline bind, the
  //       delegated handler here catches it.
  // The delegated handler dispatches off data-plan (preferred) or button
  // id (fallback for "manage subscription" / "update payment method" /
  // "already paid" buttons that route through cf:open-login).
  const upgradeHost = $("cf-upgrade-card");
  if (upgradeHost) {
    upgradeHost.addEventListener("click", (e) => {
      const t = e.target && e.target.closest("button, .cf-link");
      if (!t || !upgradeHost.contains(t)) return;
      // v1.4.22 — single-plan world. data-plan should be "lifetime"; any
      // other value coerces to "lifetime" before dispatch (the only valid
      // payment route now). Defensive against stale state if a popup was
      // opened from a pre-v1.4.22 snapshot.
      const planAttr = t.dataset && t.dataset.plan;
      if (planAttr === "lifetime" || t.id === "cf-get-pro" || t.id === "cf-resubscribe") {
        if (e._cfHandled) return;
        e._cfHandled = true;
        _busyClickWithPayload({ currentTarget: t, target: t }, "Opening…",
          "cf:open-payment", { plan: "lifetime" });
        return;
      }
      if (t.id === "cf-manage-sub" || t.id === "cf-update-payment" || t.id === "cf-login") {
        if (e._cfHandled) return;
        e._cfHandled = true;
        _busyClick({ currentTarget: t, target: t }, "Opening…", "cf:open-login");
        return;
      }
    });
  }
  $("cf-open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("cf-open-onboarding").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding/welcome.html") });
  });
  $("cf-pause-btn").addEventListener("click", togglePause);
  // v1.4.24.5 — paused-banner resume button.
  $("cf-resume-now").addEventListener("click", resumeNow);

  // Hold-to-disable Focus Lock — pointerdown starts, leave/up cancels.
  const holdBtn = $("cf-focus-hold");
  holdBtn.addEventListener("pointerdown", _startHold);
  holdBtn.addEventListener("pointerup", _cancelHold);
  holdBtn.addEventListener("pointerleave", _cancelHold);
  holdBtn.addEventListener("pointercancel", _cancelHold);
  holdBtn.addEventListener("touchstart", _startHold, { passive: true });
  holdBtn.addEventListener("touchend", _cancelHold);
  holdBtn.addEventListener("touchcancel", _cancelHold);

  // Modal button — v1.4.22: single Get Pro CTA (replaces the v1.4.21
  // Phase 3 plan picker). The "Already paid? Log in" link is the same
  // openLogin → cf:open-login → ExtPay reactivate path as before.
  $("cf-modal-get-pro").addEventListener("click", onGetProClick);
  $("cf-modal-login").addEventListener("click", openLogin);
  document.querySelectorAll("[data-cf-close-modal]").forEach((el) => {
    el.addEventListener("click", closeUpsellModal);
  });
}

function bootstrap() {
  // (1) Warm the service worker the instant the popup opens. Fire-and-forget
  // — background.js has a synchronous handler for `cf:wake` that responds
  // immediately, keeping the SW alive during popup render.
  try {
    chrome.runtime.sendMessage({ type: "cf:wake" }, () => {
      void chrome.runtime.lastError;
    });
  } catch (_) {}

  // (2) Show version synchronously — getManifest is cheap and never throws.
  try {
    $("cf-version").textContent = "v" + chrome.runtime.getManifest().version;
  } catch (_) {}

  // (3) Attach EVERY click handler before any await. From here on the popup
  // is interactive even if storage hasn't resolved yet.
  _attachStaticHandlers();

  // (4) If storage is slow, show a thin progress line + dim the toggle area.
  const loadingTimer = setTimeout(() => {
    document.body.classList.add("cf-popup-loading");
    _showLoadingLine();
  }, 150);

  // (5) Kick off the async work that was originally init().
  init().finally(() => {
    clearTimeout(loadingTimer);
    _hideLoadingLine();
    STATE.loaded = true;
  });
}

async function init() {
  // v1.4.6 — wait for background's onInstalled defaults seed to land
  // before reading. On a healthy fresh install this resolves in ~10-50ms;
  // on existing-user installs it returns immediately because populated
  // `settings` short-circuits the check. The 150ms loadingTimer in
  // bootstrap() shows the user a thin progress line if we have to wait.
  await waitForInitialized();
  await loadState();

  // v1.4.19 F1 — YouTube Music smart-exemption: if the active tab is on
  // music.youtube.com, the popup short-circuits to a "paused on YT Music"
  // panel and skips the toggle grid + upgrade card entirely.
  STATE.onYouTubeMusic = await detectActiveYouTubeMusicTab();
  if (STATE.onYouTubeMusic) {
    renderYouTubeMusicPause();
    return;
  }

  // v1.4.0 F3 — bump usage counter for review-prompt gating.
  // v1.4.2 — remember the pre-increment count so we can suppress the
  // banner on the first-ever popup open even if some other code path
  // pre-seeded usageCount to a high number.
  const prevUsage = STATE.usageCount;
  const newUsage = (parseInt(prevUsage, 10) || 0) + 1;
  STATE.usageCount = newUsage;
  chrome.storage.local.set({ usageCount: newUsage });
  // v1.4.2 — pre-fetch the ExtPay api_key in the background so the
  // Upgrade / I-already-paid tabs open instantly when the user clicks.
  // Fire-and-forget; never await this.
  try { chrome.runtime.sendMessage({ type: "cf:prefetch-apikey" }, () => { void chrome.runtime.lastError; }); }
  catch (_) {}

  // v1.4.0 F2 — show onboarding view instead of toggle grid if first install
  if (!STATE.onboardingComplete) {
    renderOnboarding();
    return;
  }

  applyTheme(STATE.popupTheme);
  renderTierBadge();
  renderStats();
  renderTodayStats();
  renderStreak();
  renderWeekStats();
  renderUpgrade();
  renderFocusBanner();
  renderTimeMini();
  renderPause();
  renderBlockers();
  renderScheduleIndicator();
  renderReviewPrompt();

  // Refresh paid status from background; re-render the parts that depend on it.
  await refreshPaidStatus();
  renderTierBadge();
  renderUpgrade();
  renderBlockers();

  // v1.4.3 — click handlers were attached synchronously in bootstrap()
  // before any await, so they work on cold popup open. See _attachStaticHandlers.

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
      STATE.pausedUntil = sanePausedUntil(changes.pausedUntil.newValue);
      renderPause();
      renderBlockers();
    }
    if (changes.focusLock) {
      STATE.focusLock = changes.focusLock.newValue || STATE.focusLock;
      renderFocusBanner();
      renderPause();
      renderBlockers();
      renderScheduleIndicator();
    }
    if (changes.timeTracking) {
      STATE.timeTracking = changes.timeTracking.newValue || {};
      renderTimeMini();
    }
    // v1.4.21 Phase 3 — re-render upgrade card on subscription / grandfather
    // changes (e.g. ExtPay periodic sync, dev-override flip, redemption).
    if (changes.cf_subscription) {
      STATE.cf_subscription = changes.cf_subscription.newValue
        || { status: "none", plan: null, cancelAt: null, lastSyncAt: 0 };
      renderUpgrade();
    }
    if (changes.cf_grandfathered || changes.cf_grandfathered_reason) {
      if (changes.cf_grandfathered) STATE.cf_grandfathered = changes.cf_grandfathered.newValue === true;
      if (changes.cf_grandfathered_reason) STATE.cf_grandfathered_reason = changes.cf_grandfathered_reason.newValue || null;
      renderUpgrade();
    }
    // v1.4.21 Phase 3 — re-render the weekly mini-card when cf_stats updates
    // (content.js flushes every 30s while the user browses).
    if (changes.cf_stats) {
      STATE.cf_stats = changes.cf_stats.newValue
        || { blocked: {}, autoplay_avoided: {}, session_started: 0 };
      renderWeekStats();
      renderTodayStats();
    }
    // v1.4.24 — streak / schedule / theme live updates
    if (changes.cf_streak) {
      STATE.cf_streak = changes.cf_streak.newValue || { streakCount: 0, lastActiveDate: null };
      renderStreak();
    }
    if (changes.focusSchedule) {
      STATE.focusSchedule = changes.focusSchedule.newValue || { enabled: false, schedules: [] };
      renderScheduleIndicator();
    }
    if (changes.popupTheme) {
      STATE.popupTheme = changes.popupTheme.newValue || "auto";
      applyTheme(STATE.popupTheme);
    }
    if (changes.perPageEnabled) {
      STATE.perPageEnabled = !!changes.perPageEnabled.newValue;
      renderBlockers();
    }
    if (changes.perPageSettings) {
      STATE.perPageSettings = changes.perPageSettings.newValue || { homepage: {}, watch: {}, subscriptions: {} };
      renderBlockers();
    }
    // v1.4.6 — if onboardingComplete is force-toggled in storage (e.g. an
    // in-flight onInstalled write momentarily clobbers a freshly-picked
    // preset), self-recover without forcing the user to close/reopen.
    if (changes.onboardingComplete) {
      const newVal = !!changes.onboardingComplete.newValue;
      if (newVal && !STATE.onboardingComplete) {
        STATE.onboardingComplete = true;
        const ob = document.getElementById("cf-onboarding");
        if (ob) ob.remove();
        document.querySelectorAll(
          ".cf-stats, .cf-time-mini, .cf-pause-bar, .cf-blockers, .cf-upgrade, .cf-week-stats"
        ).forEach((el) => { el.style.display = ""; });
        renderTierBadge();
        renderStats();
        renderWeekStats();
        renderUpgrade();
        renderFocusBanner();
        renderTimeMini();
        renderPause();
        renderBlockers();
      }
    }
  });
}

// ---------- v1.4.19 F1 — YouTube Music exemption panel ----------
// When the active tab is on music.youtube.com, hide every CleanFeed control
// (toggles, pause, stats, upgrade, focus banner, time mini) and show a
// brief explainer line. CleanFeed's content script also no-ops on this
// host, so there is nothing on the page to configure from here.
function renderYouTubeMusicPause() {
  document.querySelectorAll(
    ".cf-stats, .cf-time-mini, .cf-pause-bar, .cf-blockers, .cf-upgrade, .cf-focus-banner, .cf-week-stats"
  ).forEach((el) => { el.style.display = "none"; });

  // Remove any previous panel (popup is destroyed on close — defensive).
  const old = document.getElementById("cf-ytmusic-pause");
  if (old) old.remove();
  const host = document.createElement("section");
  host.id = "cf-ytmusic-pause";
  host.className = "cf-ytmusic-pause";

  const icon = document.createElement("div");
  icon.className = "cf-ytmusic-icon";
  icon.textContent = "🎵";
  icon.setAttribute("aria-hidden", "true");
  host.appendChild(icon);

  const h = document.createElement("h2");
  h.textContent = "CleanFeed is paused on YouTube Music";
  host.appendChild(h);

  const p = document.createElement("p");
  p.textContent = "We don't apply blockers, badges, or time tracking here — it's a music app, not a feed.";
  host.appendChild(p);

  const header = document.querySelector(".cf-header");
  if (header && header.parentNode) {
    header.parentNode.insertBefore(host, header.nextSibling);
  } else {
    document.body.appendChild(host);
  }
}

// ---------- v1.4.0 F2 — onboarding view ----------
function renderOnboarding() {
  const root = document.body;
  // hide everything except header (and footer maybe)
  document.querySelectorAll(
    ".cf-stats, .cf-time-mini, .cf-pause-bar, .cf-blockers, .cf-upgrade, .cf-focus-banner, .cf-week-stats"
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
    ".cf-stats, .cf-time-mini, .cf-pause-bar, .cf-blockers, .cf-upgrade, .cf-week-stats"
  ).forEach((el) => { el.style.display = ""; });
  renderTierBadge();
  renderStats();
  renderWeekStats();
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
  if (STATE.reviewPromptShown) return;
  // v1.4.2 — coerce both sides to integers so we never compare NaN.
  const count = parseInt(STATE.usageCount, 10) || 0;
  if (count < REVIEW_THRESHOLD) return;
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

document.addEventListener("DOMContentLoaded", bootstrap);
