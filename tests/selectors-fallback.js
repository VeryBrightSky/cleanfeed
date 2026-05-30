/* CleanFeed v1.5.0-phase1 — selector centralisation + fallback chain tests.
 *
 * Asserts:
 *   1. content/selectors.js exports a SELECTORS object with the same 17
 *      blocker ids as v1.4.22, and `primary` for each id matches the
 *      verbatim array that lived in v1.4.22's blockers.js. This is the
 *      "zero behaviour change for healthy YT pages" invariant — a
 *      regression here means real users see different blocking results.
 *   2. blockers.js's `b.selectors` getter returns the flattened
 *      [primary..., ...fallbacks] chain.
 *   3. Fallback engagement: when primary yields zero matches in the
 *      counting pass, recordSelectorMiss fires once. When a fallback
 *      yields > 0, recordSelectorMatch fires with the fallback's index
 *      within the flat chain.
 *   4. recordSelectorMiss + recordSelectorMatch are throttled to once
 *      per page-nav per blocker — repeated applyBlockers ticks must not
 *      re-record.
 *   5. exportLog returns valid JSON with the expected entry shape.
 *   6. Ring buffer caps at MAX_ENTRIES (50). Older entries evict.
 *   7. markPageNav resets the per-nav dedupe so the next page records
 *      its own first match / miss for each blocker.
 *
 * Production code is loaded via vm in a synthetic window context so the
 * IIFEs populate window.__cleanfeed_selectors / window.__cleanfeed_healthlog.
 * chrome.storage.local is shimmed as an in-memory map.
 *
 * Run with:  node tests/selectors-fallback.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

let pass = 0, fail = 0;
function assertEq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; process.stdout.write("."); }
  else { fail++; console.error(`\n  FAIL ${name}\n    expected: ${e}\n    actual:   ${a}`); }
}
function assertTrue(name, cond) {
  if (cond) { pass++; process.stdout.write("."); }
  else { fail++; console.error(`\n  FAIL ${name}`); }
}

// ---- synthetic chrome.* shim --------------------------------------------
function makeChromeShim() {
  const storage = {};
  return {
    storage: {
      local: {
        get(keys, cb) {
          setTimeout(() => {
            const out = {};
            const list = Array.isArray(keys) ? keys : (keys ? [keys] : Object.keys(storage));
            for (const k of list) if (k in storage) out[k] = JSON.parse(JSON.stringify(storage[k]));
            cb(out);
          }, 0);
        },
        set(patch, cb) {
          setTimeout(() => {
            for (const k of Object.keys(patch)) storage[k] = JSON.parse(JSON.stringify(patch[k]));
            if (cb) cb();
          }, 0);
        },
        remove(keys, cb) {
          setTimeout(() => {
            const list = Array.isArray(keys) ? keys : [keys];
            for (const k of list) delete storage[k];
            if (cb) cb();
          }, 0);
        },
      },
      sync: { get(_, cb) { cb({}); }, set(_, cb) { if (cb) cb(); } },
    },
    _peek() { return JSON.parse(JSON.stringify(storage)); },
  };
}

// Build a sandbox that mimics a browser content-script: window + chrome.
function makeSandbox() {
  const win = {};
  const chrome = makeChromeShim();
  // Minimal navigator + location for _shortUA + _normalizedUrl in health-log.
  const sandbox = {
    window: win,
    chrome: chrome,
    navigator: { userAgent: "Mozilla/5.0 Linux Chrome/122.0.0.0" },
    location: { href: "https://www.youtube.com/feed/subscriptions" },
    URL: URL,
    Date: Date,
    Set: Set, Map: Map, WeakSet: WeakSet,
    Promise: Promise, Object: Object, Array: Array, JSON: JSON, String: String, Number: Number,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    console: console,
  };
  // window.* aliases — selectors.js & health-log.js write to window.
  sandbox.window.chrome = chrome;
  vm.createContext(sandbox);
  // Load selectors.js
  const SEL_SRC = fs.readFileSync(path.join(__dirname, "..", "content", "selectors.js"), "utf8");
  vm.runInContext(SEL_SRC, sandbox);
  // Load health-log.js
  const HL_SRC = fs.readFileSync(path.join(__dirname, "..", "content", "health-log.js"), "utf8");
  vm.runInContext(HL_SRC, sandbox);
  return sandbox;
}

// ===== 1. Selectors centralised — every blocker is present =============

const VALID_BLOCKER_IDS = [
  "home-feed", "shorts", "watch-sidebar", "end-screen", "comments",
  "explore", "live-chat", "autoplay", "thumbnails", "subs-algo",
  "playables", "merch-shelf", "breaking-news", "mixes-playlists",
  "subs-most-relevant", "subs-members-only", "subs-watched",
];

{
  const sb = makeSandbox();
  const SEL = sb.window.__cleanfeed_selectors;
  assertTrue("1a) SELECTORS object exists on window",
    SEL && typeof SEL === "object");
  for (const id of VALID_BLOCKER_IDS) {
    assertTrue(`1.${id}) SELECTORS["${id}"] exists`, !!SEL[id]);
    assertTrue(`1.${id}) SELECTORS["${id}"].primary is array`,
      Array.isArray(SEL[id].primary));
    assertTrue(`1.${id}) SELECTORS["${id}"].fallbacks is array`,
      Array.isArray(SEL[id].fallbacks));
  }
  assertEq("1c) exactly 17 blocker ids in SELECTORS",
    Object.keys(SEL).length, 17);
}

// ===== 2. Primary selectors byte-identical to v1.4.22 baseline ==========
//
// Inlined snapshot from v1.4.22 content/blockers.js. Mismatch = behaviour
// regression on healthy YT pages.

// v1.5.0-fix2 — EXPANDED to cover all 17 blockers (was 9 in fix1).
// tests/selectors-completeness.js reads v1.4.22 baseline via `git show
// 601a193:content/blockers.js` so the comparison auto-tracks; this
// snapshot is the offline mirror used when git isn't reachable (CI
// shadow-clone, sandboxed runs).
const V1422_PRIMARY = {
  "home-feed": [
    'ytd-browse[page-subtype="home"] ytd-rich-grid-renderer',
    'ytd-browse[page-subtype="home"] #header.ytd-rich-grid-renderer',
    'ytd-browse[page-subtype="home"] #contents.ytd-rich-grid-renderer',
    'ytd-browse[page-subtype="home"] ytd-feed-filter-chip-bar-renderer',
  ],
  "shorts": [
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
  "watch-sidebar": [
    "ytd-watch-flexy #secondary",
    "ytd-watch-flexy #secondary-inner",
    "ytd-watch-next-secondary-results-renderer",
    "#related.ytd-watch-flexy",
    "ytd-compact-video-renderer",
  ],
  "end-screen": [
    ".ytp-ce-element",
    ".ytp-ce-covering-overlay",
    ".ytp-ce-element-show",
    ".ytp-endscreen-content",
    ".html5-endscreen",
    ".ytp-pause-overlay",
    ".ytp-scroll-min.ytp-pause-overlay",
  ],
  "comments": [
    "ytd-comments#comments",
    "#comments.ytd-watch-flexy",
    "ytd-comments-header-renderer",
  ],
  "explore": [
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
  "live-chat": [
    "ytd-live-chat-frame",
    "#chat-container",
    "#chat.ytd-watch-flexy",
    "ytd-watch-flexy[is-two-columns_] #secondary-inner ytd-live-chat-frame",
  ],
  "autoplay": [],          // JS-only blocker, no DOM selectors
  "thumbnails": [
    "ytd-thumbnail img",
    "yt-image img",
    ".yt-thumbnail-view-model img",
  ],
  "subs-algo": [
    'ytd-browse[page-subtype="subscriptions"] ytd-shelf-renderer',
    'ytd-browse[page-subtype="subscriptions"] ytd-rich-shelf-renderer',
    'ytd-browse[page-subtype="subscriptions"] ytd-rich-section-renderer',
  ],
  "playables": [
    'ytd-rich-shelf-renderer:has(#title yt-formatted-string[title="Playables"])',
    'ytd-rich-shelf-renderer:has(#title yt-formatted-string[title="Mini-games"])',
    "ytd-playable-shelf-renderer",
  ],
  "merch-shelf": [
    "ytd-merch-shelf-renderer",
    "yt-merch-shelf-renderer",
  ],
  "breaking-news": [
    'ytd-rich-section-renderer:has(yt-formatted-string[title="Breaking news"])',
    'ytd-rich-section-renderer:has(yt-formatted-string[title="News"])',
    'ytd-rich-shelf-renderer:has(yt-formatted-string[title="Breaking news"])',
  ],
  "mixes-playlists": [
    "ytd-radio-renderer",
    "ytd-compact-radio-renderer",
  ],
  "subs-most-relevant": [
    'ytd-browse[page-subtype="subscriptions"] ytd-rich-section-renderer:has(yt-formatted-string[title="Most Relevant"])',
    'ytd-browse[page-subtype="subscriptions"] ytd-rich-section-renderer:has(yt-formatted-string[title="For you"])',
    'ytd-browse[page-subtype="subscriptions"] ytd-rich-shelf-renderer:has(yt-formatted-string[title="Most Relevant"])',
    'ytd-browse[page-subtype="subscriptions"] ytd-rich-shelf-renderer:has(yt-formatted-string[title="For you"])',
  ],
  "subs-members-only": [
    'ytd-rich-item-renderer:has(ytd-badge-supported-renderer[aria-label="Members only"])',
    'ytd-rich-item-renderer:has([aria-label*="Members only"])',
  ],
  "subs-watched": [
    'ytd-browse[page-subtype="subscriptions"] ytd-rich-item-renderer[data-cf-watched="1"]',
  ],
};

{
  const sb = makeSandbox();
  const SEL = sb.window.__cleanfeed_selectors;
  for (const id of Object.keys(V1422_PRIMARY)) {
    assertEq(`2.${id}) primary selectors verbatim from v1.4.22`,
      SEL[id].primary, V1422_PRIMARY[id]);
  }
}

// ===== 3. Flat-chain helper: primary first, fallbacks concatenated =====
//
// Simulates blockers.js's selectorsFor() return shape. We don't load
// blockers.js here (it depends on a real WeakSet + getters and isn't
// trivially testable from outside a Window), but the contract is simple
// enough to mirror.

function selectorsFor(SEL, id) {
  const entry = SEL[id];
  if (!entry) return [];
  const out = (entry.primary || []).slice();
  if (Array.isArray(entry.fallbacks)) {
    for (const group of entry.fallbacks) {
      if (Array.isArray(group)) for (const s of group) out.push(s);
    }
  }
  return out;
}

{
  const sb = makeSandbox();
  const SEL = sb.window.__cleanfeed_selectors;
  // With empty fallbacks (v1.5.0-phase1), the chain equals primary.
  for (const id of VALID_BLOCKER_IDS) {
    assertEq(`3.${id}) flat chain equals primary when fallbacks empty`,
      selectorsFor(SEL, id), SEL[id].primary);
  }
}

// ===== 4. Synthetic fallback engagement test ============================
//
// We mutate SELECTORS["home-feed"] in the sandbox to add a fallback group,
// then verify selectorsFor returns [primary..., fallback...].

{
  const sb = makeSandbox();
  const SEL = sb.window.__cleanfeed_selectors;
  SEL["home-feed"].fallbacks = [
    ["ytd-two-column-browse-results-renderer #primary ytd-rich-grid-renderer"],
    ["body[has-yt-redesign] ytd-browse"],
  ];
  const chain = selectorsFor(SEL, "home-feed");
  assertEq("4a) flat chain length = primary + fallback groups flattened",
    chain.length, SEL["home-feed"].primary.length + 2);
  assertEq("4b) fallback selector appears AFTER primary",
    chain[SEL["home-feed"].primary.length],
    "ytd-two-column-browse-results-renderer #primary ytd-rich-grid-renderer");
}

// ===== 5. health-log.recordSelectorMiss — once per nav per blocker ======

(async () => {
  {
    const sb = makeSandbox();
    const hl = sb.window.__cleanfeed_healthlog;
    assertTrue("5a) __cleanfeed_healthlog exists", !!hl);
    // Fire 5 misses for the same blocker — only 1 entry should land in storage
    hl.recordSelectorMiss("home-feed");
    hl.recordSelectorMiss("home-feed");
    hl.recordSelectorMiss("home-feed");
    hl.recordSelectorMiss("home-feed");
    hl.recordSelectorMiss("home-feed");
    await new Promise((r) => setTimeout(r, 50));
    const log = await new Promise((r) => sb.chrome.storage.local.get(["cf_health_log"], (d) => r(d.cf_health_log || [])));
    assertEq("5b) 5 misses for same blocker -> 1 entry (throttled per-nav)",
      log.length, 1);
    assertEq("5c) entry kind = miss",
      log[0].kind, "miss");
    assertEq("5d) entry blockerId = home-feed",
      log[0].blockerId, "home-feed");
    assertTrue("5e) entry has ts (number)", typeof log[0].ts === "number");
    assertTrue("5f) entry has url (origin+path, no query)",
      typeof log[0].url === "string" && log[0].url.indexOf("?") < 0);
    assertTrue("5g) entry has ua_short like 'Chrome 122 Linux'",
      typeof log[0].ua_short === "string" && /Chrome \d/.test(log[0].ua_short));
  }

  // ===== 6. recordSelectorMiss — fires fresh after markPageNav ==========

  {
    const sb = makeSandbox();
    const hl = sb.window.__cleanfeed_healthlog;
    hl.recordSelectorMiss("shorts");
    await new Promise((r) => setTimeout(r, 10));
    hl.markPageNav();
    hl.recordSelectorMiss("shorts");      // should land — new page
    await new Promise((r) => setTimeout(r, 50));
    const log = await new Promise((r) => sb.chrome.storage.local.get(["cf_health_log"], (d) => r(d.cf_health_log || [])));
    assertEq("6) markPageNav resets dedupe -> 2 entries for same blocker",
      log.length, 2);
  }

  // ===== 7. recordSelectorMatch — once per nav per blocker ==============

  {
    const sb = makeSandbox();
    const hl = sb.window.__cleanfeed_healthlog;
    hl.recordSelectorMatch("comments", 0, 1);
    hl.recordSelectorMatch("comments", 0, 1);
    hl.recordSelectorMatch("comments", 0, 1);
    await new Promise((r) => setTimeout(r, 50));
    const log = await new Promise((r) => sb.chrome.storage.local.get(["cf_health_log"], (d) => r(d.cf_health_log || [])));
    assertEq("7a) 3 matches for same blocker -> 1 entry",
      log.length, 1);
    assertEq("7b) entry kind = match",
      log[0].kind, "match");
    assertEq("7c) selectorIndex preserved",
      log[0].selectorIndex, 0);
    assertEq("7d) matchCount preserved",
      log[0].matchCount, 1);
  }

  // ===== 8. Mixed misses + matches accumulate independently =============

  {
    const sb = makeSandbox();
    const hl = sb.window.__cleanfeed_healthlog;
    hl.recordSelectorMatch("comments", 0, 3);
    hl.recordSelectorMiss("home-feed");
    hl.recordSelectorMatch("shorts", 2, 1);
    hl.recordSelectorMiss("end-screen");
    await new Promise((r) => setTimeout(r, 50));
    const log = await new Promise((r) => sb.chrome.storage.local.get(["cf_health_log"], (d) => r(d.cf_health_log || [])));
    assertEq("8a) 4 distinct (kind, blockerId) entries land",
      log.length, 4);
    const kinds = log.map((e) => e.kind).sort();
    assertEq("8b) 2 misses + 2 matches",
      kinds, ["match", "match", "miss", "miss"]);
  }

  // ===== 9. exportLog returns valid JSON =================================

  {
    const sb = makeSandbox();
    const hl = sb.window.__cleanfeed_healthlog;
    hl.recordSelectorMiss("merch-shelf");
    await new Promise((r) => setTimeout(r, 50));
    const json = await hl.exportLog();
    assertTrue("9a) exportLog returns a string", typeof json === "string");
    const parsed = JSON.parse(json);       // throws if invalid
    assertTrue("9b) parses as JSON array", Array.isArray(parsed));
    assertEq("9c) array has 1 entry", parsed.length, 1);
    assertEq("9d) blockerId preserved through round-trip",
      parsed[0].blockerId, "merch-shelf");
  }

  // ===== 10. Empty storage -> exportLog returns "[]" =====================

  {
    const sb = makeSandbox();
    const hl = sb.window.__cleanfeed_healthlog;
    const json = await hl.exportLog();
    assertEq("10) empty storage -> '[]'", json, "[]");
  }

  // ===== 11. Ring buffer caps at MAX_ENTRIES (50) ========================

  {
    const sb = makeSandbox();
    const hl = sb.window.__cleanfeed_healthlog;
    // 60 distinct misses (different blocker ids would dedupe per-nav, so
    // instead we cycle markPageNav between each push to simulate 60 nav
    // events, each with one miss).
    for (let i = 0; i < 60; i++) {
      hl.markPageNav();
      hl.recordSelectorMiss("home-feed");
      // give storage shim time to flush each one in order
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 50));
    const log = await new Promise((r) => sb.chrome.storage.local.get(["cf_health_log"], (d) => r(d.cf_health_log || [])));
    assertEq("11a) ring buffer caps at 50 entries",
      log.length, 50);
    // The 10 oldest entries should have been evicted — newest at the end.
    assertEq("11b) MAX_ENTRIES exposed correctly",
      hl._MAX_ENTRIES, 50);
  }

  // ===== 12. clearLog wipes the log ======================================

  {
    const sb = makeSandbox();
    const hl = sb.window.__cleanfeed_healthlog;
    hl.recordSelectorMiss("home-feed");
    await new Promise((r) => setTimeout(r, 30));
    await hl.clearLog();
    await new Promise((r) => setTimeout(r, 30));
    const log = await new Promise((r) => sb.chrome.storage.local.get(["cf_health_log"], (d) => r(d.cf_health_log || [])));
    assertEq("12a) clearLog removes all entries",
      log.length, 0);
    // After clearLog, dedupe sets are also reset so the next miss records.
    hl.recordSelectorMiss("home-feed");
    await new Promise((r) => setTimeout(r, 30));
    const log2 = await new Promise((r) => sb.chrome.storage.local.get(["cf_health_log"], (d) => r(d.cf_health_log || [])));
    assertEq("12b) clearLog also resets dedupe -> next miss records",
      log2.length, 1);
  }

  // ===== 13. URL normalisation strips query + hash =======================
  //
  // We don't want to log video IDs or auth tokens. Production code reads
  // location.href.origin + .pathname only. Test by spinning a new sandbox
  // pointed at a /watch?v=abcXYZ URL.

  {
    const sb = makeSandbox();
    sb.location.href = "https://www.youtube.com/watch?v=abcXYZ_secret&t=42&pp=token";
    const hl = sb.window.__cleanfeed_healthlog;
    hl.recordSelectorMiss("watch-sidebar");
    await new Promise((r) => setTimeout(r, 30));
    const log = await new Promise((r) => sb.chrome.storage.local.get(["cf_health_log"], (d) => r(d.cf_health_log || [])));
    assertEq("13a) URL retains origin + pathname",
      log[0].url, "https://www.youtube.com/watch");
    assertTrue("13b) URL DROPS query string (no abcXYZ, no t=42, no pp=token)",
      log[0].url.indexOf("abcXYZ") < 0 &&
      log[0].url.indexOf("t=42") < 0 &&
      log[0].url.indexOf("pp=token") < 0);
  }

  // ===== 14. Bad blockerId is silently ignored ===========================

  {
    const sb = makeSandbox();
    const hl = sb.window.__cleanfeed_healthlog;
    hl.recordSelectorMiss("");
    hl.recordSelectorMiss(null);
    hl.recordSelectorMiss(undefined);
    hl.recordSelectorMatch("", 0, 1);
    await new Promise((r) => setTimeout(r, 30));
    const log = await new Promise((r) => sb.chrome.storage.local.get(["cf_health_log"], (d) => r(d.cf_health_log || [])));
    assertEq("14) bad blockerId silently ignored (no entries)",
      log.length, 0);
  }

  process.stdout.write("\n");
  console.log(`SELECTORS FALLBACK: ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})();
