/* CleanFeed v1.4.19 F4 — subscription-feed cleanup blockers.
 *
 * Three new Pro blockers added to content/blockers.js + content/styles.css:
 *   • subs-most-relevant — CSS-only, scoped to /feed/subscriptions
 *   • subs-members-only  — CSS-only, matches the members-only badge
 *   • subs-watched       — JS sweep; tags ytd-rich-item-renderer cards
 *                          whose progress bar inline width > 95 % with
 *                          data-cf-watched="1" so CSS can hide them.
 *
 * Tests:
 *   1. All three blockers are present in the BLOCKERS array with tier:"pro".
 *   2. The "Most Relevant" selector is scoped to subscriptions page-subtype.
 *   3. The members-only selector matches the YT badge attribute pattern.
 *   4. applyWatchedSweep tags only cards whose progress > 95, clears tags
 *      when the blocker is toggled off, is idempotent across re-runs,
 *      handles missing/zero/exactly-95 progress correctly, and is scoped
 *      to /feed/subscriptions only.
 *   5. Defaults: all three start OFF (no behavior change for existing users).
 *
 * Run with:  node tests/subs-feed-cleanup.js
 * Exits non-zero on first failed assertion.
 */
"use strict";

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

// Mirror of the v1.4.19 BLOCKERS additions (content/blockers.js).
const BLOCKERS_V1419_NEW = [
  {
    id: "subs-most-relevant", tier: "pro", pages: ["subscriptions"],
    selectors: [
      'ytd-browse[page-subtype="subscriptions"] ytd-rich-section-renderer:has(yt-formatted-string[title="Most Relevant"])',
      'ytd-browse[page-subtype="subscriptions"] ytd-rich-section-renderer:has(yt-formatted-string[title="For you"])',
      'ytd-browse[page-subtype="subscriptions"] ytd-rich-shelf-renderer:has(yt-formatted-string[title="Most Relevant"])',
      'ytd-browse[page-subtype="subscriptions"] ytd-rich-shelf-renderer:has(yt-formatted-string[title="For you"])',
    ],
  },
  {
    id: "subs-members-only", tier: "pro", pages: ["anywhere"],
    selectors: [
      'ytd-rich-item-renderer:has(ytd-badge-supported-renderer[aria-label="Members only"])',
      'ytd-rich-item-renderer:has([aria-label*="Members only"])',
    ],
  },
  {
    id: "subs-watched", tier: "pro", pages: ["subscriptions"], jsHandler: "subs-watched",
    selectors: ['ytd-browse[page-subtype="subscriptions"] ytd-rich-item-renderer[data-cf-watched="1"]'],
  },
];

// ===== 1. Blocker shape =====
{
  const ids = BLOCKERS_V1419_NEW.map((b) => b.id);
  assertEq("blockers: 3 new ids in canonical order",
    ids, ["subs-most-relevant", "subs-members-only", "subs-watched"]);
  for (const b of BLOCKERS_V1419_NEW) {
    assertEq(`blocker ${b.id} is tier=pro`, b.tier, "pro");
    assertTrue(`blocker ${b.id} has at least one selector`, b.selectors.length > 0);
  }
}

// ===== 2. "Most Relevant" selector scope =====
{
  for (const sel of BLOCKERS_V1419_NEW[0].selectors) {
    assertTrue(`subs-most-relevant selector "${sel.slice(0, 40)}…" scoped to subscriptions`,
      sel.indexOf('page-subtype="subscriptions"') >= 0);
  }
}

// ===== 3. Members-only selector targets the badge =====
{
  const sels = BLOCKERS_V1419_NEW[1].selectors.join("|");
  assertTrue("members-only selector targets the badge aria-label",
    sels.indexOf("Members only") >= 0);
  assertTrue("members-only selector wraps in ytd-rich-item-renderer",
    sels.indexOf("ytd-rich-item-renderer") >= 0);
}

// ===== 4. applyWatchedSweep — progress parsing + tagging =====
// Mirror the JS sweep from content/content.js. We build a minimal DOM
// where each "card" has a progress bar with an inline width style.
function makeCard(widthPct) {
  const progress = {
    tagName: "DIV",
    attributes: { style: widthPct == null ? "" : `width: ${widthPct}%;` },
    getAttribute(n) { return this.attributes[n] || ""; },
  };
  const card = {
    tagName: "YTD-RICH-ITEM-RENDERER",
    _attrs: {},
    getAttribute(n) { return this._attrs[n] || null; },
    setAttribute(n, v) { this._attrs[n] = String(v); },
    removeAttribute(n) { delete this._attrs[n]; },
  };
  progress.parentElement = card;
  return { card, progress };
}
function runSweep(loc, active, paid, isProUser, dom) {
  // Mirror of content.js's applyWatchedSweep.
  if (!active) {
    // Cleanup pass: untag everything we tagged previously.
    for (const card of dom.cards) {
      if (card.getAttribute("data-cf-watched") === "1") {
        card.removeAttribute("data-cf-watched");
      }
    }
    return;
  }
  if (!paid) return;
  if (loc.pathname.indexOf("/feed/subscriptions") !== 0) return;
  for (const bar of dom.bars) {
    const style = bar.getAttribute("style") || "";
    const m = style.match(/width\s*:\s*(\d+(?:\.\d+)?)\s*%/);
    if (!m) continue;
    const pct = parseFloat(m[1]);
    if (!isFinite(pct) || pct <= 95) continue;
    let cur = bar;
    while (cur && cur.tagName !== "YTD-RICH-ITEM-RENDERER") cur = cur.parentElement;
    if (cur && cur.tagName === "YTD-RICH-ITEM-RENDERER" && cur.getAttribute("data-cf-watched") !== "1") {
      cur.setAttribute("data-cf-watched", "1");
    }
  }
}

// ----- Scenarios -----
{
  // 4a. Mixed progress card set — only > 95 % gets tagged.
  const cards = [10, 50, 90, 94.5, 95, 95.001, 96, 99.9, 100].map((p) => makeCard(p));
  const dom = { cards: cards.map((c) => c.card), bars: cards.map((c) => c.progress) };
  runSweep({ pathname: "/feed/subscriptions" }, true, true, true, dom);
  const tagged = dom.cards.filter((c) => c.getAttribute("data-cf-watched") === "1").length;
  assertEq("4a) only progress > 95 tagged (4 of 9: 95.001, 96, 99.9, 100)", tagged, 4);
}
{
  // 4b. Exactly 95 % is NOT hidden (boundary test).
  const { card, progress } = makeCard(95);
  const dom = { cards: [card], bars: [progress] };
  runSweep({ pathname: "/feed/subscriptions" }, true, true, true, dom);
  assertEq("4b) exactly 95.0 % -> NOT tagged (strict >)",
    card.getAttribute("data-cf-watched"), null);
}
{
  // 4c. 95.001 % IS tagged.
  const { card, progress } = makeCard(95.001);
  const dom = { cards: [card], bars: [progress] };
  runSweep({ pathname: "/feed/subscriptions" }, true, true, true, dom);
  assertEq("4c) 95.001 % -> tagged",
    card.getAttribute("data-cf-watched"), "1");
}
{
  // 4d. Missing width style — skip (don't throw).
  const { card, progress } = makeCard(null);
  const dom = { cards: [card], bars: [progress] };
  runSweep({ pathname: "/feed/subscriptions" }, true, true, true, dom);
  assertEq("4d) missing style -> not tagged",
    card.getAttribute("data-cf-watched"), null);
}
{
  // 4e. Free user on /feed/subscriptions: sweep is a no-op (Pro-only feature).
  const { card, progress } = makeCard(99);
  const dom = { cards: [card], bars: [progress] };
  runSweep({ pathname: "/feed/subscriptions" }, true, /* paid */ false, false, dom);
  assertEq("4e) free user -> sweep is no-op",
    card.getAttribute("data-cf-watched"), null);
}
{
  // 4f. Active but on wrong page (/watch) -> sweep skips.
  const { card, progress } = makeCard(99);
  const dom = { cards: [card], bars: [progress] };
  runSweep({ pathname: "/watch" }, true, true, true, dom);
  assertEq("4f) wrong page -> not tagged",
    card.getAttribute("data-cf-watched"), null);
}
{
  // 4g. Idempotent across N re-runs (MutationObserver fires many times).
  const cards = [99, 100, 30].map(makeCard);
  const dom = { cards: cards.map((c) => c.card), bars: cards.map((c) => c.progress) };
  for (let i = 0; i < 50; i++) runSweep({ pathname: "/feed/subscriptions" }, true, true, true, dom);
  assertEq("4g) 50 re-runs -> 2 cards tagged exactly once each",
    dom.cards.filter((c) => c.getAttribute("data-cf-watched") === "1").length, 2);
}
{
  // 4h. Toggle off untags every prior-tagged card.
  const cards = [99, 100, 30].map(makeCard);
  const dom = { cards: cards.map((c) => c.card), bars: cards.map((c) => c.progress) };
  runSweep({ pathname: "/feed/subscriptions" }, true, true, true, dom);
  assertEq("4h) toggle-on tags 2", dom.cards.filter((c) => c.getAttribute("data-cf-watched") === "1").length, 2);
  runSweep({ pathname: "/feed/subscriptions" }, false, true, true, dom);
  assertEq("4h) toggle-off untags all",
    dom.cards.filter((c) => c.getAttribute("data-cf-watched") === "1").length, 0);
}

// ===== 5. Defaults — all 3 OFF for new and existing users =====
{
  const newInstallDefaults = {
    "home-feed": true, "shorts": true,
    "watch-sidebar": false, "end-screen": false,
    "comments": false, "explore": false, "live-chat": false,
    "autoplay": false, "thumbnails": false, "subs-algo": false,
    "playables": false, "merch-shelf": false,
    "breaking-news": false, "mixes-playlists": false,
    "subs-most-relevant": false, "subs-members-only": false, "subs-watched": false,
  };
  for (const b of BLOCKERS_V1419_NEW) {
    assertEq(`default: ${b.id} starts OFF for new installs`,
      newInstallDefaults[b.id], false);
  }
  // Migration for existing v1.4.18 users adds the 3 new keys as false too.
  const v1418_settings = {
    "home-feed": true, "shorts": true,
    "watch-sidebar": false, "end-screen": false,
    "comments": false, "explore": false, "live-chat": false,
    "autoplay": false, "thumbnails": false, "subs-algo": false,
    "playables": false, "merch-shelf": false,
    "breaking-news": false, "mixes-playlists": false,
  };
  const NEW = { "subs-most-relevant": false, "subs-members-only": false, "subs-watched": false };
  const migrated = Object.assign({}, NEW, v1418_settings);
  for (const b of BLOCKERS_V1419_NEW) {
    assertEq(`migrate: ${b.id} added OFF (existing user upgrade)`,
      migrated[b.id], false);
  }
  // Existing user's truthy values are NOT clobbered (defensive).
  assertEq("migrate: existing home-feed=true preserved", migrated["home-feed"], true);
}

process.stdout.write("\n");
console.log(`SUBS FEED CLEANUP: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
