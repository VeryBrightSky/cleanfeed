/* CleanFeed v1.5.0-phase1 — centralised selector chains with fallback layers.
 *
 * Single source of truth for every DOM selector used by every blocker.
 * Shape: SELECTORS[blockerId] = { primary: [...], fallbacks: [[...], [...]] }
 *
 * - `primary` holds the CURRENT selectors, byte-identical to what was inlined
 *   in `content/blockers.js` through v1.4.22. The healthy-path CSS rules in
 *   `content/styles.css` still drive hiding via `body.cf-block-{id}`; this
 *   file is what the runtime queries to count matches + decide whether to
 *   fall through to alternates.
 *
 * - `fallbacks` is an ordered list of alternate selector groups, tried in
 *   priority order when ALL primary selectors yield zero matches on a given
 *   YouTube page. Empty at v1.5.0-phase1 — they get populated as
 *   `content/health-log.js` surfaces misses from real-Chrome installs.
 *
 * - The CSS layer (`content/styles.css`) keeps applying `primary` rules
 *   unconditionally so behaviour is unchanged when YT serves the markup
 *   we expect. The fallback machinery only kicks in for the
 *   counting/diagnostic pass — it does NOT (yet) inject CSS for fallback
 *   selectors. That's a Phase X follow-up once we know which fallbacks
 *   actually pay off.
 *
 * Selector-hygiene rules (preserved from blockers.js header comment):
 *   - prefer semantic tag names (ytd-*-renderer)
 *   - prefer aria-label / title attributes
 *   - prefer page-subtype attributes
 *   - AVOID hashed/random class names like .css-1a2b3c
 *
 * Exposed as `window.__cleanfeed_selectors`. content/manifest.json loads
 * this file BEFORE blockers.js so the global is in place by the time
 * blockers.js dereferences it.
 */
(function () {
  "use strict";

  const SELECTORS = {
    "home-feed": {
      primary: [
        'ytd-browse[page-subtype="home"] ytd-rich-grid-renderer',
        'ytd-browse[page-subtype="home"] #header.ytd-rich-grid-renderer',
        'ytd-browse[page-subtype="home"] #contents.ytd-rich-grid-renderer',
        'ytd-browse[page-subtype="home"] ytd-feed-filter-chip-bar-renderer',
      ],
      fallbacks: [],
    },
    "shorts": {
      primary: [
        "ytd-rich-shelf-renderer[is-shorts]",
        "ytd-reel-shelf-renderer",
        "ytd-reel-item-renderer",
        "ytd-shorts",
        "ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts])",
        'ytd-guide-entry-renderer:has(a[title="Shorts"])',
        'ytd-mini-guide-entry-renderer:has(a[title="Shorts"])',
        'ytd-guide-entry-renderer:has(yt-formatted-string[title="Shorts"])',
        'grid-shelf-view-model:has([title="Shorts"])',
        "ytd-reel-shelf-renderer",
      ],
      fallbacks: [],
    },
    "watch-sidebar": {
      primary: [
        "ytd-watch-flexy #secondary",
        "ytd-watch-flexy #secondary-inner",
        "ytd-watch-next-secondary-results-renderer",
        "#related.ytd-watch-flexy",
        "ytd-compact-video-renderer",
      ],
      fallbacks: [],
    },
    "end-screen": {
      primary: [
        ".ytp-ce-element",
        ".ytp-ce-covering-overlay",
        ".ytp-ce-element-show",
        ".ytp-endscreen-content",
        ".html5-endscreen",
        ".ytp-pause-overlay",
        ".ytp-scroll-min.ytp-pause-overlay",
      ],
      fallbacks: [],
    },
    "comments": {
      primary: [
        "ytd-comments#comments",
        "#comments.ytd-watch-flexy",
        "ytd-comments-header-renderer",
      ],
      fallbacks: [],
    },
    "explore": {
      primary: [
        'ytd-guide-section-renderer:has(#guide-section-title yt-formatted-string[title="Explore"])',
        'ytd-guide-entry-renderer:has(a[title="Trending"])',
        'ytd-guide-entry-renderer:has(a[title="Music"])',
        'ytd-guide-entry-renderer:has(a[title="Gaming"])',
        'ytd-guide-entry-renderer:has(a[title="News"])',
        'ytd-guide-entry-renderer:has(a[title="Sports"])',
        'ytd-guide-entry-renderer:has(a[title="Learning"])',
        'ytd-guide-entry-renderer:has(a[title="Fashion & Beauty"])',
        'ytd-mini-guide-entry-renderer:has(a[title="Trending"])',
      ],
      fallbacks: [],
    },
    "live-chat": {
      primary: [
        "ytd-live-chat-frame",
        "#chat-container",
        "#chat.ytd-watch-flexy",
        "ytd-watch-flexy[is-two-columns_] #secondary-inner ytd-live-chat-frame",
      ],
      fallbacks: [],
    },
    "autoplay": {
      // Pure JS handler; no CSS selectors. Keep an empty primary so the
      // health-log treats this blocker as "no DOM presence required" and
      // never records a miss for it.
      primary: [],
      fallbacks: [],
      jsHandler: "autoplay",
    },
    "thumbnails": {
      primary: [
        "ytd-thumbnail img",
        "yt-image img",
        ".yt-thumbnail-view-model img",
      ],
      fallbacks: [],
    },
    "subs-algo": {
      primary: [
        'ytd-browse[page-subtype="subscriptions"] ytd-shelf-renderer',
        'ytd-browse[page-subtype="subscriptions"] ytd-rich-shelf-renderer',
        'ytd-browse[page-subtype="subscriptions"] ytd-rich-section-renderer',
      ],
      fallbacks: [],
    },
    "playables": {
      primary: [
        'ytd-rich-shelf-renderer:has(#title yt-formatted-string[title="Playables"])',
        'ytd-rich-shelf-renderer:has(#title yt-formatted-string[title="Mini-games"])',
        "ytd-playable-shelf-renderer",
      ],
      fallbacks: [],
    },
    "merch-shelf": {
      primary: [
        "ytd-merch-shelf-renderer",
        "yt-merch-shelf-renderer",
      ],
      fallbacks: [],
    },
    "breaking-news": {
      primary: [
        'ytd-rich-section-renderer:has(yt-formatted-string[title="Breaking news"])',
        'ytd-rich-section-renderer:has(yt-formatted-string[title="News"])',
        'ytd-rich-shelf-renderer:has(yt-formatted-string[title="Breaking news"])',
      ],
      fallbacks: [],
    },
    "mixes-playlists": {
      primary: [
        "ytd-radio-renderer",
        "ytd-compact-radio-renderer",
      ],
      fallbacks: [],
    },
    "subs-most-relevant": {
      primary: [
        'ytd-browse[page-subtype="subscriptions"] ytd-rich-section-renderer:has(yt-formatted-string[title="Most Relevant"])',
        'ytd-browse[page-subtype="subscriptions"] ytd-rich-section-renderer:has(yt-formatted-string[title="For you"])',
        'ytd-browse[page-subtype="subscriptions"] ytd-rich-shelf-renderer:has(yt-formatted-string[title="Most Relevant"])',
        'ytd-browse[page-subtype="subscriptions"] ytd-rich-shelf-renderer:has(yt-formatted-string[title="For you"])',
      ],
      fallbacks: [],
    },
    "subs-members-only": {
      primary: [
        'ytd-rich-item-renderer:has(ytd-badge-supported-renderer[aria-label="Members only"])',
        'ytd-rich-item-renderer:has([aria-label*="Members only"])',
      ],
      fallbacks: [],
    },
    "subs-watched": {
      primary: [
        'ytd-browse[page-subtype="subscriptions"] ytd-rich-item-renderer[data-cf-watched="1"]',
      ],
      fallbacks: [],
      jsHandler: "subs-watched",
    },
  };

  window.__cleanfeed_selectors = SELECTORS;
})();
