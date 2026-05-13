/* CleanFeed — background.js (Manifest V3 service worker)
 *
 * Responsibilities:
 *   • Initialise ExtensionPay with our extension id ("cleanfeed2342")
 *   • Open the onboarding tab on first install
 *   • Maintain an action-badge that shows the count of active blockers
 *   • Cache the paid flag in chrome.storage.local so popup/content can
 *     read it synchronously (no network round-trip on every popup open)
 *   • Route messages from popup -> active YT tab so live toggling works
 *
 * Service workers are short-lived: any state must come from chrome.storage.
 */
importScripts("lib/extpay.js");

const EXTPAY_ID = "cleanfeed2342";
const extpay = ExtPay(EXTPAY_ID);
extpay.startBackground();

// Mirror paid status to local storage for fast synchronous reads.
extpay.onPaid.addListener(async (user) => {
  await chrome.storage.local.set({
    paid: !!user.paid,
    paidAt: user.paidAt ? user.paidAt.toISOString() : null,
  });
  // notify any open popup
  chrome.runtime.sendMessage({ type: "cf:paid-changed", paid: !!user.paid }).catch(() => {});
});

// -------- onboarding ----------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    // open onboarding in a new tab
    chrome.tabs.create({
      url: chrome.runtime.getURL("onboarding/welcome.html"),
    });
    // seed default settings: only home-feed + shorts on (free-tier defaults)
    const defaults = {
      settings: {
        "home-feed": true,
        "shorts": true,
        "watch-sidebar": false,
        "end-screen": false,
        "comments": false,
        "explore": false,
        "live-chat": false,
        "autoplay": false,
        "thumbnails": false,
        "subs-algo": false,
        // v1.4.0 — four new blockers, all default OFF
        "playables": false,
        "merch-shelf": false,
        "breaking-news": false,
        "mixes-playlists": false,
      },
      paid: false,
      whitelistedChannels: [],
      customCSS: "",
      sessionStats: { total: 0, perBlocker: {} },
      pausedUntil: 0,
      blockedChannels: [],
      focusLock: {
        pinSet: false, activeUntil: 0, pinHash: "", pinSalt: "",
        mode: "standard",           // "standard" | "pomodoro"
        pomodoro: { focusMin: 25, breakMin: 5, cycles: 4 },
        pomodoroState: null,        // {phase:"focus"|"break", cycle:N, until:ts, total:N}
      },
      timeTracking: {},
      // v1.4.0
      hiddenKeywords: [],           // F1 — Pro keyword blocklist
      onboardingComplete: false,    // F2 — first-install presets
      onboardingChoice: null,
      usageCount: 0,                // F3 — popup-open counter
      reviewPromptShown: false,     // F3 — one-time review banner gate
      perPageEnabled: false,        // F6 — opt-in per-page rules
      perPageSettings: { homepage: {}, watch: {}, subscriptions: {} },
    };
    await chrome.storage.local.set(defaults);
    // mirror a copy to chrome.storage.sync for backup/migration
    chrome.storage.sync.set({
      settings: defaults.settings,
      whitelistedChannels: [],
    }).catch(() => {});
  } else if (details.reason === "update") {
    // v1.4.0 migration. Existing users keep their settings; we only
    // ADD the new keys with safe defaults. Onboarding is auto-marked
    // complete for anyone who already has settings (per spec).
    await _migrateForV140();
  }
  // check license on every browser launch (and on update)
  try {
    const user = await extpay.getUser();
    await chrome.storage.local.set({ paid: !!user.paid });
  } catch (_) { /* offline — keep cached flag */ }
  updateBadge();
});

// -------- v1.4.0 migration ----------------------------------------------
//
// Add new storage keys with safe defaults if missing. Never overwrite
// existing user values. Onboarding is marked complete for anyone whose
// settings object already has at least one truthy blocker.
async function _migrateForV140() {
  const NEW_BLOCKER_DEFAULTS = {
    "playables": false,
    "merch-shelf": false,
    "breaking-news": false,
    "mixes-playlists": false,
  };
  const data = await chrome.storage.local.get(null);
  const patch = {};
  // settings: merge new blocker keys without clobbering existing values
  const s = Object.assign({}, NEW_BLOCKER_DEFAULTS, data.settings || {});
  patch.settings = s;
  // onboarding — auto-complete for upgraded existing users
  if (typeof data.onboardingComplete === "undefined") {
    const hasUserSettings = data.settings &&
      Object.values(data.settings).some((v) => v === true);
    patch.onboardingComplete = !!hasUserSettings;
  }
  if (typeof data.hiddenKeywords === "undefined") patch.hiddenKeywords = [];
  if (typeof data.usageCount === "undefined") patch.usageCount = 0;
  if (typeof data.reviewPromptShown === "undefined") patch.reviewPromptShown = false;
  if (typeof data.perPageEnabled === "undefined") patch.perPageEnabled = false;
  if (typeof data.perPageSettings === "undefined") {
    patch.perPageSettings = { homepage: {}, watch: {}, subscriptions: {} };
  }
  // focusLock — preserve existing object, just ensure mode/pomodoro fields exist
  const fl = data.focusLock || {};
  if (typeof fl.mode === "undefined") fl.mode = "standard";
  if (typeof fl.pomodoro === "undefined") fl.pomodoro = { focusMin: 25, breakMin: 5, cycles: 4 };
  if (typeof fl.pomodoroState === "undefined") fl.pomodoroState = null;
  patch.focusLock = fl;
  await chrome.storage.local.set(patch);
}

// -------- Pomodoro alarm handler (F4) -----------------------------------
//
// Phase 1: focus — blockers force-on (handled by content.js via focusLock
//   activeUntil & mode === "pomodoro"). At alarm fire, switch to break.
// Phase 2: break — blockers off; user browses freely. At alarm fire,
//   if cycles remain → next focus; else clear state, fire completion.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "cf-pomodoro") return;
  const data = await chrome.storage.local.get(["focusLock"]);
  const fl = data.focusLock || {};
  const state = fl.pomodoroState;
  if (!state) return;
  const cfg = fl.pomodoro || { focusMin: 25, breakMin: 5, cycles: 4 };

  if (state.phase === "focus") {
    // -> break
    const breakUntil = Date.now() + Math.max(1, cfg.breakMin) * 60 * 1000;
    fl.pomodoroState = { phase: "break", cycle: state.cycle, total: state.total, until: breakUntil };
    fl.activeUntil = 0;     // unlock blockers during break
    await chrome.storage.local.set({ focusLock: fl });
    chrome.alarms.create("cf-pomodoro", { when: breakUntil });
    try {
      chrome.notifications.create({
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
        title: "Focus complete — break time",
        message: `Cycle ${state.cycle} of ${state.total} done. ${cfg.breakMin} min break.`,
      });
    } catch (_) {}
  } else if (state.phase === "break") {
    if (state.cycle >= state.total) {
      // Final cycle done — clear everything
      fl.pomodoroState = null;
      fl.activeUntil = 0;
      await chrome.storage.local.set({
        focusLock: fl,
        lastPomodoroComplete: Date.now(),
      });
      try { chrome.alarms.clear("cf-pomodoro"); } catch (_) {}
      try {
        chrome.notifications.create({
          type: "basic",
          iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
          title: "Pomodoro complete",
          message: `${state.total} cycles done. Nice work.`,
        });
      } catch (_) {}
    } else {
      // next focus
      const focusMs = Math.max(1, cfg.focusMin) * 60 * 1000;
      const until = Date.now() + focusMs;
      fl.pomodoroState = { phase: "focus", cycle: state.cycle + 1, total: state.total, until };
      fl.activeUntil = until;
      await chrome.storage.local.set({ focusLock: fl });
      chrome.alarms.create("cf-pomodoro", { when: until });
      try {
        chrome.notifications.create({
          type: "basic",
          iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
          title: "Break over — back to focus",
          message: `Cycle ${state.cycle + 1} of ${state.total}. ${cfg.focusMin} min focus.`,
        });
      } catch (_) {}
    }
  }
  updateBadge();
});

// -------- badge counter -------------------------------------------------

async function updateBadge() {
  const data = await chrome.storage.local.get(["settings", "paid", "pausedUntil", "focusLock"]);
  const settings = data.settings || {};
  const paid = !!data.paid;
  const pausedUntil = Number(data.pausedUntil) || 0;
  const focusLock = data.focusLock || {};
  const focusActive = Number(focusLock.activeUntil || 0) > Date.now();

  // Focus Lock wins over everything visually.
  if (focusActive && paid) {
    try {
      await chrome.action.setBadgeText({ text: "🔒" });
      await chrome.action.setBadgeBackgroundColor({ color: "#C64A5B" });
      if (chrome.action.setBadgeTextColor) {
        await chrome.action.setBadgeTextColor({ color: "#FFFFFF" });
      }
    } catch (_) {}
    const ms = Math.max(1000, Number(focusLock.activeUntil) - Date.now() + 50);
    if (ms < 365 * 24 * 60 * 60 * 1000) setTimeout(updateBadge, ms);
    return;
  }

  // While paused, the badge shows a pause glyph and goes dim.
  if (pausedUntil > Date.now()) {
    try {
      await chrome.action.setBadgeText({ text: "⏸" });
      await chrome.action.setBadgeBackgroundColor({ color: "#5E6C7E" });
      if (chrome.action.setBadgeTextColor) {
        await chrome.action.setBadgeTextColor({ color: "#FFFFFF" });
      }
    } catch (_) {}
    // Schedule another update when the pause expires so the badge resets.
    const ms = Math.max(1000, pausedUntil - Date.now() + 50);
    setTimeout(updateBadge, ms);
    return;
  }

  // count active blockers, respecting free-tier limits
  const ids = Object.keys(settings).filter((id) => settings[id]);
  let count = ids.length;
  if (!paid) {
    // free tier: cap at 2 and only count free-tier blockers
    const FREE_IDS = ["home-feed", "shorts"];
    count = ids.filter((id) => FREE_IDS.includes(id)).length;
    count = Math.min(count, 2);
  }
  const text = count > 0 ? String(count) : "";
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: "#3CC8C8" });
    if (chrome.action.setBadgeTextColor) {
      // available in newer Chrome
      await chrome.action.setBadgeTextColor({ color: "#0B1828" });
    }
  } catch (_) { /* ignore */ }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.settings || changes.paid || changes.pausedUntil || changes.focusLock) updateBadge();
});

// -------- message routing -----------------------------------------------

// -------- time tracker aggregator ---------------------------------------
//
// Keep an in-memory accumulator and flush to storage every ~5s. We cap the
// stored object to the last 30 days to keep storage small.
const _ttAccum = { date: "", ms: 0, flushHandle: 0 };

function _todayLocalDateKey() {
  const d = new Date();
  // YYYY-MM-DD in the user's local timezone
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function _flushTimeTracker() {
  if (_ttAccum.ms <= 0 || !_ttAccum.date) return;
  const seconds = Math.floor(_ttAccum.ms / 1000);
  if (seconds <= 0) return;
  _ttAccum.ms -= seconds * 1000;
  const data = await chrome.storage.local.get(["timeTracking"]);
  const tt = data.timeTracking || {};
  tt[_ttAccum.date] = (tt[_ttAccum.date] || 0) + seconds;
  // prune to last 30 days
  const keep = new Set();
  const now = new Date();
  for (let i = 0; i < 30; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    keep.add(`${y}-${m}-${day}`);
  }
  for (const k of Object.keys(tt)) {
    if (!keep.has(k)) delete tt[k];
  }
  await chrome.storage.local.set({ timeTracking: tt });
}

function _recordTime(ms) {
  const date = _todayLocalDateKey();
  if (_ttAccum.date && _ttAccum.date !== date) {
    // day rolled over — flush old day first
    _flushTimeTracker();
  }
  _ttAccum.date = date;
  _ttAccum.ms += Math.max(0, Math.min(ms, 15000));
  if (!_ttAccum.flushHandle) {
    _ttAccum.flushHandle = setTimeout(() => {
      _ttAccum.flushHandle = 0;
      _flushTimeTracker();
    }, 5000);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  // Time tracker tick from content.js
  if (msg.type === "cf:track-time") {
    _recordTime(Number(msg.ms) || 0);
    sendResponse({ ok: true });
    return true;
  }

  // F4 — start a Pomodoro session. Requires Pro + a valid PIN already
  // set; we trust the caller (options page) to have checked both.
  if (msg.type === "cf:pomodoro-start") {
    (async () => {
      const data = await chrome.storage.local.get(["focusLock"]);
      const fl = data.focusLock || {};
      const cfg = Object.assign(
        { focusMin: 25, breakMin: 5, cycles: 4 },
        fl.pomodoro || {},
        msg.config || {}
      );
      cfg.focusMin = Math.max(15, Math.min(60, Math.round(cfg.focusMin)));
      cfg.breakMin = Math.max(3,  Math.min(15, Math.round(cfg.breakMin)));
      cfg.cycles   = Math.max(1,  Math.min(8,  Math.round(cfg.cycles)));
      const focusMs = cfg.focusMin * 60 * 1000;
      const until = Date.now() + focusMs;
      fl.mode = "pomodoro";
      fl.pomodoro = cfg;
      fl.pomodoroState = { phase: "focus", cycle: 1, total: cfg.cycles, until };
      fl.activeUntil = until;
      await chrome.storage.local.set({ focusLock: fl });
      try { chrome.alarms.clear("cf-pomodoro"); } catch (_) {}
      chrome.alarms.create("cf-pomodoro", { when: until });
      sendResponse({ ok: true, until });
      updateBadge();
    })();
    return true;
  }

  // F4 — graceful cancel (clear alarm, reset Pomodoro state, leave PIN).
  if (msg.type === "cf:pomodoro-cancel") {
    (async () => {
      try { chrome.alarms.clear("cf-pomodoro"); } catch (_) {}
      const data = await chrome.storage.local.get(["focusLock"]);
      const fl = data.focusLock || {};
      fl.pomodoroState = null;
      fl.activeUntil = 0;
      await chrome.storage.local.set({ focusLock: fl });
      sendResponse({ ok: true });
      updateBadge();
    })();
    return true;
  }

  // Popup wants the latest paid status without paying for the round-trip
  if (msg.type === "cf:get-paid") {
    chrome.storage.local.get(["paid", "paidAt"]).then((data) => {
      sendResponse({ paid: !!data.paid, paidAt: data.paidAt || null });
    });
    return true;
  }

  // Popup wants a fresh license check (force network)
  if (msg.type === "cf:refresh-paid") {
    extpay.getUser().then((user) => {
      sendResponse({ paid: !!user.paid });
    }).catch(() => {
      sendResponse({ paid: false, error: "network" });
    });
    return true;
  }

  // ---- ExtPay routing (every API call goes through here, never from
  // popup/options/content — avoids the CORS error the old custom
  // SDK hit when called from extension pages).
  // v1.3.4: ensure ExtPay's api_key exists in storage BEFORE opening
  // the tab. v1.3.3 correctly avoided the SDK's bounds-error popup by
  // building the URL ourselves and tab-opening it, but it also bypassed
  // the only code path that ever creates the api_key (which lives only
  // inside the SDK's open_payment_page / open_login_page — getUser
  // does not create it on a missing key, confirmed at
  // lib/extpay.js:1355-1362).
  //
  // We replicate the SDK's create_key() logic inline: POST to
  // /api/new-key, get a JSON string back, write it to BOTH storage
  // areas the SDK reads from. lib/extpay.js itself is untouched.

  // SDK's set() helper writes sync first and falls back to local
  // (lib/extpay.js:1266-1273). We do the same so the SDK reads back
  // its own key on subsequent calls.
  async function _writeExtpayApiKey(apiKey) {
    try {
      await chrome.storage.sync.set({ extensionpay_api_key: apiKey });
    } catch (_) {
      try { await chrome.storage.local.set({ extensionpay_api_key: apiKey }); } catch (_) {}
    }
  }

  async function _readExtpayApiKey() {
    // SDK reads sync first, falls back to local. Mirror that order.
    try {
      const s = await chrome.storage.sync.get(["extensionpay_api_key"]);
      if (s && s.extensionpay_api_key) return String(s.extensionpay_api_key);
    } catch (_) { /* sync unavailable on temp Firefox addons etc. */ }
    try {
      const l = await chrome.storage.local.get(["extensionpay_api_key"]);
      if (l && l.extensionpay_api_key) return String(l.extensionpay_api_key);
    } catch (_) {}
    return "";
  }

  // Replica of create_key() in lib/extpay.js:1307-1340. Same POST,
  // same body, same storage write. Returns "" on failure (caller
  // handles the no-key URL fallback).
  async function _createExtpayApiKey() {
    try {
      // Detect dev vs store install the same way the SDK does. Without
      // the `management` permission, chrome.management is undefined,
      // so we fall back to inspecting the manifest's update_url field.
      const isDev = !(("update_url") in (chrome.runtime.getManifest() || {}));
      const body = isDev ? { development: true } : {};
      const resp = await fetch(
        "https://extensionpay.com/extension/" + encodeURIComponent(EXTPAY_ID) + "/api/new-key",
        {
          method: "POST",
          headers: {
            "Accept": "application/json",
            "Content-type": "application/json",
          },
          body: JSON.stringify(body),
          credentials: "omit",
          cache: "no-store",
        }
      );
      if (!resp.ok) {
        console.warn("[CleanFeed] /api/new-key returned HTTP " + resp.status);
        return "";
      }
      const apiKey = await resp.json();
      const key = typeof apiKey === "string" ? apiKey : String(apiKey || "");
      if (key) await _writeExtpayApiKey(key);
      return key;
    } catch (e) {
      console.warn("[CleanFeed] Could not POST /api/new-key:", e);
      return "";
    }
  }

  // Read existing key; create one if missing. Returns "" only when
  // both read AND create failed (offline, etc.).
  async function _ensureExtpayApiKey() {
    let key = await _readExtpayApiKey();
    if (key) return key;
    // Side-call getUser first so any future SDK init also sees the key
    try { await extpay.getUser(); } catch (_) { /* network issue — keep going */ }
    key = await _readExtpayApiKey();
    if (key) return key;
    return await _createExtpayApiKey();
  }

  // v1.4.2 — warm the ExtPay api_key while the popup is open so the
  // moment the user clicks Upgrade / I-already-paid the tab opens
  // instantly. Fire-and-forget from popup.js; we still respond so the
  // sender knows whether it was cached or freshly fetched.
  if (msg.type === "cf:prefetch-apikey") {
    (async () => {
      try {
        const existing = await _readExtpayApiKey();
        if (existing) {
          sendResponse({ ok: true, cached: true });
          return;
        }
        const created = await _createExtpayApiKey();
        sendResponse({ ok: !!created, cached: false });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  if (msg.type === "cf:open-payment" || msg.type === "cf:open-payment-page") {
    (async () => {
      const apiKey = await _ensureExtpayApiKey();
      // Matches SDK's open_payment_page("pro"):
      //   ${EXTENSION_URL}/choose-plan/${plan_nickname}?api_key=...
      const url = apiKey
        ? `https://extensionpay.com/extension/cleanfeed2342/choose-plan/pro?api_key=${encodeURIComponent(apiKey)}`
        : `https://extensionpay.com/extension/cleanfeed2342?back=choose-plan`;
      try {
        await chrome.tabs.create({ url, active: true });
        sendResponse({ ok: true, hasApiKey: !!apiKey });
      } catch (err) {
        console.error("[CleanFeed] Failed to open payment tab:", err);
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  if (
    msg.type === "cf:open-login" ||
    msg.type === "cf:open-extpay-login" ||
    msg.type === "cf:open-login-page"
  ) {
    (async () => {
      const apiKey = await _ensureExtpayApiKey();
      // Matches SDK's open_login_page:
      //   ${EXTENSION_URL}/reactivate?api_key=...&back=choose-plan&v2
      const url = apiKey
        ? `https://extensionpay.com/extension/cleanfeed2342/reactivate?api_key=${encodeURIComponent(apiKey)}&back=choose-plan&v2`
        : `https://extensionpay.com/extension/cleanfeed2342/reactivate?back=choose-plan`;
      try {
        await chrome.tabs.create({ url, active: true });
        sendResponse({ ok: true, hasApiKey: !!apiKey });
      } catch (err) {
        console.error("[CleanFeed] Failed to open login tab:", err);
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }
  // Spec'd handler — return the full ExtPay user record.
  if (msg.type === "cf:get-user") {
    extpay.getUser().then((user) => {
      // mirror paid flag so cached reads stay fresh
      chrome.storage.local.set({
        paid: !!user.paid,
        paidAt: user.paidAt ? user.paidAt.toISOString() : null,
      });
      sendResponse(user);
    }).catch(() => sendResponse({ paid: false, error: "network" }));
    return true;
  }
  // After user returns from magic-link, popup asks us to force-refresh.
  if (msg.type === "cf:force-refresh-paid") {
    extpay.getUser().then((user) => {
      sendResponse({ paid: !!user.paid });
    }).catch(() => sendResponse({ paid: false, error: "network" }));
    return true;
  }

  // Popup pushed a settings change: forward to all youtube tabs
  if (msg.type === "cf:push-settings") {
    chrome.tabs.query({ url: "*://*.youtube.com/*" }, (tabs) => {
      for (const t of tabs) {
        chrome.tabs.sendMessage(t.id, {
          type: "cf:settings-changed",
          settings: msg.settings || {},
          paid: msg.paid,
          whitelistedChannels: msg.whitelistedChannels,
          customCSS: msg.customCSS,
        }).catch(() => { /* tab may be closing */ });
      }
      sendResponse({ ok: true, tabs: tabs.length });
    });
    updateBadge();
    return true;
  }
});

// -------- context menu: "Block this channel" (PRO) ----------------------
//
// chrome.contextMenus is registered on YouTube domains only. When the user
// right-clicks anywhere and picks our menu item, we forward the click to
// the active tab's content script — which locates the nearest video card
// and extracts the channel handle/name to add to the blocklist.
//
// We don't gate the menu visibility by paid status (Chrome menus don't
// support dynamic per-page conditions easily). The handler in content.js
// checks `paid` and shows a "Pro feature" toast if the user isn't unlocked.
function _registerContextMenu() {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: "cf-block-channel",
        title: "Block this channel with CleanFeed",
        contexts: ["link", "page", "image", "video"],
        documentUrlPatterns: [
          "*://*.youtube.com/*",
          "*://music.youtube.com/*",
        ],
      });
    });
  } catch (_) { /* contextMenus permission may be denied — silently ignore */ }
}
_registerContextMenu();
chrome.runtime.onInstalled.addListener(_registerContextMenu);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "cf-block-channel") return;
  if (!tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, {
    type: "cf:block-channel-at",
    linkUrl: info.linkUrl || "",
    pageUrl: info.pageUrl || "",
  }).catch(() => {});
});

// -------- initial badge after SW startup --------------------------------
updateBadge();
