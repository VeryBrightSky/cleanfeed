/* CleanFeed session-stats double-count (v1.4.12).
 *
 * Audit category-2 finding 2.1: countBlockedElements() ran on every
 * applyBlockers() tick (which fires ~100ms after every YT DOM mutation
 * via the MutationObserver) and ADDED the current querySelectorAll match
 * count to STATE.counts.total. Same elements were re-counted on every
 * tick, so the popup stat ballooned to 5–6 digits in minutes.
 *
 * v1.4.12 fix: track counted elements in a module-level WeakSet so each
 * unique element contributes at most once to STATE.counts.* across the
 * content-script's lifetime.
 *
 * Run with:  node tests/stats-no-double-count.js
 * Exits non-zero on first failed assertion.
 */
"use strict";

let pass = 0, fail = 0;
function assertEq(name, actual, expected) {
  if (actual === expected) { pass++; process.stdout.write("."); }
  else { fail++; console.error(`\n  FAIL ${name}\n    expected: ${expected}\n    actual:   ${actual}`); }
}

// ---- pre-v1.4.11 (buggy) — adds matches on every tick ----
function v1411_count(STATE, active) {
  let totalAdded = 0;
  for (const b of active) {
    let found = 0;
    for (const sel of b.selectors) {
      found += sel.matches.length;          // simulate querySelectorAll(sel).length
    }
    STATE.counts.perBlocker[b.id] = (STATE.counts.perBlocker[b.id] || 0) + found;
    totalAdded += found;
  }
  STATE.counts.total += totalAdded;
}

// ---- v1.4.12 fixed — WeakSet dedupe across ticks ----
function makeV1412() {
  const counted = new WeakSet();
  return function count(STATE, active) {
    let totalAdded = 0;
    for (const b of active) {
      let found = 0;
      for (const sel of b.selectors) {
        for (const el of sel.matches) {
          if (counted.has(el)) continue;
          counted.add(el);
          found++;
        }
      }
      STATE.counts.perBlocker[b.id] = (STATE.counts.perBlocker[b.id] || 0) + found;
      totalAdded += found;
    }
    STATE.counts.total += totalAdded;
  };
}

// Stable element fixture — simulate the same 10 DOM nodes matched
// repeatedly across many applyBlockers ticks.
function makeFixture(numElements) {
  const els = [];
  for (let i = 0; i < numElements; i++) els.push({ id: "el-" + i });
  return [{ id: "home-feed", selectors: [{ matches: els }] }];
}

// ===== A — v1.4.11 baseline: 100 ticks → 1000 counted (10x inflation per tick) =====
{
  const STATE = { counts: { total: 0, perBlocker: {} } };
  const active = makeFixture(10);
  for (let i = 0; i < 100; i++) v1411_count(STATE, active);
  assertEq("A) v1.4.11 — 100 ticks × 10 elements = 1000 (bug)",
           STATE.counts.total, 1000);
}

// ===== B — v1.4.12 fixed: 100 ticks → 10 counted (matches unique element count) =====
{
  const STATE = { counts: { total: 0, perBlocker: {} } };
  const count = makeV1412();
  const active = makeFixture(10);
  for (let i = 0; i < 100; i++) count(STATE, active);
  assertEq("B) v1.4.12 — 100 ticks of 10 stable elements = 10",
           STATE.counts.total, 10);
  assertEq("B) perBlocker[home-feed] = 10",
           STATE.counts.perBlocker["home-feed"], 10);
}

// ===== C — new elements appearing on a later tick DO count =====
{
  const STATE = { counts: { total: 0, perBlocker: {} } };
  const count = makeV1412();
  const active = makeFixture(5);
  count(STATE, active);                                 // 5 counted
  assertEq("C) first tick — 5 counted", STATE.counts.total, 5);
  // 3 new elements appear (e.g. infinite-scroll added new video cards)
  active[0].selectors[0].matches.push({ id: "new-1" }, { id: "new-2" }, { id: "new-3" });
  count(STATE, active);
  assertEq("C) second tick — only the 3 NEW elements counted",
           STATE.counts.total, 8);
  // 100 more ticks with no new elements
  for (let i = 0; i < 100; i++) count(STATE, active);
  assertEq("C) stable across 100 more ticks", STATE.counts.total, 8);
}

// ===== D — overlapping selectors don't double-count the same element =====
{
  const STATE = { counts: { total: 0, perBlocker: {} } };
  const count = makeV1412();
  // Two blockers whose selectors both match the same element
  const shared = { id: "shared" };
  const active = [
    { id: "A", selectors: [{ matches: [shared, { id: "a-only" }] }] },
    { id: "B", selectors: [{ matches: [shared, { id: "b-only" }] }] },
  ];
  count(STATE, active);
  assertEq("D) overlapping selectors — shared element counted once",
           STATE.counts.total, 3);
}

process.stdout.write("\n");
console.log(`STATS NO DOUBLE-COUNT: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
