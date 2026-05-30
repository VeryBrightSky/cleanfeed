/* CleanFeed v1.5.0-phase1 — local selector health log.
 *
 * Purpose: when a user reports "blocker X stopped working," they need a
 * copy-pasteable diagnostic blob (no analytics, no telemetry, no network)
 * to attach to a GitHub issue. This module is the in-page recorder; the
 * options page exposes the export.
 *
 * Storage shape:
 *   chrome.storage.local.cf_health_log = [
 *     { kind: "miss",  blockerId, ts, url, ua_short },
 *     { kind: "match", blockerId, ts, url, ua_short, selectorIndex, matchCount },
 *     ...
 *   ]
 * Ring buffer, MAX_ENTRIES (50) entries, oldest evicted on overflow.
 *
 * Throttle: recordSelectorMiss for a given blockerId fires AT MOST once
 * per `markPageNav()` invocation (i.e. once per YT page navigation). The
 * counting pass in content.js calls applyBlockers many times per second
 * via MutationObserver; without throttling, a single broken selector
 * would burn through the ring buffer in seconds and evict useful older
 * entries.
 *
 * recordSelectorMatch is unthrottled by intent — match counts are mainly
 * useful for "is this blocker even firing?" sanity checks and we want
 * the most recent state visible at any time. But to keep ring-buffer
 * pressure low, only the FIRST match for a given (blockerId, page-nav)
 * is persisted; subsequent matches in the same page-nav are no-ops.
 *
 * Exposed as window.__cleanfeed_healthlog.
 */
(function () {
  "use strict";

  const STORAGE_KEY = "cf_health_log";
  const MAX_ENTRIES = 50;
  // Per-page-nav dedupe sets so we don't flood the log with the same
  // blockerId every tick. Reset by markPageNav() on yt-navigate-finish.
  let _missedThisNav = new Set();
  let _matchedThisNav = new Set();

  // Short UA fingerprint — enough to disambiguate "Chrome 122 on Linux"
  // from "Chrome 110 on Windows" without leaking the full user-agent
  // string (which contains identifying bits like exact patch numbers).
  function _shortUA() {
    try {
      const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
      // Extract "Chrome/MAJOR" and platform hint.
      const m = ua.match(/Chrome\/(\d+)/);
      const major = m ? m[1] : "?";
      let platform = "?";
      if (/Windows/.test(ua))      platform = "Win";
      else if (/Macintosh/.test(ua)) platform = "Mac";
      else if (/Linux/.test(ua))     platform = "Linux";
      else if (/Android/.test(ua))   platform = "Android";
      return `Chrome ${major} ${platform}`;
    } catch (_) { return "?"; }
  }
  function _normalizedUrl() {
    try {
      // Strip query strings + hash to avoid logging video IDs / tokens.
      const u = new URL(typeof location !== "undefined" ? location.href : "");
      return u.origin + u.pathname;
    } catch (_) { return ""; }
  }

  function _read() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([STORAGE_KEY], (d) => {
          resolve((d && Array.isArray(d[STORAGE_KEY])) ? d[STORAGE_KEY] : []);
        });
      } catch (_) { resolve([]); }
    });
  }
  function _write(arr) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [STORAGE_KEY]: arr }, () => resolve());
      } catch (_) { resolve(); }
    });
  }

  // v1.5.0-phase1 — serialize pushes through a promise chain. Without
  // this, rapid recordSelectorMiss/Match calls during a single
  // applyBlockers tick (17 blockers × N selectors) interleave read/write
  // and lose entries to last-writer-wins. The chain costs ~10ms per
  // entry under load, which is fine — the API is throttled to
  // once-per-page-nav per blocker anyway, so peak load is bounded.
  let _writeChain = Promise.resolve();
  function _push(entry) {
    _writeChain = _writeChain.then(async () => {
      const existing = await _read();
      const next = existing.slice();
      next.push(entry);
      while (next.length > MAX_ENTRIES) next.shift();
      await _write(next);
    }).catch(() => { /* never let one bad push poison the chain */ });
  }

  function recordSelectorMatch(blockerId, selectorIndex, matchCount) {
    if (!blockerId) return;
    if (_matchedThisNav.has(blockerId)) return;     // first-match-per-nav only
    _matchedThisNav.add(blockerId);
    _push({
      kind: "match",
      blockerId: String(blockerId),
      ts: Date.now(),
      url: _normalizedUrl(),
      ua_short: _shortUA(),
      selectorIndex: Number(selectorIndex) | 0,
      matchCount: Number(matchCount) | 0,
    });
  }

  function recordSelectorMiss(blockerId) {
    if (!blockerId) return;
    if (_missedThisNav.has(blockerId)) return;       // once per nav
    _missedThisNav.add(blockerId);
    _push({
      kind: "miss",
      blockerId: String(blockerId),
      ts: Date.now(),
      url: _normalizedUrl(),
      ua_short: _shortUA(),
    });
  }

  // Called from content.js on yt-navigate-finish (and on initial load) so
  // the dedupe sets reset for a fresh page. Without this every nav would
  // accumulate state and we'd never re-record matches/misses across nav.
  function markPageNav() {
    _missedThisNav = new Set();
    _matchedThisNav = new Set();
  }

  // Async — returns a Promise<string> of the JSON-pretty serialised log
  // for copy-paste into a bug report. Used by options.js Diagnostic info.
  async function exportLog() {
    const arr = await _read();
    return JSON.stringify(arr, null, 2);
  }

  function clearLog() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.remove([STORAGE_KEY], () => {
          _missedThisNav = new Set();
          _matchedThisNav = new Set();
          resolve();
        });
      } catch (_) { resolve(); }
    });
  }

  window.__cleanfeed_healthlog = {
    recordSelectorMatch: recordSelectorMatch,
    recordSelectorMiss: recordSelectorMiss,
    markPageNav: markPageNav,
    exportLog: exportLog,
    clearLog: clearLog,
    _STORAGE_KEY: STORAGE_KEY,
    _MAX_ENTRIES: MAX_ENTRIES,
  };
})();
