/* CleanFeed v1.4.24 — Focus Schedule matching logic.
 *
 * Run with:  node tests/focus-schedule.js
 * Exits non-zero on first failed assertion.
 *
 * Exercises lib/cf-features.js: day-of-week matching, midnight crossover,
 * window-end computation, multiple overlapping schedules, and next-window.
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

// Day numbers: 0=Sun, 1=Mon ... 6=Sat
const MON = 1, TUE = 2, WED = 3, THU = 4, FRI = 5, SAT = 6, SUN = 0;

// ---- parseHM ----
assertEq("parseHM 09:00", F.parseHM("09:00"), 540);
assertEq("parseHM 17:30", F.parseHM("17:30"), 1050);
assertEq("parseHM 00:00", F.parseHM("00:00"), 0);
assertEq("parseHM bad", F.parseHM("9am"), null);
assertEq("parseHM out-of-range", F.parseHM("24:00"), null);

// ---- normal same-day window: Work hours Mon–Fri 09:00–17:00 ----
const work = { id: "work", enabled: true, days: [MON, TUE, WED, THU, FRI], startTime: "09:00", endTime: "17:00" };
assertTrue("work active Mon 09:00 (start inclusive)", F.scheduleActiveAt(work, MON, 9 * 60));
assertTrue("work active Mon 12:30", F.scheduleActiveAt(work, MON, 12 * 60 + 30));
assertTrue("work active Fri 16:59", F.scheduleActiveAt(work, FRI, 16 * 60 + 59));
assertTrue("work INACTIVE Mon 17:00 (end exclusive)", !F.scheduleActiveAt(work, MON, 17 * 60));
assertTrue("work INACTIVE Mon 08:59", !F.scheduleActiveAt(work, MON, 8 * 60 + 59));
assertTrue("work INACTIVE Sat 12:00 (not a scheduled day)", !F.scheduleActiveAt(work, SAT, 12 * 60));
assertTrue("work INACTIVE Sun 12:00", !F.scheduleActiveAt(work, SUN, 12 * 60));

// ---- disabled entry never matches ----
const workOff = Object.assign({}, work, { enabled: false });
assertTrue("disabled schedule never active", !F.scheduleActiveAt(workOff, MON, 12 * 60));

// ---- midnight crossover: Night owl Mon 22:00 → 06:00 ----
const night = { id: "night", enabled: true, days: [MON], startTime: "22:00", endTime: "06:00" };
assertTrue("night active Mon 22:00 (evening slice start)", F.scheduleActiveAt(night, MON, 22 * 60));
assertTrue("night active Mon 23:30", F.scheduleActiveAt(night, MON, 23 * 60 + 30));
assertTrue("night active Tue 02:00 (morning slice belongs to Mon)", F.scheduleActiveAt(night, TUE, 2 * 60));
assertTrue("night active Tue 05:59", F.scheduleActiveAt(night, TUE, 5 * 60 + 59));
assertTrue("night INACTIVE Tue 06:00 (end exclusive)", !F.scheduleActiveAt(night, TUE, 6 * 60));
assertTrue("night INACTIVE Mon 06:00 (Mon morning is NOT in Mon-night window)", !F.scheduleActiveAt(night, MON, 6 * 60));
assertTrue("night INACTIVE Mon 12:00", !F.scheduleActiveAt(night, MON, 12 * 60));
assertTrue("night INACTIVE Wed 02:00 (Tue night not scheduled)", !F.scheduleActiveAt(night, WED, 2 * 60));

// ---- degenerate (start === end) is treated as never-active ----
const degenerate = { id: "z", enabled: true, days: [MON], startTime: "09:00", endTime: "09:00" };
assertTrue("start==end never active", !F.scheduleActiveAt(degenerate, MON, 9 * 60));

// ---- windowEndAt: same-day ----
// Wed 2026-01-07 is a Wednesday. 12:00 inside 09:00–17:00 → ends 17:00 same day.
const wed12 = new Date(2026, 0, 7, 12, 0, 0);
assertEq("windowEnd work Wed 12:00 → Wed 17:00",
  F.windowEndAt(work, wed12), new Date(2026, 0, 7, 17, 0, 0).getTime());
// Not active → null
assertEq("windowEnd work Sat → null", F.windowEndAt(work, new Date(2026, 0, 10, 12, 0, 0)), null);

// ---- windowEndAt: crossover, both slices end at the SAME instant ----
// Mon 2026-01-05 23:00 (evening) → ends Tue 06:00
const mon23 = new Date(2026, 0, 5, 23, 0, 0);
assertEq("windowEnd night Mon 23:00 → Tue 06:00",
  F.windowEndAt(night, mon23), new Date(2026, 0, 6, 6, 0, 0).getTime());
// Tue 2026-01-06 02:00 (morning slice) → ends Tue 06:00 (same instant)
const tue02 = new Date(2026, 0, 6, 2, 0, 0);
assertEq("windowEnd night Tue 02:00 → Tue 06:00",
  F.windowEndAt(night, tue02), new Date(2026, 0, 6, 6, 0, 0).getTime());

// ---- findActiveSchedule: multiple overlapping → first match wins ----
const fs = { enabled: true, schedules: [
  { id: "a", enabled: true, days: [WED], startTime: "08:00", endTime: "10:00" },
  { id: "b", enabled: true, days: [WED], startTime: "09:00", endTime: "12:00" }, // overlaps a at 09:00–10:00
] };
const hit = F.findActiveSchedule(fs, new Date(2026, 0, 7, 9, 30, 0)); // Wed 09:30 overlaps both
assertTrue("overlap → returns first matching schedule (a)", hit && hit.schedule.id === "a");
assertEq("overlap winner endsAt → a ends 10:00",
  hit && hit.endsAt, new Date(2026, 0, 7, 10, 0, 0).getTime());
const miss = F.findActiveSchedule(fs, new Date(2026, 0, 7, 7, 0, 0)); // Wed 07:00 before both
assertEq("no active schedule → null", miss, null);

// A disabled entry is skipped even if its window matches.
const fs2 = { enabled: true, schedules: [
  { id: "off", enabled: false, days: [WED], startTime: "08:00", endTime: "18:00" },
  { id: "on",  enabled: true,  days: [WED], startTime: "09:00", endTime: "12:00" },
] };
const hit2 = F.findActiveSchedule(fs2, new Date(2026, 0, 7, 10, 0, 0));
assertTrue("disabled entry skipped, enabled one wins", hit2 && hit2.schedule.id === "on");

// ---- findNextWindow ----
// From Wed 2026-01-07 07:00, next work (Mon–Fri 9–17) start is today 09:00.
const next1 = F.findNextWindow({ enabled: true, schedules: [work] }, new Date(2026, 0, 7, 7, 0, 0));
assertEq("next window today 09:00", next1 && next1.startsAt, new Date(2026, 0, 7, 9, 0, 0).getTime());
// From Wed 18:00 (after today's window) → next is Thu 09:00.
const next2 = F.findNextWindow({ enabled: true, schedules: [work] }, new Date(2026, 0, 7, 18, 0, 0));
assertEq("next window tomorrow (Thu) 09:00", next2 && next2.startsAt, new Date(2026, 0, 8, 9, 0, 0).getTime());
// From Sat 12:00 → next work day is Mon 09:00 (2026-01-12).
const next3 = F.findNextWindow({ enabled: true, schedules: [work] }, new Date(2026, 0, 10, 12, 0, 0));
assertEq("next window after weekend → Mon 09:00", next3 && next3.startsAt, new Date(2026, 0, 12, 9, 0, 0).getTime());
// Earliest across two schedules wins.
const next4 = F.findNextWindow({ enabled: true, schedules: [
  { id: "late", enabled: true, days: [WED], startTime: "15:00", endTime: "16:00" },
  { id: "early", enabled: true, days: [WED], startTime: "10:00", endTime: "11:00" },
] }, new Date(2026, 0, 7, 7, 0, 0));
assertTrue("earliest of two upcoming windows wins (early 10:00)", next4 && next4.schedule.id === "early");

console.log(`\nFOCUS SCHEDULE: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
