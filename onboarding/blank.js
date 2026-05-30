/* CleanFeed v1.5.0 phase 2 — blank.html behaviour.
 *
 * Pure local: no analytics, no storage of the typed intent (the input is
 * a self-prompt only — it disappears when the tab navigates or closes).
 *
 * Continue to YouTube: sets a one-shot bypass flag
 * (chrome.storage.local.cf_skip_next_homepage_redirect = true) so the
 * content script doesn't immediately redirect back to /blank.html, then
 * navigates to youtube.com.
 *
 * Close tab: window.close() — browsers honour this for tabs the
 * extension opened (which is the case here since the tab arrived via
 * content.js's location.replace).
 */
"use strict";

(function () {
  const $ = (id) => document.getElementById(id);

  function continueToYouTube() {
    const url = "https://www.youtube.com/";
    try {
      // Set the bypass flag, then navigate when the storage write settles.
      // Using set() with a callback so the navigation happens after the
      // content script on youtube.com will be able to read the new value.
      chrome.storage.local.set({ cf_skip_next_homepage_redirect: true }, () => {
        // Best-effort: navigate even if the set() callback never fires.
        window.location.href = url;
      });
      // Safety: if storage.set hangs more than 300ms, navigate anyway —
      // the user clicked Continue, we owe them the next page.
      setTimeout(() => { try { window.location.href = url; } catch (_) {} }, 300);
    } catch (_) {
      // chrome.storage unavailable (sandbox?) — fall back to a hash-flagged
      // URL so the content script can still detect the bypass.
      try { window.location.href = url + "?cf_bypass=1"; } catch (__) {}
    }
  }

  function closeTab() {
    try { window.close(); } catch (_) {}
  }

  document.addEventListener("DOMContentLoaded", () => {
    const cont = $("cf-blank-continue");
    const close = $("cf-blank-close");
    const intent = $("cf-blank-intent");
    if (cont) cont.addEventListener("click", continueToYouTube);
    if (close) close.addEventListener("click", closeTab);
    // Enter inside the intent field also continues (most users will type
    // an intent and hit Enter rather than clicking).
    if (intent) intent.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); continueToYouTube(); }
    });
  });
})();
