/* CleanFeed v1.4.24 — usage streak counter logic.
 *
 * Run with:  node tests/streak.js
 * Exits non-zero on first failed assertion.
 *
 * Exercises lib/cf-features.js updateStreak() + prevDateKey() with fixed,
 * mocked date keys (no reliance on the real clock).
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

// ---- prevDateKey ----
assertEq("prevDateKey mid-month", F.prevDateKey("2026-01-15"), "2026-01-14");
assertEq("prevDateKey month boundary", F.prevDateKey("2026-02-01"), "2026-01-31");
assertEq("prevDateKey year boundary", F.prevDateKey("2026-01-01"), "2025-12-31");
assertEq("prevDateKey leap day", F.prevDateKey("2024-03-01"), "2024-02-29");

// ---- fresh install: no prior state → streak starts at 1 ----
assertEq("fresh (null prev)", F.updateStreak(null, "2026-01-10"),
  { streakCount: 1, lastActiveDate: "2026-01-10" });
assertEq("fresh (empty obj)", F.updateStreak({}, "2026-01-10"),
  { streakCount: 1, lastActiveDate: "2026-01-10" });
assertEq("fresh (zero count, no date)", F.updateStreak({ streakCount: 0, lastActiveDate: null }, "2026-01-10"),
  { streakCount: 1, lastActiveDate: "2026-01-10" });

// ---- consecutive day: yesterday → increment ----
assertEq("yesterday → +1", F.updateStreak({ streakCount: 6, lastActiveDate: "2026-01-09" }, "2026-01-10"),
  { streakCount: 7, lastActiveDate: "2026-01-10" });
assertEq("yesterday across month boundary → +1",
  F.updateStreak({ streakCount: 3, lastActiveDate: "2026-01-31" }, "2026-02-01"),
  { streakCount: 4, lastActiveDate: "2026-02-01" });

// ---- same day: no change (idempotent across multiple flushes) ----
assertEq("same day → unchanged",
  F.updateStreak({ streakCount: 7, lastActiveDate: "2026-01-10" }, "2026-01-10"),
  { streakCount: 7, lastActiveDate: "2026-01-10" });

// ---- gap (older than yesterday) → reset to 1 ----
assertEq("2-day gap → reset",
  F.updateStreak({ streakCount: 20, lastActiveDate: "2026-01-08" }, "2026-01-10"),
  { streakCount: 1, lastActiveDate: "2026-01-10" });
assertEq("week gap → reset",
  F.updateStreak({ streakCount: 99, lastActiveDate: "2026-01-01" }, "2026-01-10"),
  { streakCount: 1, lastActiveDate: "2026-01-10" });

// ---- purity: prev object is not mutated ----
const prev = { streakCount: 4, lastActiveDate: "2026-01-09" };
F.updateStreak(prev, "2026-01-10");
assertTrue("updateStreak does not mutate prev", prev.streakCount === 4 && prev.lastActiveDate === "2026-01-09");

// ---- a realistic multi-day run ----
let s = F.updateStreak(null, "2026-01-01");           // day 1 → 1
s = F.updateStreak(s, "2026-01-01");                  // same day → 1
s = F.updateStreak(s, "2026-01-02");                  // +1 → 2
s = F.updateStreak(s, "2026-01-03");                  // +1 → 3
s = F.updateStreak(s, "2026-01-06");                  // gap → reset 1
s = F.updateStreak(s, "2026-01-07");                  // +1 → 2
assertEq("multi-day run final", s, { streakCount: 2, lastActiveDate: "2026-01-07" });

console.log(`\nSTREAK COUNTER: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
