/* CleanFeed v1.4.24 — today's-stats summary (date-bucket filtering).
 *
 * Run with:  node tests/today-stats.js
 * Exits non-zero on first failed assertion.
 *
 * Exercises lib/cf-features.js summarizeToday() + totalToday() against
 * cf_stats-shaped data: per-blocker daily buckets, top-N ordering, label
 * mapping, zero-count filtering, and the empty / missing-day cases.
 */
"use strict";

const F = require("../lib/cf-features.js");

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

// cf_stats fixture: blocked[day][blockerId] = count
const cf_stats = {
  blocked: {
    "2026-01-10": { "shorts": 47, "watch-sidebar": 23, "thumbnails": 12, "comments": 4, "home-feed": 0 },
    "2026-01-09": { "shorts": 5 },
  },
  autoplay_avoided: {},
  session_started: 0,
};

const today = cf_stats.blocked["2026-01-10"];

// ---- totalToday: sums all counts, ignores zero ----
assertEq("totalToday sums today", F.totalToday(today), 47 + 23 + 12 + 4);
assertEq("totalToday empty obj", F.totalToday({}), 0);
assertEq("totalToday missing day (undefined)", F.totalToday(cf_stats.blocked["2026-01-11"]), 0);

// ---- summarizeToday: top-3 by count desc, mapped to short labels ----
const top = F.summarizeToday(today, 3, F.SHORT_LABELS);
assertEq("summarize top-3 today", top, [
  { id: "shorts", count: 47, label: "Shorts" },
  { id: "watch-sidebar", count: 23, label: "recs" },
  { id: "thumbnails", count: 12, label: "thumbnails" },
]);

// The rendered one-liner the popup builds from this:
const line = "Today: " + top.map((t) => `${t.count} ${t.label}`).join(" · ") + " hidden";
assertEq("rendered widget line", line, "Today: 47 Shorts · 23 recs · 12 thumbnails hidden");

// ---- zero counts are excluded (home-feed:0 must not appear) ----
assertTrue("zero-count blocker excluded", !top.some((t) => t.id === "home-feed"));

// ---- topN larger than data returns all non-zero, sorted ----
assertEq("topN=10 returns all 4 non-zero", F.summarizeToday(today, 10, F.SHORT_LABELS).length, 4);

// ---- empty / missing day → [] (caller shows the empty-state copy) ----
assertEq("summarize empty day", F.summarizeToday({}, 3, F.SHORT_LABELS), []);
assertEq("summarize undefined day", F.summarizeToday(undefined, 3, F.SHORT_LABELS), []);
assertEq("summarize all-zero day", F.summarizeToday({ "shorts": 0, "comments": 0 }, 3, F.SHORT_LABELS), []);

// ---- unknown blocker id falls back to the raw id as label ----
assertEq("unknown id → raw label",
  F.summarizeToday({ "mystery-blocker": 9 }, 3, F.SHORT_LABELS),
  [{ id: "mystery-blocker", count: 9, label: "mystery-blocker" }]);

// ---- default label map (no map arg) still works ----
assertEq("default label map used when omitted",
  F.summarizeToday({ "shorts": 3 }, 1),
  [{ id: "shorts", count: 3, label: "Shorts" }]);

// ---- deterministic tie-break by label when counts are equal ----
assertEq("tie-break by label asc",
  F.summarizeToday({ "shorts": 5, "comments": 5 }, 2, F.SHORT_LABELS),
  [{ id: "shorts", count: 5, label: "Shorts" }, { id: "comments", count: 5, label: "comments" }]);

console.log(`\nTODAY STATS: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
