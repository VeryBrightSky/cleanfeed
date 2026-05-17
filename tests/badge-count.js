/* CleanFeed badge active-blocker count (v1.4.11).
 *
 * Reproduces the v1.4.10 bug: background.js:350's FREE_IDS subset was
 * stale at ["home-feed", "shorts"] only. v1.4.0 added two more free-tier
 * blockers (merch-shelf, breaking-news) but the badge counter wasn't
 * updated, so a free user enabling those would see badge "" instead of
 * the actual active count.
 *
 * v1.4.11 fix: FREE_IDS now lists all 4 canonical free-tier ids.
 *
 * Run with:  node tests/badge-count.js
 * Exits non-zero on first failed assertion.
 */
"use strict";

// Mirror of the v1.4.11 background.js:345-356 count logic. Keep in sync.
function computeBadgeCount(settings, paid) {
  const ids = Object.keys(settings).filter((id) => settings[id]);
  let count = ids.length;
  if (!paid) {
    const FREE_IDS = ["home-feed", "shorts", "merch-shelf", "breaking-news"];
    count = ids.filter((id) => FREE_IDS.includes(id)).length;
    count = Math.min(count, 2);
  }
  return count;
}

let pass = 0, fail = 0;
function assertEq(name, actual, expected) {
  if (actual === expected) { pass++; process.stdout.write("."); }
  else { fail++; console.error(`\n  FAIL ${name}\n    expected: ${expected}\n    actual:   ${actual}`); }
}

// ---- Pro user ----
assertEq("Pro: nothing active → 0",
  computeBadgeCount({}, true), 0);
assertEq("Pro: 5 active → 5",
  computeBadgeCount({
    "home-feed": true, "shorts": true, "comments": true,
    "autoplay": true, "thumbnails": true,
  }, true), 5);
assertEq("Pro: all 14 active → 14",
  computeBadgeCount({
    "home-feed": true, "shorts": true, "watch-sidebar": true,
    "end-screen": true, "comments": true, "explore": true,
    "live-chat": true, "autoplay": true, "thumbnails": true,
    "subs-algo": true, "playables": true, "merch-shelf": true,
    "breaking-news": true, "mixes-playlists": true,
  }, true), 14);

// ---- Free user, original v1.0 free blockers ----
assertEq("Free: home-feed only → 1",
  computeBadgeCount({ "home-feed": true }, false), 1);
assertEq("Free: home-feed + shorts → 2",
  computeBadgeCount({ "home-feed": true, "shorts": true }, false), 2);

// ---- Free user, v1.4.0 free blockers (the bug fix) ----
assertEq("Free: merch-shelf only → 1 (was 0 pre-v1.4.11)",
  computeBadgeCount({ "merch-shelf": true }, false), 1);
assertEq("Free: breaking-news only → 1 (was 0 pre-v1.4.11)",
  computeBadgeCount({ "breaking-news": true }, false), 1);
assertEq("Free: merch-shelf + breaking-news → 2 (was 0 pre-v1.4.11)",
  computeBadgeCount({ "merch-shelf": true, "breaking-news": true }, false), 2);

// ---- Free user, mixed free + pro in storage (license downgrade case) ----
// Pro blockers in storage are ignored for free badge count.
assertEq("Free: home-feed (free) + comments (pro) → 1",
  computeBadgeCount({ "home-feed": true, "comments": true }, false), 1);
assertEq("Free: all 14 active but free tier → capped at 2",
  computeBadgeCount({
    "home-feed": true, "shorts": true, "watch-sidebar": true,
    "comments": true, "merch-shelf": true, "breaking-news": true,
    "mixes-playlists": true,
  }, false), 2);

// ---- Free user cap: 4 free blockers active but FREE_LIMIT=2 caps it ----
assertEq("Free: 4 free active → cap at 2",
  computeBadgeCount({
    "home-feed": true, "shorts": true,
    "merch-shelf": true, "breaking-news": true,
  }, false), 2);

// ---- Free user, only pro blockers active → 0 ----
assertEq("Free: only pro blockers active → 0",
  computeBadgeCount({ "comments": true, "autoplay": true }, false), 0);

process.stdout.write("\n");
console.log(`BADGE COUNT: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
