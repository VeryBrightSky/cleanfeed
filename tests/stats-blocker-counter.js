/* CleanFeed v1.4.20-alpha (Phase 1) — per-blocker daily counter.
 *
 * Instrumentation in content/content.js:
 *   • Per-blocker WeakSet (`_perBlockerCounted` map) dedupes counted
 *     elements per blocker per page-load.
 *   • _statsIncrementBlocker writes into an in-memory delta map
 *     ({ "YYYY-MM-DD": { id: count } }).
 *   • _scheduleStatsFlush coalesces increments into a single
 *     chrome.storage.local write every 30 seconds (or on pagehide).
 *   • _flushStats merges the delta into storage.cf_stats.blocked,
 *     never clobbering existing counts.
 *
 * Tests:
 *   1. First time a blocker hides an element -> counter goes 0 -> 1.
 *   2. MutationObserver re-fires (same active set, same elements) do NOT
 *      re-count — counter stays at 1.
 *   3. A new element appearing mid-session DOES count.
 *   4. Two blockers with overlapping selectors each get credit (separate
 *      WeakSets per blocker, by design).
 *   5. Day rollover: increments after midnight land under the new date key.
 *   6. Batched flush: increments don't hit storage immediately; the
 *      coalescing timer fires once after the configured delay.
 *   7. Flush merges the delta into a fresh storage read (never clobbers
 *      existing counters written by another tab).
 *   8. Failed flush re-merges the snapshot back into the delta (no data loss).
 *
 * Run with:  node tests/stats-blocker-counter.js
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

// ----- minimal chrome.storage.local simulator (FIFO async) --------------
function makeStorage(initial) {
  const data = Object.assign({}, initial || {});
  let pendingFailNextSet = false;
  return {
    get(keys) {
      return new Promise((resolve) => {
        setTimeout(() => {
          const out = {};
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) if (k in data) out[k] = JSON.parse(JSON.stringify(data[k]));
          resolve(out);
        }, 0);
      });
    },
    set(patch) {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          if (pendingFailNextSet) {
            pendingFailNextSet = false;
            reject(new Error("simulated storage failure"));
            return;
          }
          for (const k of Object.keys(patch)) data[k] = JSON.parse(JSON.stringify(patch[k]));
          resolve();
        }, 0);
      });
    },
    _peek() { return JSON.parse(JSON.stringify(data)); },
    _failNextSet() { pendingFailNextSet = true; },
  };
}

// ----- counter helpers (mirror content/content.js) ----------------------
function makeCounter(storage, opts = {}) {
  const FLUSH_MS = opts.flushMs || 30000;
  const perBlockerCounted = new Map();   // blockerId -> WeakSet
  let delta = { blocked: {}, autoplay_avoided: { videos: 0, estimated_minutes: 0 } };
  let flushTimer = 0;
  let flushInFlight = false;
  let flushCount = 0;

  let _today = "2026-05-25";
  function setToday(s) { _today = s; }

  function hasPending() {
    if (delta.autoplay_avoided.videos > 0) return true;
    for (const day of Object.keys(delta.blocked))
      if (Object.keys(delta.blocked[day]).length > 0) return true;
    return false;
  }

  function increment(blockerId, n) {
    if (n <= 0) return;
    if (!delta.blocked[_today]) delta.blocked[_today] = {};
    delta.blocked[_today][blockerId] = (delta.blocked[_today][blockerId] || 0) + n;
    schedule();
  }

  function schedule() {
    if (flushTimer || flushInFlight) return;
    flushTimer = setTimeout(() => {
      flushTimer = 0;
      flush();
    }, FLUSH_MS);
  }

  async function flush() {
    if (flushInFlight) return;
    if (!hasPending()) return;
    flushInFlight = true;
    flushCount++;
    const snapshot = delta;
    delta = { blocked: {}, autoplay_avoided: { videos: 0, estimated_minutes: 0 } };
    try {
      const data = await storage.get(["cf_stats"]);
      const cf_stats = data.cf_stats || { blocked: {}, autoplay_avoided: {}, session_started: 1 };
      for (const day of Object.keys(snapshot.blocked)) {
        if (!cf_stats.blocked[day]) cf_stats.blocked[day] = {};
        for (const id of Object.keys(snapshot.blocked[day])) {
          cf_stats.blocked[day][id] = (cf_stats.blocked[day][id] || 0) + snapshot.blocked[day][id];
        }
      }
      await storage.set({ cf_stats });
    } catch (_) {
      // Re-merge to avoid data loss (mirrors content.js).
      for (const day of Object.keys(snapshot.blocked)) {
        if (!delta.blocked[day]) delta.blocked[day] = {};
        for (const id of Object.keys(snapshot.blocked[day])) {
          delta.blocked[day][id] = (delta.blocked[day][id] || 0) + snapshot.blocked[day][id];
        }
      }
    } finally {
      flushInFlight = false;
    }
  }

  // Mirror countBlockedElements per-blocker WeakSet logic.
  function countElements(active) {
    for (const b of active) {
      if (!perBlockerCounted.has(b.id)) perBlockerCounted.set(b.id, new WeakSet());
      const set = perBlockerCounted.get(b.id);
      let perBlockerNew = 0;
      for (const el of b.elements) {
        if (set.has(el)) continue;
        set.add(el);
        perBlockerNew++;
      }
      if (perBlockerNew > 0) increment(b.id, perBlockerNew);
    }
  }

  return { countElements, flush, schedule, increment, setToday,
           get flushCount() { return flushCount; },
           get delta() { return delta; },
           get timerArmed() { return flushTimer !== 0; } };
}

// ----- tests ------------------------------------------------------------
(async () => {

  // ===== 1. First hide on a fresh page-load increments 0 → 1 =====
  {
    const storage = makeStorage();
    const counter = makeCounter(storage, { flushMs: 5 });
    const el = { id: "card-A" };
    counter.countElements([{ id: "home-feed", elements: [el] }]);
    assertEq("1) in-memory delta records 1 hide",
      counter.delta.blocked["2026-05-25"], { "home-feed": 1 });
    await new Promise((r) => setTimeout(r, 20));
    assertEq("1) after flush, storage has 1 hide",
      storage._peek().cf_stats.blocked["2026-05-25"], { "home-feed": 1 });
  }

  // ===== 2. MutationObserver re-fires don't re-count the same element =====
  {
    const storage = makeStorage();
    const counter = makeCounter(storage, { flushMs: 5 });
    const el = { id: "card-A" };
    for (let i = 0; i < 50; i++) {
      counter.countElements([{ id: "home-feed", elements: [el] }]);
    }
    await new Promise((r) => setTimeout(r, 20));
    assertEq("2) 50 re-runs on same element = 1 count",
      storage._peek().cf_stats.blocked["2026-05-25"]["home-feed"], 1);
  }

  // ===== 3. New element mid-session DOES count =====
  {
    const storage = makeStorage();
    const counter = makeCounter(storage, { flushMs: 5 });
    // Stable references — WeakSet identity is by object, so new {} per
    // call would each count as a new element. Real DOM has stable elements.
    const a = { id: "A" }, b = { id: "B" }, c = { id: "C" };
    counter.countElements([{ id: "home-feed", elements: [a] }]);
    counter.countElements([{ id: "home-feed", elements: [a] }]);
    counter.countElements([{ id: "home-feed", elements: [a, b] }]);
    counter.countElements([{ id: "home-feed", elements: [a, b, c] }]);
    await new Promise((r) => setTimeout(r, 20));
    assertEq("3) infinite-scroll adds 3 unique elements total",
      storage._peek().cf_stats.blocked["2026-05-25"]["home-feed"], 3);
  }

  // ===== 4. Two blockers with overlapping selectors each get credit =====
  {
    const storage = makeStorage();
    const counter = makeCounter(storage, { flushMs: 5 });
    const shared = { id: "shared" };
    counter.countElements([
      { id: "A", elements: [shared, { id: "a-only" }] },
      { id: "B", elements: [shared, { id: "b-only" }] },
    ]);
    await new Promise((r) => setTimeout(r, 20));
    const day = storage._peek().cf_stats.blocked["2026-05-25"];
    assertEq("4) blocker A counts shared + a-only = 2", day["A"], 2);
    assertEq("4) blocker B counts shared + b-only = 2 (separate WeakSet)", day["B"], 2);
  }

  // ===== 5. Day rollover lands under the new date key =====
  {
    const storage = makeStorage();
    const counter = makeCounter(storage, { flushMs: 5 });
    counter.setToday("2026-05-25");
    counter.countElements([{ id: "shorts", elements: [{ id: "X" }] }]);
    await new Promise((r) => setTimeout(r, 20));
    counter.setToday("2026-05-26");
    counter.countElements([{ id: "shorts", elements: [{ id: "Y" }] }]);
    await new Promise((r) => setTimeout(r, 20));
    const peek = storage._peek().cf_stats.blocked;
    assertEq("5) day 1 has 1 hide", peek["2026-05-25"], { "shorts": 1 });
    assertEq("5) day 2 has 1 hide (separate bucket)", peek["2026-05-26"], { "shorts": 1 });
  }

  // ===== 6. Batched flush — increments don't immediately hit storage =====
  {
    const storage = makeStorage();
    const counter = makeCounter(storage, { flushMs: 100 });
    // Burst of 10 unique-element hits in rapid succession.
    for (let i = 0; i < 10; i++) {
      counter.countElements([{ id: "home-feed", elements: [{ id: "u" + i }] }]);
    }
    assertTrue("6) timer armed after first increment", counter.timerArmed);
    assertEq("6) before flush — storage untouched",
      storage._peek().cf_stats, undefined);
    assertEq("6) delta accumulated 10 hits",
      counter.delta.blocked["2026-05-25"]["home-feed"], 10);
    await new Promise((r) => setTimeout(r, 150));
    assertEq("6) after flush — single storage write committed 10 hits",
      storage._peek().cf_stats.blocked["2026-05-25"]["home-feed"], 10);
    assertEq("6) only one flush fired (coalesced)", counter.flushCount, 1);
  }

  // ===== 7. Flush merges with existing storage, never clobbers =====
  {
    // Another tab wrote pre-existing counters before this content script
    // flushes — our flush must ADD rather than overwrite.
    const storage = makeStorage({
      cf_stats: {
        blocked: { "2026-05-25": { "shorts": 100, "comments": 5 } },
        autoplay_avoided: {},
        session_started: 999,
      },
    });
    const counter = makeCounter(storage, { flushMs: 5 });
    counter.countElements([{ id: "shorts",   elements: [{ id: "x" }, { id: "y" }] }]);
    counter.countElements([{ id: "home-feed", elements: [{ id: "z" }] }]);
    await new Promise((r) => setTimeout(r, 20));
    const day = storage._peek().cf_stats.blocked["2026-05-25"];
    assertEq("7) existing shorts (100) + new (2) = 102",  day["shorts"], 102);
    assertEq("7) existing comments untouched",            day["comments"], 5);
    assertEq("7) new home-feed counter created",          day["home-feed"], 1);
    assertEq("7) session_started preserved",
      storage._peek().cf_stats.session_started, 999);
  }

  // ===== 8. Failed flush re-merges snapshot — no data loss =====
  {
    const storage = makeStorage();
    const counter = makeCounter(storage, { flushMs: 5 });
    counter.countElements([{ id: "home-feed", elements: [{ id: "A" }, { id: "B" }] }]);
    storage._failNextSet();
    await new Promise((r) => setTimeout(r, 20));
    assertEq("8) failed flush — storage still empty",
      storage._peek().cf_stats, undefined);
    // Delta has been re-merged with the snapshot we tried to flush.
    assertEq("8) delta re-populated after failure",
      counter.delta.blocked["2026-05-25"], { "home-feed": 2 });
    // Trigger a successful retry by manually scheduling.
    counter.increment("home-feed", 0);   // no-op increment to re-arm timer? Use direct schedule:
    counter.schedule();
    await new Promise((r) => setTimeout(r, 20));
    assertEq("8) retry succeeds — committed 2 hits",
      storage._peek().cf_stats.blocked["2026-05-25"]["home-feed"], 2);
  }

  process.stdout.write("\n");
  console.log(`STATS BLOCKER COUNTER: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
})();
