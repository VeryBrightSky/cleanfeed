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
      },
      paid: false,
      whitelistedChannels: [],
      customCSS: "",
      sessionStats: { total: 0, perBlocker: {} },
      pausedUntil: 0,
      blockedChannels: [],
      focusLock: { pinSet: false, activeUntil: 0, pinHash: "", pinSalt: "" },
      timeTracking: {},
    };
    await chrome.storage.local.set(defaults);
    // mirror a copy to chrome.storage.sync for backup/migration
    chrome.storage.sync.set({
      settings: defaults.settings,
      whitelistedChannels: [],
    }).catch(() => {});
  }
  // check license on every browser launch (and on update)
  try {
    const user = await extpay.getUser();
    await chrome.storage.local.set({ paid: !!user.paid });
  } catch (_) { /* offline — keep cached flag */ }
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
  if (msg.type === "cf:open-payment" || msg.type === "cf:open-payment-page") {
    // v1.3.2: wrap the SDK's async open_payment_page in try/catch and
    // fall back to a regular browser tab if Chrome rejects the small
    // popup window (e.g. high-DPI / multi-monitor: "Invalid value for
    // bounds"). The SDK call is async, so the wrapper must be async too;
    // a synchronous try/catch around the call alone wouldn't catch a
    // rejection.
    (async () => {
      try {
        await extpay.openPaymentPage("pro");
        sendResponse({ ok: true });
      } catch (err) {
        console.warn("[CleanFeed] ExtPay payment popup failed, falling back to tab:", err);
        try {
          await chrome.tabs.create({
            url: "https://extensionpay.com/extension/cleanfeed2342?back=choose-plan",
            active: true,
          });
          sendResponse({ ok: true, fallback: "tab" });
        } catch (tabErr) {
          console.error("[CleanFeed] Tab fallback also failed:", tabErr);
          sendResponse({ ok: false, error: String(tabErr) });
        }
      }
    })();
    return true;
  }
  // "I already paid" — call ExtPay's hosted login flow directly via the
  // official SDK. (v1.2.4: dropped the branded login.html middleman; the
  // SDK doesn't expose extpay.login(email), so per spec's fallback we
  // hand off the email-collection UI to ExtPay's hosted page where the
  // magic link is actually generated and emailed.)
  if (
    msg.type === "cf:open-login" ||
    msg.type === "cf:open-extpay-login" ||
    msg.type === "cf:open-login-page"
  ) {
    // v1.3.2: same defensive wrap as the payment path above.
    (async () => {
      try {
        await extpay.openLoginPage();
        sendResponse({ ok: true });
      } catch (err) {
        console.warn("[CleanFeed] ExtPay login popup failed, falling back to tab:", err);
        try {
          await chrome.tabs.create({
            url: "https://extensionpay.com/extension/cleanfeed2342/reactivate?back=choose-plan",
            active: true,
          });
          sendResponse({ ok: true, fallback: "tab" });
        } catch (tabErr) {
          console.error("[CleanFeed] Tab fallback also failed:", tabErr);
          sendResponse({ ok: false, error: String(tabErr) });
        }
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
