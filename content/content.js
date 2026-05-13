/* CleanFeed — content.js
 *
 * Runs at document_start on every youtube.com page. Responsibilities:
 *   1. Read settings from chrome.storage.local
 *   2. Toggle body classes (cf-block-<id>) to activate CSS-first hiding
 *   3. Watch for SPA navigation + DOM churn via a debounced MutationObserver
 *   4. Inject a "Show comments" button on watch pages when comments are blocked
 *   5. Count blocked elements for popup stats
 *   6. Listen to chrome.runtime messages for live toggle updates
 *
 * Never uses innerHTML. Always uses textContent or DOM APIs.
 */
(function () {
  "use strict";

  const BLOCKERS = window.__cleanfeed_blockers || [];
  const STATE = {
    settings: {},          // {<blocker-id>: bool, ...}
    paid: false,
    whitelistedChannels: [],
    customCSS: "",
    counts: { total: 0, perBlocker: {} },
    observer: null,
    debounceTimer: 0,
    commentsBtnAdded: false,
    customStyleEl: null,
    statsFlushTimer: 0,
    pausedUntil: 0,        // unix ms; 0 = not paused
    autoplayHandledForVideo: "", // video id we've already turned autoplay off for
    blockedChannels: [],   // [{handle, name}] — videos from these channels are hidden
    focusLock: { activeUntil: 0, pinSet: false }, // PIN hash never sent to content
    lastRightClicked: null,
    hiddenKeywords: [],    // F1 — lowercase substrings
    perPageEnabled: false, // F6 — true = use per-page overrides
    perPageSettings: { homepage: {}, watch: {}, subscriptions: {} },
  };

  // ----- chrome bridge --------------------------------------------------

  function getSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(
        ["settings", "paid", "whitelistedChannels", "customCSS", "stats",
         "pausedUntil", "blockedChannels", "focusLock",
         "hiddenKeywords", "perPageEnabled", "perPageSettings"],
        (data) => {
          // default — only home-feed + shorts are on by default for new users
          const defaults = {};
          for (const b of BLOCKERS) {
            defaults[b.id] = (b.id === "home-feed" || b.id === "shorts");
          }
          STATE.settings = Object.assign(defaults, data.settings || {});
          STATE.paid = !!data.paid;
          STATE.whitelistedChannels = data.whitelistedChannels || [];
          STATE.customCSS = data.customCSS || "";
          STATE.pausedUntil = Number(data.pausedUntil) || 0;
          STATE.blockedChannels = Array.isArray(data.blockedChannels) ? data.blockedChannels : [];
          STATE.focusLock = data.focusLock || { activeUntil: 0, pinSet: false };
          STATE.hiddenKeywords = Array.isArray(data.hiddenKeywords) ? data.hiddenKeywords : [];
          STATE.perPageEnabled = !!data.perPageEnabled;
          STATE.perPageSettings = data.perPageSettings || { homepage: {}, watch: {}, subscriptions: {} };
          // session stats reset on page nav by default — caller decides
          resolve();
        }
      );
    });
  }

  function isFocusLockActive() {
    return STATE.focusLock && Number(STATE.focusLock.activeUntil) > Date.now();
  }

  function isPaused() {
    return STATE.pausedUntil > Date.now();
  }

  function persistStats() {
    // batched write
    if (STATE.statsFlushTimer) return;
    STATE.statsFlushTimer = setTimeout(() => {
      STATE.statsFlushTimer = 0;
      chrome.storage.local.set({ sessionStats: STATE.counts });
    }, 500);
  }

  function isProBlockerLocked(blocker) {
    return blocker.tier === "pro" && !STATE.paid;
  }

  // v1.4.0 F6 — detect which YT page we're on for per-page rules.
  // Defaults to "" (no override) for unrecognized pages.
  function _currentPageKey() {
    const p = location.pathname;
    if (p === "/" || p === "") return "homepage";
    if (p === "/watch") return "watch";
    if (p.startsWith("/feed/subscriptions")) return "subscriptions";
    return "";
  }

  // For each blocker, return its effective on/off given per-page overrides
  // (only when STATE.perPageEnabled). Override value "inherit" or undefined
  // falls back to STATE.settings.
  function _effectiveSettingFor(id) {
    if (!STATE.perPageEnabled || !STATE.paid) return !!STATE.settings[id];
    const page = _currentPageKey();
    if (!page) return !!STATE.settings[id];
    const override = STATE.perPageSettings &&
      STATE.perPageSettings[page] &&
      STATE.perPageSettings[page][id];
    if (override === "on")  return true;
    if (override === "off") return false;
    return !!STATE.settings[id];   // inherit / undefined
  }

  // Enforce free-tier limit: even if storage says many are enabled, we only
  // honour up to the first N (in BLOCKERS order). Pro blockers are always
  // locked off when not paid.
  //
  // Focus Lock override: when Focus Lock is active and the user is paid,
  // EVERY blocker is force-enabled regardless of their toggle state.
  function effectiveActive() {
    const limit = window.__cleanfeed_free_limit || 2;
    if (isFocusLockActive() && STATE.paid) {
      return BLOCKERS.slice();   // all of them
    }
    if (STATE.paid) {
      // Pro: respect user's choices (with per-page overrides)
      return BLOCKERS.filter((b) => _effectiveSettingFor(b.id));
    }
    // Free: filter to free-tier blockers only, capped at N
    const free = BLOCKERS.filter(
      (b) => b.tier === "free" && STATE.settings[b.id]
    );
    return free.slice(0, limit);
  }

  // ----- whitelist ------------------------------------------------------

  function currentChannelName() {
    // Watch page: link to channel under <ytd-channel-name>
    const a =
      document.querySelector("ytd-channel-name a") ||
      document.querySelector("#owner #channel-name a") ||
      document.querySelector("#text.ytd-channel-name a");
    return a ? a.textContent.trim() : "";
  }

  function isWhitelistedChannel() {
    if (!STATE.whitelistedChannels.length) return false;
    const name = currentChannelName();
    if (!name) return false;
    return STATE.whitelistedChannels.some(
      (c) => c && c.toLowerCase() === name.toLowerCase()
    );
  }

  // ----- apply blocker state -------------------------------------------

  function applyBlockers() {
    if (!document.body) return;       // very early frame
    // remove all CleanFeed body classes first
    for (const b of BLOCKERS) {
      document.body.classList.remove("cf-block-" + b.id);
    }
    document.body.classList.remove("cf-comments-shown");
    document.body.classList.remove("cf-paused");

    // PAUSE override: if the user clicked "Pause for 1 hour", bypass
    // everything until the timer expires.
    if (isPaused()) {
      document.body.classList.add("cf-paused");
      removeCommentsRestoreButton();
      applyCustomCSS();     // still honour custom CSS — it's the user's own
      return;
    }

    // skip everything if user whitelisted this channel
    if (isWhitelistedChannel()) {
      return;
    }

    const active = effectiveActive();
    for (const b of active) {
      document.body.classList.add("cf-block-" + b.id);
    }

    // inject "Show comments" button if comments blocker is active on a watch page
    const commentsActive = active.some((b) => b.id === "comments");
    if (commentsActive && location.pathname === "/watch") {
      addCommentsRestoreButton();
    } else {
      removeCommentsRestoreButton();
    }

    // Autoplay blocker: when active on a watch page, auto-disable autoplay.
    const autoplayActive = active.some((b) => b.id === "autoplay");
    if (autoplayActive && location.pathname === "/watch") {
      disableAutoplayIfOn();
    }

    // apply pro-only custom CSS (always isolated by id so it can be removed)
    applyCustomCSS();

    // hide video cards whose channel is in the user's blocklist (Pro feature)
    applyChannelBlocks();

    // v1.4.0 F1 — hide video cards whose title contains any blocked keyword
    applyKeywordBlocks();

    // count visible elements that would be hidden — for stats
    countBlockedElements(active);
  }

  // F1 — keyword block sweep. No-op if hiddenKeywords is empty (zero CPU).
  // Substring match, case-insensitive. Match against video title link text.
  function applyKeywordBlocks() {
    if (!STATE.paid || !STATE.hiddenKeywords || !STATE.hiddenKeywords.length) {
      // also un-hide anything we hid previously if the user just cleared
      // their keyword list
      document.querySelectorAll('[data-cf-keyword="1"]').forEach((el) => {
        el.removeAttribute("data-cf-keyword");
      });
      return;
    }
    const cards = document.querySelectorAll(
      "ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer," +
      " ytd-compact-video-renderer, ytd-rich-grid-media, ytd-playlist-renderer"
    );
    const kws = STATE.hiddenKeywords;
    cards.forEach((card) => {
      // Find the title — YT video cards use #video-title or yt-formatted-string#video-title-link
      const tEl = card.querySelector("#video-title, a#video-title-link, yt-formatted-string#video-title");
      if (!tEl) return;
      const title = (tEl.getAttribute("title") || tEl.textContent || "").toLowerCase();
      if (!title) return;
      let hide = false;
      for (var i = 0; i < kws.length; i++) {
        if (kws[i] && title.indexOf(kws[i]) !== -1) { hide = true; break; }
      }
      if (hide) {
        if (card.dataset.cfKeyword !== "1") {
          card.dataset.cfKeyword = "1";
          STATE.counts.total++;
        }
      } else if (card.dataset.cfKeyword === "1") {
        delete card.dataset.cfKeyword;
      }
    });
  }

  // ----- channel blocking (context-menu feature) -----------------------

  function _normalizeHandle(h) {
    if (!h) return "";
    return String(h).trim().toLowerCase().replace(/^@/, "");
  }

  function _findChannelInCard(card) {
    // Return { handle, name } extracted from a video card's DOM, or null.
    // We try (in order): handle link → channel link → display name.
    const link = card.querySelector(
      'a[href^="/@"], ' +
      'a[href^="/channel/"], ' +
      'ytd-channel-name a, ' +
      'a.ytd-video-meta-block, ' +
      'a.yt-simple-endpoint[href^="/@"]'
    );
    if (!link) return null;
    let handle = "";
    const href = link.getAttribute("href") || "";
    if (href.startsWith("/@")) {
      handle = href.split("/")[1] || "";
    } else if (href.startsWith("/channel/")) {
      handle = href.split("/")[2] || "";
    }
    const name = (link.textContent || "").trim();
    if (!handle && !name) return null;
    return { handle: _normalizeHandle(handle), name };
  }

  function _isCardBlocked(info) {
    if (!info) return false;
    return STATE.blockedChannels.some((b) => {
      if (!b) return false;
      if (b.handle && info.handle && _normalizeHandle(b.handle) === info.handle) return true;
      if (b.name && info.name && b.name.toLowerCase() === info.name.toLowerCase()) return true;
      return false;
    });
  }

  function applyChannelBlocks() {
    if (!STATE.blockedChannels.length) return;
    // Match every card type YT uses across home, search, watch sidebar, channel
    const cards = document.querySelectorAll(
      "ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer," +
      " ytd-compact-video-renderer, ytd-rich-grid-media, ytd-playlist-renderer"
    );
    cards.forEach((card) => {
      const info = _findChannelInCard(card);
      if (_isCardBlocked(info)) {
        card.dataset.cfBlockedChannel = "1";
        card.style.display = "none";
      } else if (card.dataset.cfBlockedChannel === "1") {
        // un-hide if user removed the block
        delete card.dataset.cfBlockedChannel;
        card.style.display = "";
      }
    });
  }

  function _setupRightClickTracker() {
    document.addEventListener("mousedown", (e) => {
      if (e.button === 2) {
        STATE.lastRightClicked = e.target;
      }
    }, true);
  }

  async function _onContextMenuBlockChannel(info) {
    if (!STATE.paid) {
      _flashToast("Pro feature — upgrade to block channels", "warn");
      return;
    }
    // Find the nearest video card to the right-clicked element, or fall back
    // to the watch-page channel header if we're on /watch.
    let chInfo = null;
    if (STATE.lastRightClicked) {
      let cur = STATE.lastRightClicked;
      while (cur && cur !== document.body) {
        if (cur.matches && cur.matches(
          "ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer," +
          " ytd-compact-video-renderer, ytd-rich-grid-media, ytd-playlist-renderer"
        )) {
          chInfo = _findChannelInCard(cur);
          break;
        }
        cur = cur.parentElement;
      }
    }
    if (!chInfo && location.pathname === "/watch") {
      // try watch-page header
      const link = document.querySelector(
        'ytd-channel-name a, #owner #channel-name a, ' +
        'ytd-video-owner-renderer a[href^="/@"], ytd-video-owner-renderer a[href^="/channel/"]'
      );
      if (link) {
        const href = link.getAttribute("href") || "";
        let handle = "";
        if (href.startsWith("/@")) handle = href.split("/")[1] || "";
        else if (href.startsWith("/channel/")) handle = href.split("/")[2] || "";
        chInfo = {
          handle: _normalizeHandle(handle),
          name: (link.textContent || "").trim(),
        };
      }
    }
    if (!chInfo || (!chInfo.handle && !chInfo.name)) {
      _flashToast("Couldn't identify the channel — try right-clicking the channel name", "warn");
      return;
    }
    // dedupe
    const exists = STATE.blockedChannels.some(
      (b) => (b.handle && b.handle === chInfo.handle) ||
             (b.name && chInfo.name && b.name.toLowerCase() === chInfo.name.toLowerCase())
    );
    if (exists) {
      _flashToast(`Already blocking ${chInfo.name || chInfo.handle}`, "info");
      return;
    }
    STATE.blockedChannels.push(chInfo);
    await new Promise((res) => {
      chrome.storage.local.set({ blockedChannels: STATE.blockedChannels }, res);
    });
    applyChannelBlocks();
    _flashToast(`Blocked ${chInfo.name || ("@" + chInfo.handle)}`, "good");
  }

  // Tiny CSP-safe toast — uses createElement / textContent, no innerHTML.
  function _flashToast(text, kind) {
    let host = document.getElementById("cf-toast-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "cf-toast-host";
      host.style.cssText = "position:fixed;bottom:20px;left:50%;" +
        "transform:translateX(-50%);z-index:2147483647;pointer-events:none";
      (document.body || document.documentElement).appendChild(host);
    }
    const t = document.createElement("div");
    t.textContent = text;
    const colors = { good: "#1f9d6b", warn: "#c64a5b", info: "#3179c6" };
    t.style.cssText =
      "background:" + (colors[kind] || "#222") + ";color:#fff;" +
      "padding:10px 14px;border-radius:8px;margin-top:6px;" +
      "font:500 13px/1.4 -apple-system,'Segoe UI',Roboto,sans-serif;" +
      "box-shadow:0 8px 24px rgba(0,0,0,0.35);" +
      "opacity:0;transition:opacity 200ms ease,transform 200ms ease;" +
      "transform:translateY(4px)";
    host.appendChild(t);
    requestAnimationFrame(() => {
      t.style.opacity = "1";
      t.style.transform = "translateY(0)";
    });
    setTimeout(() => {
      t.style.opacity = "0";
      setTimeout(() => t.remove(), 220);
    }, 2400);
  }

  /**
   * Find the YouTube autoplay toggle in the player controls and click it OFF
   * if it's currently ON. Idempotent per video — we remember the videoId we've
   * already handled to avoid clicking it back on if the user manually re-enabled it.
   */
  function disableAutoplayIfOn() {
    const videoId = new URLSearchParams(location.search).get("v") || "";
    if (videoId && STATE.autoplayHandledForVideo === videoId) return;
    // Stable selector: the autoplay button has class .ytp-autonav-toggle-button
    // (used since 2019) and exposes aria-checked.
    const btn = document.querySelector(".ytp-autonav-toggle-button");
    if (!btn) return;
    const checked = btn.getAttribute("aria-checked");
    if (checked === "true") {
      try {
        btn.click();
      } catch (_) {
        return;
      }
    }
    if (videoId) STATE.autoplayHandledForVideo = videoId;
  }

  function applyCustomCSS() {
    // Only Pro can use custom CSS
    if (!STATE.paid || !STATE.customCSS) {
      if (STATE.customStyleEl && STATE.customStyleEl.parentNode) {
        STATE.customStyleEl.parentNode.removeChild(STATE.customStyleEl);
      }
      STATE.customStyleEl = null;
      return;
    }
    if (!STATE.customStyleEl) {
      STATE.customStyleEl = document.createElement("style");
      STATE.customStyleEl.id = "cleanfeed-custom-css";
      (document.head || document.documentElement).appendChild(
        STATE.customStyleEl
      );
    }
    // textContent — never innerHTML. Note: this is the user's own CSS for
    // their own browser; they cannot inject scripts via a <style> tag.
    STATE.customStyleEl.textContent = STATE.customCSS;
  }

  // ----- comments restore button ---------------------------------------

  function addCommentsRestoreButton() {
    if (STATE.commentsBtnAdded) return;
    // place button just above where comments would be — under the description
    const anchor =
      document.querySelector("#below.ytd-watch-flexy") ||
      document.querySelector("ytd-watch-metadata") ||
      document.querySelector("#primary.ytd-watch-flexy");
    if (!anchor) return;
    const btn = document.createElement("button");
    btn.className = "cf-show-comments-btn";
    btn.type = "button";
    btn.setAttribute("data-cleanfeed", "show-comments");
    const icon = document.createElement("span");
    icon.textContent = "💬";
    icon.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = "Show comments";
    btn.appendChild(icon);
    btn.appendChild(label);
    btn.addEventListener("click", () => {
      document.body.classList.add("cf-comments-shown");
    });
    anchor.appendChild(btn);
    STATE.commentsBtnAdded = true;
  }

  function removeCommentsRestoreButton() {
    const existing = document.querySelectorAll(".cf-show-comments-btn");
    existing.forEach((el) => el.remove());
    STATE.commentsBtnAdded = false;
  }

  // ----- counting blocked elements -------------------------------------

  function countBlockedElements(active) {
    // We don't recount on every observer tick — only on apply.
    let totalAdded = 0;
    for (const b of active) {
      let found = 0;
      for (const sel of b.selectors) {
        try {
          found += document.querySelectorAll(sel).length;
        } catch (e) {
          /* :has() not supported in some browsers / iframes; skip */
        }
      }
      STATE.counts.perBlocker[b.id] =
        (STATE.counts.perBlocker[b.id] || 0) + found;
      totalAdded += found;
    }
    STATE.counts.total += totalAdded;
    if (totalAdded > 0) persistStats();
  }

  // ----- mutation observer with debounce -------------------------------

  function startObserver() {
    if (STATE.observer) STATE.observer.disconnect();
    if (!document.body) return;
    STATE.observer = new MutationObserver(() => {
      if (STATE.debounceTimer) return;
      STATE.debounceTimer = setTimeout(() => {
        STATE.debounceTimer = 0;
        applyBlockers();
      }, 100);
    });
    STATE.observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function stopObserver() {
    if (STATE.observer) {
      STATE.observer.disconnect();
      STATE.observer = null;
    }
    if (STATE.debounceTimer) {
      clearTimeout(STATE.debounceTimer);
      STATE.debounceTimer = 0;
    }
  }

  // ----- SPA nav detection ---------------------------------------------

  function watchSPANavigation() {
    // YouTube fires this custom event on every SPA navigation
    document.addEventListener("yt-navigate-finish", () => {
      STATE.commentsBtnAdded = false;
      STATE.autoplayHandledForVideo = ""; // re-evaluate autoplay for new video
      applyBlockers();
    });
    // Belt-and-suspenders: poll url changes
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        STATE.commentsBtnAdded = false;
        STATE.autoplayHandledForVideo = "";
        applyBlockers();
      }
    }, 600);
    // Pause-expiry tick: every 30s, if we were paused and the timer has
    // expired, re-apply blockers (and any popup will refresh on next open).
    setInterval(() => {
      if (STATE.pausedUntil && STATE.pausedUntil <= Date.now()) {
        STATE.pausedUntil = 0;
        applyBlockers();
      }
    }, 30 * 1000);
  }

  // ----- message routing -----------------------------------------------

  function listenForRuntimeMessages() {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === "cf:settings-changed") {
        STATE.settings = Object.assign(STATE.settings, msg.settings || {});
        if (typeof msg.paid === "boolean") STATE.paid = msg.paid;
        if (Array.isArray(msg.whitelistedChannels)) {
          STATE.whitelistedChannels = msg.whitelistedChannels;
        }
        if (typeof msg.customCSS === "string") {
          STATE.customCSS = msg.customCSS;
        }
        if (typeof msg.pausedUntil === "number") {
          STATE.pausedUntil = msg.pausedUntil;
        }
        applyBlockers();
        sendResponse({ ok: true });
        return true;
      }
      if (msg && msg.type === "cf:get-stats") {
        sendResponse({ stats: STATE.counts });
        return true;
      }
      if (msg && msg.type === "cf:reset-stats") {
        STATE.counts = { total: 0, perBlocker: {} };
        persistStats();
        sendResponse({ ok: true });
        return true;
      }
      if (msg && msg.type === "cf:block-channel-at") {
        _onContextMenuBlockChannel(msg);
        sendResponse({ ok: true });
        return true;
      }
    });
    // Storage changes from popup/options/background — keep in sync.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.pausedUntil) {
        STATE.pausedUntil = Number(changes.pausedUntil.newValue) || 0;
        applyBlockers();
      }
      if (changes.settings) {
        STATE.settings = changes.settings.newValue || STATE.settings;
        applyBlockers();
      }
      if (changes.blockedChannels) {
        STATE.blockedChannels = Array.isArray(changes.blockedChannels.newValue)
          ? changes.blockedChannels.newValue : [];
        applyChannelBlocks();
      }
      if (changes.focusLock) {
        STATE.focusLock = changes.focusLock.newValue || { activeUntil: 0, pinSet: false };
        applyBlockers();
      }
      if (changes.hiddenKeywords) {
        STATE.hiddenKeywords = Array.isArray(changes.hiddenKeywords.newValue) ? changes.hiddenKeywords.newValue : [];
        applyBlockers();
      }
      if (changes.perPageEnabled) {
        STATE.perPageEnabled = !!changes.perPageEnabled.newValue;
        applyBlockers();
      }
      if (changes.perPageSettings) {
        STATE.perPageSettings = changes.perPageSettings.newValue || { homepage: {}, watch: {}, subscriptions: {} };
        applyBlockers();
      }
    });
  }

  // ----- time tracking (visibility-based) -------------------------------
  //
  // We tick every 5s while document is visible AND has focus. Each tick
  // posts the delta (ms) to the background service worker which aggregates
  // it per-day in chrome.storage.local under `timeTracking`.
  //
  // Counts only real viewing time — minimised windows, background tabs,
  // and unfocused Chrome windows are excluded by the visibility/focus
  // check.

  let _ttLastTick = 0;
  let _ttInterval = 0;

  function startTimeTracker() {
    if (_ttInterval) return;
    _ttLastTick = Date.now();
    _ttInterval = setInterval(() => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) {
        _ttLastTick = Date.now();   // pause: don't count this gap
        return;
      }
      const now = Date.now();
      const delta = Math.min(now - _ttLastTick, 10_000);  // clamp at 10s
      _ttLastTick = now;
      if (delta > 0) {
        chrome.runtime.sendMessage({ type: "cf:track-time", ms: delta })
          .catch(() => {});
      }
    }, 5000);
    // Also flush on tab close / navigation
    window.addEventListener("pagehide", () => {
      if (_ttInterval) {
        clearInterval(_ttInterval);
        _ttInterval = 0;
      }
    }, { once: true });
  }

  // ----- bootstrap -----------------------------------------------------

  async function init() {
    startTimeTracker();
    _setupRightClickTracker();
    await getSettings();
    listenForRuntimeMessages();
    // Wait for body — we run at document_start
    if (document.body) {
      applyBlockers();
      startObserver();
    } else {
      const ready = () => {
        applyBlockers();
        startObserver();
        document.removeEventListener("DOMContentLoaded", ready);
      };
      document.addEventListener("DOMContentLoaded", ready);
    }
    watchSPANavigation();
    // Cleanup on unload — guards against memory leaks across SPA churn
    // YouTube ships a Permissions-Policy that disallows `unload` events
    // ("Permissions policy violation: unload is not allowed in this
    // document"). `pagehide` covers tab close, navigation, and
    // bfcache eviction — same cleanup window, no policy warning.
    window.addEventListener("pagehide", stopObserver, { once: true });
  }

  init().catch((e) => {
    /* never throw out of a content script */
    if (chrome && chrome.runtime && chrome.runtime.lastError) {
      /* swallow */
    }
  });
})();
