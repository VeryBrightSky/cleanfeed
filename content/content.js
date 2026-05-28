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

  // v1.4.19 — Smart exemption for YouTube Music.
  // The manifest matches *.youtube.com so this content script also loads on
  // music.youtube.com. Music users almost universally don't want CleanFeed's
  // distraction-blocking applied to a music app, so we bail out completely
  // before any state load, observer setup, time tracking, or DOM mutation.
  // The popup mirrors this — see popup.js's _isOnYouTubeMusicTab().
  function isYouTubeMusicHost() {
    const h = (location && location.hostname) || "";
    return h === "music.youtube.com" || /(^|\.)music\.youtube\.com$/.test(h);
  }
  if (isYouTubeMusicHost()) {
    return;
  }

  // v1.4.9 — defensively clamp pausedUntil reads to (now + 1hr + 5min).
  // Anything bigger is treated as 0. Fail-OPEN here means fail-CLOSED for
  // the user: a corrupted timestamp can never pin the extension paused.
  const PAUSE_MAX_DURATION_MS = 60 * 60 * 1000;
  const PAUSE_MAX_SLACK_MS = 5 * 60 * 1000;
  function sanePausedUntil(raw) {
    const n = Number(raw) || 0;
    if (n <= 0) return 0;
    if (n > Date.now() + PAUSE_MAX_DURATION_MS + PAUSE_MAX_SLACK_MS) return 0;
    return n;
  }

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
    redirectHomeToSubs: false,    // v1.4.19 F2
    blockerModes: {},             // v1.4.19 F3 — per-blocker render mode
    pausedUntil: 0,        // unix ms; 0 = not paused
    // v1.4.14 — per-page-view manual reveal of the comments section.
    // Set when the user clicks "Show comments"; reset ONLY on real
    // canonical-video-identity change (pathname + ?v=) via maybeNavReset.
    // v1.4.14 also drives applyCommentsManualReveal() which sets inline
    // `display: block !important` on the comments elements directly —
    // the body class + stylesheet tie-break that v1.4.12-13 relied on
    // was unreliable in real Chrome (the MutationObserver doesn't watch
    // body's attributes, so external class wipes went undetected).
    commentsManuallyShown: false,
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
         "hiddenKeywords", "perPageEnabled", "perPageSettings",
         // v1.4.19
         "redirectHomeToSubs", "blockerModes"],
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
          STATE.pausedUntil = sanePausedUntil(data.pausedUntil);
          STATE.blockedChannels = Array.isArray(data.blockedChannels) ? data.blockedChannels : [];
          STATE.focusLock = data.focusLock || { activeUntil: 0, pinSet: false };
          STATE.hiddenKeywords = Array.isArray(data.hiddenKeywords) ? data.hiddenKeywords : [];
          STATE.perPageEnabled = !!data.perPageEnabled;
          STATE.perPageSettings = data.perPageSettings || { homepage: {}, watch: {}, subscriptions: {} };
          STATE.redirectHomeToSubs = !!data.redirectHomeToSubs;
          STATE.blockerModes = (data.blockerModes && typeof data.blockerModes === "object") ? data.blockerModes : {};
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

  // v1.4.19 F2 — Homepage → Subscriptions redirect.
  //
  // Only fires when:
  //   - settings.redirectHomeToSubs is true
  //   - host is exactly youtube.com (or www.youtube.com), NOT music.youtube.com
  //     (that case never reaches here — the music guard at the top of the IIFE
  //     bailed). We still allow www subdomains so URL bookmarks work.
  //   - pathname is the bare root: "/" or empty string
  //   - the URL doesn't reference an in-app hash route like #/foo
  //
  // We use location.replace so the homepage doesn't end up in browser history.
  // SPA navigations (clicking the YouTube logo) are caught via yt-navigate-finish.
  function _isBareHomepage() {
    const p = location.pathname || "";
    if (p !== "/" && p !== "") return false;
    const h = location.hash || "";
    if (h && h.length > 1 && h.charAt(1) !== "?") return false;
    return true;
  }
  function maybeRedirectHomeToSubs() {
    if (!STATE.redirectHomeToSubs) return false;
    if (!_isBareHomepage()) return false;
    // Already on /feed/subscriptions? (shouldn't be possible past the path
    // check but belt-and-suspenders against future logic changes.)
    if (location.pathname.indexOf("/feed/subscriptions") === 0) return false;
    try {
      location.replace("/feed/subscriptions");
    } catch (_) { /* about:blank or sandbox — skip */ }
    return true;
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

  // v1.4.19 F3 — read the user's render-mode choice for a given blocker.
  // Missing entries (unmigrated users, blockers never touched in the popup)
  // fall back to "hide" — zero behaviour change from pre-v1.4.19.
  function _effectiveModeFor(id) {
    const m = STATE.blockerModes && STATE.blockerModes[id];
    return (m === "blur" || m === "dim") ? m : "hide";
  }

  function applyBlockers() {
    if (!document.body) return;       // very early frame
    // remove all CleanFeed body classes first
    for (const b of BLOCKERS) {
      document.body.classList.remove("cf-block-" + b.id);
      // v1.4.19 F3 — also remove any prior mode class for this blocker.
      document.body.classList.remove("cf-mode-" + b.id + "-hide");
      document.body.classList.remove("cf-mode-" + b.id + "-blur");
      document.body.classList.remove("cf-mode-" + b.id + "-dim");
    }
    document.body.classList.remove("cf-paused");
    // v1.4.14 — cf-comments-shown body class and the inline-style reveal are
    // NOT touched here. They reflect a per-page-view user choice persisted
    // in STATE.commentsManuallyShown and are re-applied (or cleared) below.

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
      // v1.4.19 F3 — pair the cf-block-* class with the chosen render mode.
      // CSS lives in styles.css under "BLOCKER RENDER MODES".
      document.body.classList.add("cf-mode-" + b.id + "-" + _effectiveModeFor(b.id));
    }

    // inject "Show comments" button if comments blocker is active on a watch page
    const commentsActive = active.some((b) => b.id === "comments");
    if (commentsActive && location.pathname === "/watch") {
      addCommentsRestoreButton();
      // v1.4.14 — the comments visibility no longer rides on a body-class +
      // stylesheet tie-break. v1.4.13 kept cf-comments-shown on body and
      // depended on its CSS rule winning the cascade tie against
      // cf-block-comments via source order. That mechanism failed in real
      // Chrome — primarily because our MutationObserver (startObserver) only
      // watches childList+subtree, NOT body attribute mutations, so any
      // external modification of body.className (YT's framework, theme
      // toggles, etc.) that drops cf-comments-shown went undetected until
      // the next subtree mutation triggered applyBlockers. Idle users could
      // see the comments stay re-hidden indefinitely.
      // We now apply inline `display: block !important` directly to each
      // comments DOM element via applyCommentsManualReveal(). Inline
      // !important is the TOP of the CSS cascade — it beats every author
      // stylesheet rule regardless of specificity, source order, or
      // external body-class wipes. Re-applied on every applyBlockers tick
      // so YT replacing the ytd-comments element doesn't lose the reveal.
      // The cf-comments-shown body class is still set/cleared so the
      // existing CSS rule hiding .cf-show-comments-btn keeps working (no
      // cascade tie-break risk there — that rule is unopposed).
      if (STATE.commentsManuallyShown) {
        document.body.classList.add("cf-comments-shown");
        applyCommentsManualReveal();
      } else {
        document.body.classList.remove("cf-comments-shown");
        clearCommentsManualReveal();
      }
    } else {
      removeCommentsRestoreButton();
      document.body.classList.remove("cf-comments-shown");
      clearCommentsManualReveal();
      // v1.4.15 — also reset the per-page-view manual reveal state when
      // we're not in the "comments-blocker-active-on-watch" condition.
      // Without this, toggling the Comments blocker OFF in the popup
      // cleared the visible reveal (via clearCommentsManualReveal above)
      // but left STATE.commentsManuallyShown stale at true; when the user
      // then toggled the blocker BACK ON, applyBlockers' true branch read
      // the stale flag and re-applied the inline reveal — the comments
      // stayed visible and the restore button stayed hidden, so the
      // toggle-on appeared to do nothing. v1.4.13's maybeNavReset already
      // handles the navigation path (pathname / v= change); this line
      // handles the same-page settings-change path.
      STATE.commentsManuallyShown = false;
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

    // v1.4.19 F4 — mark already-watched (>95% progress) tiles on /feed/subscriptions
    // with data-cf-watched="1" so the cf-block-subs-watched CSS rule can hide them.
    // Active flag is read from the `active` list passed in by effectiveActive().
    const subsWatchedActive = active.some((b) => b.id === "subs-watched");
    applyWatchedSweep(subsWatchedActive);

    // count visible elements that would be hidden — for stats
    countBlockedElements(active);

    // v1.4.20-alpha — Phase 1: capture the current "Up next" candidate for
    // the autoplay counterfactual tracker. Idempotent per /watch?v= identity.
    _captureAutoplayContext();
  }

  // v1.4.19 F4 — sweep subscription tiles for >95% progress.
  // Idempotent: cards already tagged are skipped on subsequent ticks. When
  // the blocker is toggled off (active===false), un-tag everything we marked
  // so the cards reappear without a page reload.
  function applyWatchedSweep(active) {
    if (!active) {
      // Clean up our markers; the CSS hide rule depends on the attribute.
      document.querySelectorAll('ytd-rich-item-renderer[data-cf-watched="1"]').forEach((el) => {
        el.removeAttribute("data-cf-watched");
      });
      return;
    }
    // Pro-only feature — skip the sweep entirely for free users (defensive;
    // effectiveActive should already have filtered it out).
    if (!STATE.paid) return;
    // Scope: only /feed/subscriptions cards have meaningful "already watched"
    // semantics in the user's mental model. The CSS selector also scopes by
    // page-subtype, so a marked card outside subscriptions wouldn't hide —
    // but we save CPU by scoping the sweep here too.
    if (location.pathname.indexOf("/feed/subscriptions") !== 0) return;
    const overlays = document.querySelectorAll(
      'ytd-rich-item-renderer ytd-thumbnail-overlay-resume-playback-renderer #progress'
    );
    overlays.forEach((bar) => {
      // Parse the inline width: YT writes style="width: 97%;" on the bar.
      const style = bar.getAttribute("style") || "";
      const m = style.match(/width\s*:\s*(\d+(?:\.\d+)?)\s*%/);
      if (!m) return;
      const pct = parseFloat(m[1]);
      if (!isFinite(pct) || pct <= 95) return;
      // Climb to the parent ytd-rich-item-renderer (the grid card).
      let cur = bar;
      while (cur && cur !== document.body && cur.tagName !== "YTD-RICH-ITEM-RENDERER") {
        cur = cur.parentElement;
      }
      if (cur && cur.tagName === "YTD-RICH-ITEM-RENDERER" && cur.getAttribute("data-cf-watched") !== "1") {
        cur.setAttribute("data-cf-watched", "1");
      }
    });
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

  // v1.4.14 — selectors used both by the cf-block-comments stylesheet rule
  // and by our inline-style reveal. Keep these in sync with styles.css.
  const _COMMENTS_REVEAL_SELECTORS = [
    "ytd-comments#comments",
    "#comments.ytd-watch-flexy",
    "ytd-comments-header-renderer",
  ];

  // v1.4.14 — set inline `display: block !important` on each comments
  // element. Inline !important beats the cf-block-comments stylesheet rule
  // (and any other author rule) regardless of CSS specificity, source order,
  // or whether the cf-comments-shown class is still on body. Mark each
  // element with data-cf-shown="1" so clearCommentsManualReveal can find
  // them again without trampling YT's own inline display styles.
  function applyCommentsManualReveal() {
    for (const sel of _COMMENTS_REVEAL_SELECTORS) {
      document.querySelectorAll(sel).forEach((el) => {
        el.style.setProperty("display", "block", "important");
        // v1.4.19 F3 — neutralize any blur/dim mode CSS rule that would
        // otherwise leave the manually-revealed comments visually muffled.
        // Inline !important beats the CSS rules' two-class specificity.
        el.style.setProperty("filter", "none", "important");
        el.style.setProperty("opacity", "1", "important");
        el.style.setProperty("pointer-events", "auto", "important");
        el.setAttribute("data-cf-shown", "1");
      });
    }
  }

  function clearCommentsManualReveal() {
    document.querySelectorAll('[data-cf-shown="1"]').forEach((el) => {
      el.style.removeProperty("display");
      el.style.removeProperty("filter");
      el.style.removeProperty("opacity");
      el.style.removeProperty("pointer-events");
      el.removeAttribute("data-cf-shown");
    });
  }

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
      // v1.4.14 — record the manual reveal as state AND apply inline
      // `display: block !important` directly to the comments elements.
      // Inline !important beats any author stylesheet rule regardless of
      // cascade tie-break. v1.4.12-13 relied on a body class + stylesheet
      // mechanism that failed in real Chrome (see applyBlockers comment).
      STATE.commentsManuallyShown = true;
      document.body.classList.add("cf-comments-shown");
      applyCommentsManualReveal();
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

  // v1.4.12 — WeakSet of elements we've already counted in this
  // content-script's lifetime. Without it, applyBlockers() (which fires
  // ~100ms after every YT subtree mutation via the MutationObserver)
  // re-counted the same elements on every tick, inflating the popup's
  // "elements blocked this session" to 5–6 digits within minutes.
  const _countedEls = new WeakSet();

  // v1.4.20-alpha — Phase 1 analytics instrumentation.
  // PER-BLOCKER WeakSet of elements we've already credited to that blocker's
  // daily counter. Separate from _countedEls so that an element matched by
  // both blocker A and blocker B (selector overlap, rare) counts for both —
  // matches the user's mental model of "each blocker hid N items today".
  // Same per-page-load lifetime as _countedEls: the WeakSet is GC'd when the
  // content script's IIFE is unloaded (tab close, navigation away).
  const _perBlockerCounted = new Map();   // blockerId -> WeakSet

  function countBlockedElements(active) {
    let totalAdded = 0;
    for (const b of active) {
      let found = 0;
      let perBlockerNew = 0;
      if (!_perBlockerCounted.has(b.id)) _perBlockerCounted.set(b.id, new WeakSet());
      const blockerSet = _perBlockerCounted.get(b.id);
      for (const sel of b.selectors) {
        try {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            // v1.4.20-alpha — per-blocker counter (cf_stats.blocked).
            // Uses the per-blocker WeakSet so overlapping selectors still
            // credit each blocker for an element it covers.
            if (!blockerSet.has(el)) {
              blockerSet.add(el);
              perBlockerNew++;
            }
            // v1.4.12 — session-stats global dedupe (unchanged behaviour).
            if (_countedEls.has(el)) continue;
            _countedEls.add(el);
            found++;
          }
        } catch (e) {
          /* :has() not supported in some browsers / iframes; skip */
        }
      }
      if (perBlockerNew > 0) _statsIncrementBlocker(b.id, perBlockerNew);
      STATE.counts.perBlocker[b.id] =
        (STATE.counts.perBlocker[b.id] || 0) + found;
      totalAdded += found;
    }
    STATE.counts.total += totalAdded;
    if (totalAdded > 0) persistStats();
  }

  // ============================================================
  // v1.4.20-alpha Phase 1 — analytics instrumentation
  //
  // Two persistent data streams accumulate into chrome.storage.local.cf_stats:
  //   1. blocked: per-blocker, per-day count of items hidden
  //   2. autoplay_avoided: per-day count of "Up next" videos the user
  //      navigated away from instead of letting autoplay continue
  //
  // No UI consumes these in Phase 1. Phase 2 will render the dashboard.
  //
  // Write strategy: in-memory delta map + 30s coalescing timer + flush on
  // pagehide. Prevents the storage write-storm that would happen if every
  // applyBlockers tick wrote synchronously. The delta is merged with a fresh
  // read of storage at flush time, so two content scripts on different tabs
  // don't clobber each other's counts.
  // ============================================================

  // Coalescing delta. Reset to empty after each successful flush. Anything
  // accumulated during the flush's await lands in the *next* delta and
  // flushes on the next timer tick — no data loss.
  let _statsDelta = { blocked: {}, autoplay_avoided: { videos: 0, estimated_minutes: 0 } };
  let _statsFlushTimer = 0;
  let _statsFlushInFlight = false;
  const STATS_FLUSH_MS = 30 * 1000;

  function _statsTodayKey() {
    const d = new Date();
    return d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }

  function _statsIncrementBlocker(blockerId, delta) {
    if (!blockerId || delta <= 0) return;
    const day = _statsTodayKey();
    if (!_statsDelta.blocked[day]) _statsDelta.blocked[day] = {};
    _statsDelta.blocked[day][blockerId] = (_statsDelta.blocked[day][blockerId] || 0) + delta;
    _scheduleStatsFlush();
  }

  function _statsIncrementAutoplayAvoided(minutes) {
    _statsDelta.autoplay_avoided.videos++;
    _statsDelta.autoplay_avoided.estimated_minutes += Math.max(0, Math.round(minutes));
    _scheduleStatsFlush();
  }

  function _statsHasPending() {
    if (_statsDelta.autoplay_avoided.videos > 0) return true;
    for (const day of Object.keys(_statsDelta.blocked)) {
      if (Object.keys(_statsDelta.blocked[day]).length > 0) return true;
    }
    return false;
  }

  function _scheduleStatsFlush() {
    if (_statsFlushTimer || _statsFlushInFlight) return;
    _statsFlushTimer = setTimeout(() => {
      _statsFlushTimer = 0;
      _flushStats();
    }, STATS_FLUSH_MS);
  }

  async function _flushStats() {
    if (_statsFlushInFlight) return;
    if (!_statsHasPending()) return;
    _statsFlushInFlight = true;
    // Snapshot + reset the delta BEFORE the async read so any new
    // increments during the await land in a fresh delta (no double-count).
    const snapshot = _statsDelta;
    _statsDelta = { blocked: {}, autoplay_avoided: { videos: 0, estimated_minutes: 0 } };
    try {
      const data = await new Promise((resolve) => {
        chrome.storage.local.get(["cf_stats"], (d) => resolve(d || {}));
      });
      // Defensive: if cf_stats doesn't exist (background migration hasn't
      // run yet on a brand-new install), seed it lazily. The session_started
      // here is the first time we ever observed activity — typically only
      // happens if a YouTube tab loads before background's onInstalled fires.
      const cf_stats = (data.cf_stats && typeof data.cf_stats === "object")
        ? data.cf_stats
        : { blocked: {}, autoplay_avoided: {}, session_started: Date.now() };
      if (!cf_stats.blocked) cf_stats.blocked = {};
      if (!cf_stats.autoplay_avoided) cf_stats.autoplay_avoided = {};
      // Merge blocked counters.
      for (const day of Object.keys(snapshot.blocked)) {
        if (!cf_stats.blocked[day]) cf_stats.blocked[day] = {};
        for (const id of Object.keys(snapshot.blocked[day])) {
          cf_stats.blocked[day][id] = (cf_stats.blocked[day][id] || 0) + snapshot.blocked[day][id];
        }
      }
      // Merge autoplay-avoided counter (single bucket = today).
      if (snapshot.autoplay_avoided.videos > 0 || snapshot.autoplay_avoided.estimated_minutes > 0) {
        const day = _statsTodayKey();
        if (!cf_stats.autoplay_avoided[day]) {
          cf_stats.autoplay_avoided[day] = { videos: 0, estimated_minutes: 0 };
        }
        cf_stats.autoplay_avoided[day].videos += snapshot.autoplay_avoided.videos;
        cf_stats.autoplay_avoided[day].estimated_minutes += snapshot.autoplay_avoided.estimated_minutes;
      }
      await new Promise((resolve) => {
        chrome.storage.local.set({ cf_stats }, () => resolve());
      });
    } catch (_) {
      // If storage write fails, re-merge the snapshot back into the delta
      // so the next flush picks it up. Better to over-count once than to
      // silently drop a user's day of stats.
      for (const day of Object.keys(snapshot.blocked)) {
        if (!_statsDelta.blocked[day]) _statsDelta.blocked[day] = {};
        for (const id of Object.keys(snapshot.blocked[day])) {
          _statsDelta.blocked[day][id] = (_statsDelta.blocked[day][id] || 0) + snapshot.blocked[day][id];
        }
      }
      _statsDelta.autoplay_avoided.videos += snapshot.autoplay_avoided.videos;
      _statsDelta.autoplay_avoided.estimated_minutes += snapshot.autoplay_avoided.estimated_minutes;
    } finally {
      _statsFlushInFlight = false;
    }
  }

  // ----- autoplay counterfactual tracker (Phase 1) ---------------------
  //
  // On /watch pages we capture the FIRST "Up next" candidate in the
  // recommendations sidebar (videoId + duration + a snapshot of YT's
  // autoplay-toggle state at the moment of capture). When the user
  // navigates AWAY from /watch — to a different /watch?v=, to a non-/watch
  // path, or via pagehide — we evaluate:
  //
  //   Skip if no candidate was captured (sidebar never loaded in time).
  //   Skip if autoplay was OFF at capture time (per spec; nothing to avoid).
  //   Skip if the user explicitly clicked inside the sidebar (tracked via
  //     a delegated click listener — they ACTIVELY picked the next video).
  //   Skip if the destination /watch?v=<id> matches the captured candidate
  //     (either autoplay progressed naturally, OR the user clicked exactly
  //     the suggested next — indistinguishable from our perspective; in
  //     both cases they DID watch the predicted video so it's not avoided).
  //
  //   Otherwise: AVOIDED. Increment cf_stats.autoplay_avoided.{videos,
  //   estimated_minutes}. estimated_minutes uses the captured duration if
  //   we parsed it; falls back to 10 (per spec) if duration parsing failed.
  //
  // ASSUMPTIONS marked in the code where they're load-bearing.
  STATE.autoplay = {
    watchVideoId: "",         // current /watch?v= identity
    capturedNext: null,        // { videoId, duration_sec } or null
    autoplayWasOn: false,      // YT autoplay toggle state at capture time
    userClickedSidebar: false, // delegated click landed inside the sidebar
  };

  function _parseDurationToSec(txt) {
    if (!txt) return 0;
    const parts = String(txt).trim().split(":").map((s) => parseInt(s, 10));
    if (parts.some((n) => !isFinite(n) || isNaN(n))) return 0;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 1) return parts[0];
    return 0;
  }

  function _readSidebarDurationFromCard(card) {
    // YT renders durations in a few different containers depending on layout
    // experiment cohort. Try the canonical thumbnail-overlay first, then a
    // couple of fallbacks observed in 2026 experiments.
    const el = card.querySelector(
      "ytd-thumbnail-overlay-time-status-renderer #text, " +
      "ytd-thumbnail-overlay-time-status-renderer span#text, " +
      ".badge-shape-wiz__text, " +
      ".ytd-thumbnail-overlay-time-status-renderer"
    );
    if (!el) return 0;
    return _parseDurationToSec(el.textContent || "");
  }

  function _captureAutoplayContext() {
    if (location.pathname !== "/watch") return;
    const myVideoId = (() => {
      try { return new URLSearchParams(location.search).get("v") || ""; }
      catch (_) { return ""; }
    })();
    // Fresh /watch view: reset capture state. The CALLER (nav handler)
    // is responsible for evaluating "avoided" against the PREVIOUS video's
    // capture before we wipe it.
    if (STATE.autoplay.watchVideoId !== myVideoId) {
      STATE.autoplay.watchVideoId = myVideoId;
      STATE.autoplay.capturedNext = null;
      STATE.autoplay.userClickedSidebar = false;
      // ASSUMPTION: read autoplay toggle state at capture time, not at
      // nav-away time. If the user flips autoplay mid-video, we still
      // evaluate against the moment we recorded the candidate. This avoids
      // edge cases where YT itself toggles autoplay during playback.
      const btn = document.querySelector(".ytp-autonav-toggle-button");
      STATE.autoplay.autoplayWasOn = !!(btn && btn.getAttribute("aria-checked") === "true");
    }
    if (STATE.autoplay.capturedNext) return;  // already captured for this video
    // ASSUMPTION: the FIRST ytd-compact-video-renderer in the sidebar IS the
    // "Up next" candidate. YT can shuffle the order with chapters / playlist
    // queue, but the first card is the one YT would auto-progress to. If
    // chapters / playlist queues become more common, this becomes wrong.
    const firstCard = document.querySelector(
      "ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer"
    ) || document.querySelector("ytd-compact-video-renderer");
    if (!firstCard) return;
    const link = firstCard.querySelector("a#thumbnail[href*='/watch'], a.ytd-compact-video-renderer[href*='/watch']");
    if (!link) return;
    const href = link.getAttribute("href") || "";
    const m = href.match(/[?&]v=([A-Za-z0-9_-]{6,})/);
    if (!m) return;
    const dur = _readSidebarDurationFromCard(firstCard);
    STATE.autoplay.capturedNext = {
      videoId: m[1],
      duration_sec: dur,
    };
  }

  function _setupSidebarClickTracker() {
    // Delegated click listener — sits at document level, capture-phase, so
    // even if YT's own handlers stop propagation we still see the click.
    // ASSUMPTION: "sidebar" is anything inside #secondary or the
    // ytd-watch-next-secondary-results-renderer. The Comments restore
    // button injected by CleanFeed lives in #below, NOT here, so it
    // won't false-trigger this marker.
    document.addEventListener("click", (e) => {
      if (location.pathname !== "/watch") return;
      let cur = e.target;
      while (cur && cur !== document.body) {
        if (cur.matches && (
          cur.matches("ytd-watch-next-secondary-results-renderer") ||
          cur.matches("ytd-watch-next-secondary-results-renderer *") ||
          cur.matches("ytd-watch-flexy #secondary") ||
          cur.matches("ytd-watch-flexy #secondary *") ||
          cur.matches("ytd-compact-video-renderer") ||
          cur.matches("ytd-compact-video-renderer *")
        )) {
          STATE.autoplay.userClickedSidebar = true;
          return;
        }
        cur = cur.parentElement;
      }
    }, true);
  }

  // Called from the SPA nav handler when we detect a real video-identity
  // change. `prevIdentity` is the URL identity we WERE on (pathname + ?v=).
  // `newIdentity` is the URL we are NOW on. Both are passed in because
  // location has already been updated by the time yt-navigate-finish fires.
  function _evaluateAutoplayAvoided(prevIdentity, newIdentity) {
    if (!prevIdentity || prevIdentity.indexOf("/watch?v=") !== 0) return;
    const prevVideoId = prevIdentity.slice("/watch?v=".length);
    // The capture state must match the video we're leaving — if STATE was
    // overwritten by a faster nav, skip rather than misattribute.
    if (STATE.autoplay.watchVideoId !== prevVideoId) return;
    if (!STATE.autoplay.capturedNext) return;
    if (!STATE.autoplay.autoplayWasOn) return;       // spec: skip if YT autoplay was off
    if (STATE.autoplay.userClickedSidebar) return;   // user actively chose
    // Destination videoId, if any.
    let destVideoId = "";
    if (newIdentity && newIdentity.indexOf("/watch?v=") === 0) {
      destVideoId = newIdentity.slice("/watch?v=".length);
    }
    if (destVideoId && destVideoId === STATE.autoplay.capturedNext.videoId) {
      // They watched (or auto-progressed to) the predicted next. NOT avoided.
      return;
    }
    const dur = STATE.autoplay.capturedNext.duration_sec;
    const mins = dur > 0 ? dur / 60 : 10;            // spec fallback: 10 min
    _statsIncrementAutoplayAvoided(mins);
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

  // v1.4.13 — canonical "video identity" for navigation comparison.
  // Pre-v1.4.13, watchSPANavigation reset STATE.commentsManuallyShown on
  // EITHER yt-navigate-finish OR any change to location.href. Both fire
  // for non-video-change events:
  //   - yt-navigate-finish fires for YT-internal page-state transitions
  //     (comments tab init, page-data re-hydration) even on the same video.
  //   - location.href changes when YT adds/updates &t=<timestamp> on the
  //     same video (chapter marker click, scrub, timestamp in description
  //     or comment, YT's own URL updates).
  // After click→reveal, either spurious trigger wiped the manual-reveal
  // state and re-hid comments — the symptom we shipped v1.4.12 to fix
  // but mis-aimed at applyBlockers() alone. The real reset gate is
  // "did the canonical video identity change?", not "did anything happen?".
  function _navIdentity() {
    let v = "";
    try { v = new URLSearchParams(location.search).get("v") || ""; } catch (_) {}
    return location.pathname + "?v=" + v;
  }

  function watchSPANavigation() {
    let lastNav = _navIdentity();
    _lastNavMirror = lastNav;   // v1.4.20-alpha — pagehide handler reads this

    function maybeNavReset() {
      const cur = _navIdentity();
      if (cur === lastNav) return false;
      // v1.4.20-alpha — evaluate the autoplay counterfactual BEFORE we
      // overwrite lastNav, so we still know which video we were on. This
      // catches both /watch → /watch?v=different and /watch → non-/watch.
      _evaluateAutoplayAvoided(lastNav, cur);
      lastNav = cur;
      _lastNavMirror = cur;
      STATE.commentsBtnAdded = false;
      STATE.autoplayHandledForVideo = "";
      STATE.commentsManuallyShown = false;
      if (document.body) document.body.classList.remove("cf-comments-shown");
      clearCommentsManualReveal();   // v1.4.14 — also tear down inline reveal
      return true;
    }

    // YouTube fires yt-navigate-finish for both real nav AND internal page
    // transitions. We always re-apply blockers on it (cheap + correct on
    // real nav), but only reset per-video-view state when the canonical
    // identity (pathname + ?v=) actually changes.
    document.addEventListener("yt-navigate-finish", () => {
      // v1.4.19 F2 — re-check redirect on every SPA nav. Clicking the YT
      // logo from any sub-page lands on bare "/"; if the user has the
      // toggle on, hop to /feed/subscriptions before we even paint.
      if (maybeRedirectHomeToSubs()) return;
      maybeNavReset();
      applyBlockers();
    });
    // Belt-and-suspenders URL poll. Only acts on canonical-identity changes,
    // so adding &t=<timestamp> to the same video is a no-op (was reset
    // pre-v1.4.13 and tripped the comments-reveal bug).
    setInterval(() => {
      if (maybeNavReset()) applyBlockers();
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
          STATE.pausedUntil = sanePausedUntil(msg.pausedUntil);
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
        STATE.pausedUntil = sanePausedUntil(changes.pausedUntil.newValue);
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
      // v1.4.19 F2 — react to redirect-toggle flip. If the user enables
      // the toggle while on the bare homepage, the redirect fires; if they
      // disable it on /feed/subscriptions, nothing to do (they're already
      // somewhere — we don't navigate back).
      if (changes.redirectHomeToSubs) {
        STATE.redirectHomeToSubs = !!changes.redirectHomeToSubs.newValue;
        maybeRedirectHomeToSubs();
      }
      // v1.4.19 F3 — react to blocker-mode changes. Just re-apply blockers;
      // applyBlockers reads STATE.blockerModes and emits cf-mode-*-* body
      // classes so the CSS picks up the new render mode immediately.
      if (changes.blockerModes) {
        STATE.blockerModes = (changes.blockerModes.newValue && typeof changes.blockerModes.newValue === "object")
          ? changes.blockerModes.newValue : {};
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
    _setupSidebarClickTracker();   // v1.4.20-alpha — autoplay counterfactual
    await getSettings();
    // v1.4.19 F2 — fire redirect immediately after settings load if we're on
    // the bare homepage. location.replace navigates away; nothing else this
    // tick has any effect, but we still register listeners + start observer
    // for the new page that the redirect lands on (the same content script
    // re-runs on the new doc).
    if (maybeRedirectHomeToSubs()) return;
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
    // v1.4.20-alpha — Phase 1: pagehide is our last chance to record an
    // autoplay-avoided event (tab close from /watch) and to flush any
    // pending stats delta. Separate listener so it runs even if
    // stopObserver throws.
    window.addEventListener("pagehide", () => {
      try {
        // ASSUMPTION: pagehide from /watch with autoplay-was-on and no
        // sidebar click counts as avoided. We can't observe the
        // destination at pagehide time (tab is dying) so we treat it
        // identically to a SPA nav off /watch with destination=non-/watch.
        if (location.pathname === "/watch") {
          _evaluateAutoplayAvoided(lastNavForPagehide(), "");
        }
      } catch (_) {}
      // Fire-and-forget the final flush. chrome.storage.local.set called
      // synchronously during pagehide is documented as best-effort by the
      // Chrome MV3 spec.
      _flushStats();
    }, { once: true });
  }

  // v1.4.20-alpha — pagehide handler needs the latest known nav identity,
  // but `lastNav` is closed-over inside watchSPANavigation(). We expose
  // it via the module-level mirror below; the SPA nav function pushes here.
  let _lastNavMirror = "";
  function lastNavForPagehide() { return _lastNavMirror; }

  init().catch((e) => {
    /* never throw out of a content script */
    if (chrome && chrome.runtime && chrome.runtime.lastError) {
      /* swallow */
    }
  });
})();
