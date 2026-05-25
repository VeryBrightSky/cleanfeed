/* CleanFeed — blockers.js
 *
 * Each blocker is a self-contained module with:
 *   id        — short stable identifier (matches popup toggle id)
 *   label     — human-readable name
 *   description — one-liner shown in popup tooltip
 *   tier      — "free" | "pro"
 *   selectors — array of CSS selectors that match the elements to hide
 *   pages     — optional array of YT page types where this applies
 *               (anything | home | watch | shorts | results | channel | trending)
 *
 * Hiding strategy is CSS-first: we toggle <body class="cf-block-{id}"> and a
 * <style> sheet (styles.css) maps that class to the selectors with display:none.
 *
 * Why CSS-first? It runs before any layout work happens — much faster than
 * removing DOM nodes after the fact, and YouTube's SPA can't "re-create"
 * something we've hidden via stylesheet.
 *
 * YouTube DOM is fragile — to keep these selectors working we prefer:
 *   • semantic tag names (ytd-*-renderer)
 *   • aria-label and title attributes (stable, user-facing)
 *   • page-subtype attributes
 * and AVOID hashed/random class names like .css-1a2b3c.
 */
(function () {
  "use strict";

  // shared on window to allow content.js to read
  const BLOCKERS = [
    {
      id: "home-feed",
      label: "Homepage feed",
      description: "Hides the endless recommendation grid on youtube.com",
      tier: "free",
      pages: ["home"],
      // The homepage's main grid:
      //   ytd-browse[page-subtype="home"] ytd-rich-grid-renderer
      // We also wipe the chip row that filters by topic on home.
      selectors: [
        'ytd-browse[page-subtype="home"] ytd-rich-grid-renderer',
        'ytd-browse[page-subtype="home"] #header.ytd-rich-grid-renderer',
        'ytd-browse[page-subtype="home"] #contents.ytd-rich-grid-renderer',
        'ytd-browse[page-subtype="home"] ytd-feed-filter-chip-bar-renderer',
      ],
    },
    {
      id: "shorts",
      label: "Shorts everywhere",
      description: "Hides Shorts shelves on the homepage, in search, and the Shorts left-nav entry",
      tier: "free",
      pages: ["anywhere"],
      selectors: [
        // Homepage / channel "Shorts" shelves
        "ytd-rich-shelf-renderer[is-shorts]",
        "ytd-reel-shelf-renderer",
        "ytd-reel-item-renderer",
        "ytd-shorts",
        "ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts])",
        // Left sidebar "Shorts" entries
        'ytd-guide-entry-renderer:has(a[title="Shorts"])',
        'ytd-mini-guide-entry-renderer:has(a[title="Shorts"])',
        'ytd-guide-entry-renderer:has(yt-formatted-string[title="Shorts"])',
        // Search results "Shorts" shelves
        'grid-shelf-view-model:has([title="Shorts"])',
        "ytd-reel-shelf-renderer",
        // Block direct /shorts/ navigation route — covered by content.js redirect
      ],
    },
    {
      id: "watch-sidebar",
      label: "Sidebar recommendations",
      description: "Hides the recommendations rail on the right of every watch page",
      tier: "pro",
      pages: ["watch"],
      selectors: [
        // Container that wraps related videos on a watch page
        "ytd-watch-flexy #secondary",
        "ytd-watch-flexy #secondary-inner",
        "ytd-watch-next-secondary-results-renderer",
        "#related.ytd-watch-flexy",
        "ytd-compact-video-renderer",
      ],
    },
    {
      id: "end-screen",
      label: "End-screen suggestions",
      description: "Hides those overlay cards that pop up in the last 20 seconds of every video",
      tier: "pro",
      pages: ["watch"],
      selectors: [
        // The end-screen cards (small clickable thumbnails)
        ".ytp-ce-element",
        ".ytp-ce-covering-overlay",
        ".ytp-ce-element-show",
        // The grid that takes over the player at video end
        ".ytp-endscreen-content",
        ".html5-endscreen",
        // "More videos" pause overlay
        ".ytp-pause-overlay",
        ".ytp-scroll-min.ytp-pause-overlay",
      ],
    },
    {
      id: "comments",
      label: "Comments section",
      description: "Hides comments on watch pages. A small button restores them on demand.",
      tier: "pro",
      pages: ["watch"],
      selectors: [
        "ytd-comments#comments",
        "#comments.ytd-watch-flexy",
        // Comments teaser counter at top
        "ytd-comments-header-renderer",
      ],
    },
    {
      id: "explore",
      label: "Trending / Explore tabs",
      description: "Hides Trending, Music, Gaming, News, Sports — the algorithm-driven Explore menu",
      tier: "pro",
      pages: ["anywhere"],
      selectors: [
        // Whole "Explore" section in the left guide
        'ytd-guide-section-renderer:has(#guide-section-title yt-formatted-string[title="Explore"])',
        // Or individual entries by title
        'ytd-guide-entry-renderer:has(a[title="Trending"])',
        'ytd-guide-entry-renderer:has(a[title="Music"])',
        'ytd-guide-entry-renderer:has(a[title="Gaming"])',
        'ytd-guide-entry-renderer:has(a[title="News"])',
        'ytd-guide-entry-renderer:has(a[title="Sports"])',
        'ytd-guide-entry-renderer:has(a[title="Learning"])',
        'ytd-guide-entry-renderer:has(a[title="Fashion & Beauty"])',
        // Mini-guide collapsed variant
        'ytd-mini-guide-entry-renderer:has(a[title="Trending"])',
      ],
    },
    {
      id: "live-chat",
      label: "Live chat",
      description: "Hides the live chat panel and replay-chat on streams",
      tier: "pro",
      pages: ["watch"],
      selectors: [
        // Top-level chat iframe + chat container
        "ytd-live-chat-frame",
        "#chat-container",
        "#chat.ytd-watch-flexy",
        // Replay chat (premiered videos) too
        "ytd-watch-flexy[is-two-columns_] #secondary-inner ytd-live-chat-frame",
      ],
    },
    {
      id: "autoplay",
      label: "Autoplay",
      description: "Automatically turns off autoplay on every video — the player won't queue the next clip",
      tier: "pro",
      pages: ["watch"],
      // Autoplay isn't really "hidden" — content.js detects the autoplay
      // toggle and clicks it OFF if it's on. We keep an empty selector list
      // so the CSS pass is a no-op; the JS handler in content.js does the work.
      selectors: [],
      jsHandler: "autoplay",   // marker for content.js
    },
    {
      id: "thumbnails",
      label: "Hide thumbnails",
      description: "Replaces every video thumbnail with a neutral placeholder. Hover to peek.",
      tier: "pro",
      pages: ["anywhere"],
      // Selectors targeted in styles.css under body.cf-block-thumbnails —
      // the image fades to opacity 0 and the parent's grey background shows.
      selectors: [
        "ytd-thumbnail img",
        "yt-image img",
        ".yt-thumbnail-view-model img",
      ],
    },
    {
      id: "subs-algo",
      label: "Hide subscription algorithm",
      description: "On /feed/subscriptions, hides 'For you' / 'Most relevant' shelves — only your chronological feed remains",
      tier: "pro",
      pages: ["subscriptions"],
      selectors: [
        // Algorithmic shelves on the subscriptions page
        'ytd-browse[page-subtype="subscriptions"] ytd-shelf-renderer',
        'ytd-browse[page-subtype="subscriptions"] ytd-rich-shelf-renderer',
        'ytd-browse[page-subtype="subscriptions"] ytd-rich-section-renderer',
      ],
    },
    // v1.4.0 — four new blockers (F5)
    {
      id: "playables",
      label: "Playables games panel",
      description: "Hides the games shelf YouTube shows in some regions",
      tier: "pro",
      pages: ["anywhere"],
      selectors: [
        // ytd-rich-shelf-renderer with header text "Playables"
        'ytd-rich-shelf-renderer:has(#title yt-formatted-string[title="Playables"])',
        'ytd-rich-shelf-renderer:has(#title yt-formatted-string[title="Mini-games"])',
        "ytd-playable-shelf-renderer",
      ],
    },
    {
      id: "merch-shelf",
      label: "Merch shelf",
      description: "Hides the merchandise shelves under videos",
      tier: "free",
      pages: ["watch"],
      selectors: [
        "ytd-merch-shelf-renderer",
        "yt-merch-shelf-renderer",
      ],
    },
    {
      id: "breaking-news",
      label: "Breaking news",
      description: "Hides the breaking-news shelf at the top of the homepage",
      tier: "free",
      pages: ["home"],
      selectors: [
        'ytd-rich-section-renderer:has(yt-formatted-string[title="Breaking news"])',
        'ytd-rich-section-renderer:has(yt-formatted-string[title="News"])',
        'ytd-rich-shelf-renderer:has(yt-formatted-string[title="Breaking news"])',
      ],
    },
    {
      id: "mixes-playlists",
      label: "Mixes & algorithmic playlists",
      description: "Hides 'Mix' radios and algorithmic playlist suggestions",
      tier: "pro",
      pages: ["anywhere"],
      selectors: [
        "ytd-radio-renderer",
        "ytd-compact-radio-renderer",
      ],
    },
    // v1.4.19 — three new Pro blockers for the Subscriptions feed.
    {
      id: "subs-most-relevant",
      label: "Hide 'Most Relevant' suggestions",
      description: "On /feed/subscriptions, removes the algorithmic 'Most Relevant' insertion",
      tier: "pro",
      pages: ["subscriptions"],
      selectors: [
        'ytd-browse[page-subtype="subscriptions"] ytd-rich-section-renderer:has(yt-formatted-string[title="Most Relevant"])',
        'ytd-browse[page-subtype="subscriptions"] ytd-rich-section-renderer:has(yt-formatted-string[title="For you"])',
        'ytd-browse[page-subtype="subscriptions"] ytd-rich-shelf-renderer:has(yt-formatted-string[title="Most Relevant"])',
        'ytd-browse[page-subtype="subscriptions"] ytd-rich-shelf-renderer:has(yt-formatted-string[title="For you"])',
      ],
    },
    {
      id: "subs-members-only",
      label: "Hide members-only videos",
      description: "Hides subscription videos with a 'members only' badge",
      tier: "pro",
      pages: ["anywhere"],
      selectors: [
        'ytd-rich-item-renderer:has(ytd-badge-supported-renderer[aria-label="Members only"])',
        'ytd-rich-item-renderer:has([aria-label*="Members only"])',
      ],
    },
    {
      id: "subs-watched",
      label: "Hide already-watched (progress > 95%)",
      description: "On /feed/subscriptions, hides videos whose progress bar is past 95%",
      tier: "pro",
      pages: ["subscriptions"],
      // Selectors are no-ops at the CSS layer — JS sweep (applyWatchedSweep
      // in content.js) tags qualifying cards with data-cf-watched="1" so the
      // CSS rule body.cf-block-subs-watched [data-cf-watched="1"] hides them.
      selectors: [
        'ytd-browse[page-subtype="subscriptions"] ytd-rich-item-renderer[data-cf-watched="1"]',
      ],
      jsHandler: "subs-watched",
    },
  ];

  // Free tier allows up to N blockers active simultaneously.
  const FREE_TIER_LIMIT = 2;

  // Expose to window so content.js can use it (we run as separate IIFEs
  // in the same content-script context, so sharing via window.* is fine).
  window.__cleanfeed_blockers = BLOCKERS;
  window.__cleanfeed_free_limit = FREE_TIER_LIMIT;
})();
