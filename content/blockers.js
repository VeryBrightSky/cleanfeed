/* CleanFeed — blockers.js
 *
 * Each blocker is a self-contained module with:
 *   id        — short stable identifier (matches popup toggle id)
 *   label     — human-readable name
 *   description — one-liner shown in popup tooltip
 *   tier      — "free" | "pro"
 *   selectors — derived getter: returns the active selector chain
 *               for this blocker. v1.5.0-phase1 sources this from
 *               window.__cleanfeed_selectors (content/selectors.js).
 *               Behaviour for the runtime counting pass is unchanged
 *               from v1.4.22: callers still iterate `b.selectors` and
 *               run document.querySelectorAll on each entry. What
 *               changes is the SOURCE of truth — selectors live in
 *               one file now, with primary+fallback shape ready for
 *               self-healing once health-log data surfaces YT churn.
 *   pages     — optional array of YT page types where this applies
 *               (anything | home | watch | shorts | results | channel | trending)
 *
 * Hiding strategy is still CSS-first via styles.css's body.cf-block-{id}
 * rules — this file just declares which blockers exist + their metadata.
 *
 * Selector-hygiene rules (preserved):
 *   • semantic tag names (ytd-*-renderer)
 *   • aria-label and title attributes (stable, user-facing)
 *   • page-subtype attributes
 * and AVOID hashed/random class names like .css-1a2b3c.
 */
(function () {
  "use strict";

  // v1.5.0-phase1 — selectors centralised in content/selectors.js. The
  // global is set by an earlier content-script load step. Defensive:
  // fall back to an empty object if selectors.js failed to load (e.g.
  // someone reordered manifest content_scripts), so we don't crash
  // every blocker at runtime.
  const SEL = (typeof window !== "undefined" && window.__cleanfeed_selectors) || {};

  // v1.5.0-phase1 — return the FLATTENED selector chain for a given
  // blocker (primary first, fallbacks concatenated after). The counting
  // pass in content.js iterates this array and treats each entry as a
  // querySelectorAll target; behaviour for the healthy YT-markup case is
  // identical to v1.4.22 since fallbacks are empty across all 17
  // blockers at v1.5.0-phase1. health-log.js's recordSelectorMiss fires
  // when EVERY selector across the whole chain yields zero hits.
  function selectorsFor(id) {
    const entry = SEL[id];
    if (!entry) return [];
    const out = (entry.primary || []).slice();
    if (Array.isArray(entry.fallbacks)) {
      for (const group of entry.fallbacks) {
        if (Array.isArray(group)) {
          for (const s of group) out.push(s);
        }
      }
    }
    return out;
  }

  // shared on window to allow content.js to read
  const BLOCKERS = [
    {
      id: "home-feed",
      label: "Homepage feed",
      description: "Hides the endless recommendation grid on youtube.com",
      tier: "free",
      pages: ["home"],
      get selectors() { return selectorsFor("home-feed"); },
    },
    {
      id: "shorts",
      label: "Shorts everywhere",
      description: "Hides Shorts shelves on the homepage, in search, and the Shorts left-nav entry",
      tier: "free",
      pages: ["anywhere"],
      get selectors() { return selectorsFor("shorts"); },
    },
    {
      id: "watch-sidebar",
      label: "Sidebar recommendations",
      description: "Hides the recommendations rail on the right of every watch page",
      tier: "pro",
      pages: ["watch"],
      get selectors() { return selectorsFor("watch-sidebar"); },
    },
    {
      id: "end-screen",
      label: "End-screen suggestions",
      description: "Hides those overlay cards that pop up in the last 20 seconds of every video",
      tier: "pro",
      pages: ["watch"],
      get selectors() { return selectorsFor("end-screen"); },
    },
    {
      id: "comments",
      label: "Comments section",
      description: "Hides comments on watch pages. A small button restores them on demand.",
      tier: "pro",
      pages: ["watch"],
      get selectors() { return selectorsFor("comments"); },
    },
    {
      id: "explore",
      label: "Trending / Explore tabs",
      description: "Hides Trending, Music, Gaming, News, Sports — the algorithm-driven Explore menu",
      tier: "pro",
      pages: ["anywhere"],
      get selectors() { return selectorsFor("explore"); },
    },
    {
      id: "live-chat",
      label: "Live chat",
      description: "Hides the live chat panel and replay-chat on streams",
      tier: "pro",
      pages: ["watch"],
      get selectors() { return selectorsFor("live-chat"); },
    },
    {
      id: "autoplay",
      label: "Autoplay",
      description: "Automatically turns off autoplay on every video — the player won't queue the next clip",
      tier: "pro",
      pages: ["watch"],
      get selectors() { return selectorsFor("autoplay"); },
      jsHandler: "autoplay",   // marker for content.js
    },
    {
      id: "thumbnails",
      label: "Hide thumbnails",
      description: "Replaces every video thumbnail with a neutral placeholder. Hover to peek.",
      tier: "pro",
      pages: ["anywhere"],
      get selectors() { return selectorsFor("thumbnails"); },
    },
    {
      id: "subs-algo",
      label: "Hide subscription algorithm",
      description: "On /feed/subscriptions, hides 'For you' / 'Most relevant' shelves — only your chronological feed remains",
      tier: "pro",
      pages: ["subscriptions"],
      get selectors() { return selectorsFor("subs-algo"); },
    },
    // v1.4.0 — four new blockers (F5)
    {
      id: "playables",
      label: "Playables games panel",
      description: "Hides the games shelf YouTube shows in some regions",
      tier: "pro",
      pages: ["anywhere"],
      get selectors() { return selectorsFor("playables"); },
    },
    {
      id: "merch-shelf",
      label: "Merch shelf",
      description: "Hides the merchandise shelves under videos",
      tier: "free",
      pages: ["watch"],
      get selectors() { return selectorsFor("merch-shelf"); },
    },
    {
      id: "breaking-news",
      label: "Breaking news",
      description: "Hides the breaking-news shelf at the top of the homepage",
      tier: "free",
      pages: ["home"],
      get selectors() { return selectorsFor("breaking-news"); },
    },
    {
      id: "mixes-playlists",
      label: "Mixes & algorithmic playlists",
      description: "Hides 'Mix' radios and algorithmic playlist suggestions",
      tier: "pro",
      pages: ["anywhere"],
      get selectors() { return selectorsFor("mixes-playlists"); },
    },
    // v1.4.19 — three new Pro blockers for the Subscriptions feed.
    {
      id: "subs-most-relevant",
      label: "Hide 'Most Relevant' suggestions",
      description: "On /feed/subscriptions, removes the algorithmic 'Most Relevant' insertion",
      tier: "pro",
      pages: ["subscriptions"],
      get selectors() { return selectorsFor("subs-most-relevant"); },
    },
    {
      id: "subs-members-only",
      label: "Hide members-only videos",
      description: "Hides subscription videos with a 'members only' badge",
      tier: "pro",
      pages: ["anywhere"],
      get selectors() { return selectorsFor("subs-members-only"); },
    },
    {
      id: "subs-watched",
      label: "Hide already-watched (progress > 95%)",
      description: "On /feed/subscriptions, hides videos whose progress bar is past 95%",
      tier: "pro",
      pages: ["subscriptions"],
      get selectors() { return selectorsFor("subs-watched"); },
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
